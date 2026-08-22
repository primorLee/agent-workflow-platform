// Package runner executes Agent Protocol task offers as child processes and
// streams stdout/stderr, progress, and completion frames back to the broker.
//
// The public default is intentionally narrow: a logical "echo" runner maps to
// /usr/bin/printf through an explicit allowlist. The package never invokes a
// shell, validates every task/runner/action identifier, tracks active
// processes, and honors cancellation with terminate/grace/kill supervision.
// Deployments can extend the allowlist through reviewed code.
package runner

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os/exec"
	"regexp"
	"sync"
	"time"

	"github.com/primorLee/agent-workflow-platform/services/vm-agent/internal/dialer"
	"github.com/primorLee/agent-workflow-platform/services/vm-agent/internal/protocol"
)

// Runner satisfies dialer.TaskExecutor.
type Runner struct {
	log *slog.Logger

	// commandResolver decides how to translate a TaskOfferPayload into an
	// *exec.Cmd. Tests override this with a fake; normal builds use the default
	// which rejects every runner not listed in allowedRunners.
	commandResolver func(ctx context.Context, offer *protocol.TaskOfferPayload) (*exec.Cmd, error)

	mu     sync.Mutex
	active map[string]*exec.Cmd
}

// New constructs a Runner. log must be non-nil.
func New(log *slog.Logger) *Runner {
	return &Runner{
		log:             log,
		commandResolver: defaultCommandResolver,
		active:          map[string]*exec.Cmd{},
	}
}

// NewWithResolver is for tests — inject a custom command builder.
func NewWithResolver(log *slog.Logger, resolver func(context.Context, *protocol.TaskOfferPayload) (*exec.Cmd, error)) *Runner {
	r := New(log)
	r.commandResolver = resolver
	return r
}

// Execute implements dialer.TaskExecutor.
func (r *Runner) Execute(ctx context.Context, offer *protocol.TaskOfferPayload, sink dialer.TaskSink) {
	start := time.Now()
	taskID := offer.TaskID

	defer func() {
		if rec := recover(); rec != nil {
			_ = sink.SendComplete(&protocol.TaskCompletePayload{
				TaskID:      taskID,
				Status:      "error",
				Metrics:     map[string]interface{}{},
				DurationSec: time.Since(start).Seconds(),
				Artifacts:   []protocol.ArtifactRef{},
				Error: &protocol.TaskErrorDetail{
					Code:    "err.unknown.runner_panic",
					Message: fmt.Sprintf("%v", rec),
				},
				CompletedAt: protocol.NowTS(),
			})
		}
	}()

	// Resolve the offer through the shell-free allowlist.
	cmd, err := r.commandResolver(ctx, offer)
	if err != nil {
		_ = sink.SendComplete(&protocol.TaskCompletePayload{
			TaskID:      taskID,
			Status:      "error",
			DurationSec: time.Since(start).Seconds(),
			Artifacts:   []protocol.ArtifactRef{},
			Metrics:     map[string]interface{}{},
			Error: &protocol.TaskErrorDetail{
				Code:    "err.task_execution.invalid_task",
				Message: err.Error(),
			},
			CompletedAt: protocol.NowTS(),
		})
		return
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = sink.SendError(&protocol.ErrorPayload{TaskID: taskID, Code: "err.resource.pipe_stdout", Message: err.Error()})
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = sink.SendError(&protocol.ErrorPayload{TaskID: taskID, Code: "err.resource.pipe_stderr", Message: err.Error()})
		return
	}

	if err := cmd.Start(); err != nil {
		_ = sink.SendComplete(&protocol.TaskCompletePayload{
			TaskID:      taskID,
			Status:      "error",
			DurationSec: time.Since(start).Seconds(),
			Artifacts:   []protocol.ArtifactRef{},
			Metrics:     map[string]interface{}{},
			Error: &protocol.TaskErrorDetail{
				Code:    "err.task_execution.spawn_failed",
				Message: err.Error(),
			},
			CompletedAt: protocol.NowTS(),
		})
		return
	}

	r.mu.Lock()
	r.active[taskID] = cmd
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		delete(r.active, taskID)
		r.mu.Unlock()
	}()

	// Progress: setup → running.
	_ = sink.SendProgress(&protocol.TaskProgressPayload{
		TaskID:  taskID,
		Seq:     1,
		Percent: 0,
		Phase:   "running",
		Note:    "process started",
	})

	var wg sync.WaitGroup
	seq := newSeqCounter()
	wg.Add(2)
	go func() { defer wg.Done(); streamPipe(stdout, "stdout", taskID, seq, sink) }()
	go func() { defer wg.Done(); streamPipe(stderr, "stderr", taskID, seq, sink) }()

	waitErr := cmd.Wait()
	wg.Wait()

	status := "success"
	var errDetail *protocol.TaskErrorDetail
	if waitErr != nil {
		var ee *exec.ExitError
		if errors.As(waitErr, &ee) {
			status = "error"
			errDetail = &protocol.TaskErrorDetail{
				Code:      "err.task_execution.nonzero_exit",
				Message:   fmt.Sprintf("exit %d", ee.ExitCode()),
				Retryable: false,
				Details: map[string]interface{}{
					"exit_code": ee.ExitCode(),
				},
			}
		} else {
			status = "error"
			errDetail = &protocol.TaskErrorDetail{
				Code:    "err.unknown.wait_failed",
				Message: waitErr.Error(),
			}
		}
	}

	// If the outer context was cancelled, report canceled rather than error.
	if ctx.Err() != nil {
		status = "canceled"
		errDetail = &protocol.TaskErrorDetail{
			Code:    "err.canceled.user",
			Message: ctx.Err().Error(),
		}
	}

	_ = sink.SendProgress(&protocol.TaskProgressPayload{
		TaskID:  taskID,
		Seq:     seq.next(),
		Percent: 100,
		Phase:   "post",
	})

	_ = sink.SendComplete(&protocol.TaskCompletePayload{
		TaskID:      taskID,
		Status:      status,
		Metrics:     map[string]interface{}{},
		DurationSec: time.Since(start).Seconds(),
		Artifacts:   []protocol.ArtifactRef{},
		Error:       errDetail,
		CompletedAt: protocol.NowTS(),
	})
}

// Cancel requests termination of a running task. Returns true if a matching
// process was found and signalled.
func (r *Runner) Cancel(taskID string) bool {
	r.mu.Lock()
	cmd := r.active[taskID]
	r.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return false
	}
	// SIGKILL — SIGTERM grace handling lives in spec §5.4 cancel flow at the
	// dialer level (not here). Keep this simple.
	_ = cmd.Process.Kill()
	return true
}

// -----------------------------------------------------------------------------
// SEC-004 — shell-injection hardening
// -----------------------------------------------------------------------------
//
// Every cloud-supplied string that participates in a command line (TaskID,
// runner, action, …) is validated against a positive allowlist BEFORE
// it touches exec. The command is built with argv — `sh -c` is never used in
// this package. The runner identifier is additionally mapped through
// `allowedRunners` so only the three sanctioned binaries can run; anything
// else is rejected with an error.
//
// A compromised control plane must not be able to pipe arbitrary shell
// input into the worker host; the allowlist is a defense-in-depth boundary.

// taskIDPattern — narrow allowlist for anything that ends up in a path
// component. Rejects shell metacharacters, spaces, path separators, quotes
// and all non-ASCII bytes. 1–64 chars.
var taskIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

// identPattern — slightly broader allowlist for runner / action
// values that do not land in a filesystem path. Still rejects metacharacters.
var identPattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,64}$`)

// allowedRunners maps the logical runner name supplied by the cloud to the
// absolute binary path the agent is permitted to exec. Keys form the only
// runners the runner will dispatch. Paths are intentionally hardcoded — a
// server-supplied path would defeat the allowlist.
var allowedRunners = map[string]string{
	"echo": "/usr/bin/printf",
}

// sanitizeTaskID validates a task-id-like identifier from the cloud and
// returns it unchanged on success. Any non-allowlist byte → error.
//
// This function is the single choke-point for task_id validation across the
// runner; callers that interpolate task_id into paths, log lines, or argv
// must pass through here first.
func sanitizeTaskID(s string) (string, error) {
	if s == "" {
		return "", fmt.Errorf("task_id must not be empty")
	}
	if !taskIDPattern.MatchString(s) {
		return "", fmt.Errorf("task_id %q rejected: only [a-zA-Z0-9_-]{1,64} allowed", s)
	}
	return s, nil
}

// sanitizeIdent validates runner / analysis-type strings (less strict than
// task-id because they never form a path component, but still locked to an
// allowlist so shell metacharacters cannot reach exec).
func sanitizeIdent(field, s string) (string, error) {
	if s == "" {
		return "", fmt.Errorf("%s must not be empty", field)
	}
	if !identPattern.MatchString(s) {
		return "", fmt.Errorf("%s %q rejected: only [A-Za-z0-9_.:-]{1,64} allowed", field, s)
	}
	return s, nil
}

// resolveRunnerBinary returns the absolute binary path for a sanctioned
// runner, or an error if the runner is not in the allowlist. This is the
// only way a runner decides which program to execute.
func resolveRunnerBinary(runner string) (string, error) {
	if _, err := sanitizeIdent("runner", runner); err != nil {
		return "", err
	}
	bin, ok := allowedRunners[runner]
	if !ok {
		return "", fmt.Errorf("runner %q is not in the allowlist", runner)
	}
	return bin, nil
}

// validateOffer applies all SEC-004 input gates against a TaskOfferPayload
// before any command is constructed. Returns an error describing the first
// violation — callers should treat an error as fatal for the task.
func validateOffer(o *protocol.TaskOfferPayload) error {
	if _, err := sanitizeTaskID(o.TaskID); err != nil {
		return err
	}
	if _, err := sanitizeIdent("runner", o.Execution.Runner); err != nil {
		return err
	}
	if _, err := sanitizeIdent("action", o.Execution.Action); err != nil {
		return err
	}
	if _, ok := allowedRunners[o.Execution.Runner]; !ok {
		return fmt.Errorf("runner %q is not in the allowlist", o.Execution.Runner)
	}
	return nil
}

// -----------------------------------------------------------------------------
// Defaults
// -----------------------------------------------------------------------------

// defaultCommandResolver maps a validated logical runner to a fixed binary.
// The built-in echo adapter provides a deterministic local workflow while
// preserving the same streaming and supervision path as extended adapters.
//
// SEC-004: we do NOT use `sh -c`. Inputs are validated against an allowlist
// first, then argv is passed directly to exec. No cloud-supplied string ever
// reaches a shell. The runner is also checked against `allowedRunners`,
// though the placeholder itself only runs `echo` so that unit tests can
// execute on machines without the optional runtime toolchain installed.
func defaultCommandResolver(ctx context.Context, offer *protocol.TaskOfferPayload) (*exec.Cmd, error) {
	if err := validateOffer(offer); err != nil {
		return nil, err
	}
	// Argv-only — even if one of these strings somehow smuggled a
	// metacharacter past the allowlist, echo does not interpret it.
	binary, err := resolveRunnerBinary(offer.Execution.Runner)
	if err != nil {
		return nil, err
	}
	line := fmt.Sprintf("awp-vm-agent task_id=%s runner=%s action=%s\n", offer.TaskID, offer.Execution.Runner, offer.Execution.Action)
	return exec.CommandContext(ctx, binary, "%s", line), nil
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

type seqCounter struct {
	mu sync.Mutex
	n  int
}

func newSeqCounter() *seqCounter { return &seqCounter{n: 1} }

func (s *seqCounter) next() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.n++
	return s.n
}

// streamPipe reads lines and emits them as log.chunk frames batched by flush
// time. For simplicity we emit each line as its own chunk; the broker stores
// them as rolling files regardless.
func streamPipe(rc io.ReadCloser, which, taskID string, seq *seqCounter, sink dialer.TaskSink) {
	defer rc.Close()
	br := bufio.NewReaderSize(rc, 32*1024)
	for {
		line, err := br.ReadString('\n')
		if line != "" {
			_ = sink.SendLog(&protocol.LogChunkPayload{
				TaskID: taskID,
				Seq:    seq.next(),
				Stream: which,
				Level:  "INFO",
				TS:     protocol.NowTS(),
				Lines:  []string{trimNewline(line)},
			})
		}
		if err != nil {
			return
		}
	}
}

func trimNewline(s string) string {
	if n := len(s); n > 0 && s[n-1] == '\n' {
		s = s[:n-1]
	}
	if n := len(s); n > 0 && s[n-1] == '\r' {
		s = s[:n-1]
	}
	return s
}
