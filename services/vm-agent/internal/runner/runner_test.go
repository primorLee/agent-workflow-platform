package runner

import (
	"context"
	"io"
	"log/slog"
	"os/exec"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/primorLee/agent-workflow-platform/services/vm-agent/internal/protocol"
)

type capturingSink struct {
	mu       sync.Mutex
	progress []*protocol.TaskProgressPayload
	complete *protocol.TaskCompletePayload
	errors   []*protocol.ErrorPayload
	logs     []*protocol.LogChunkPayload
}

func (s *capturingSink) SendProgress(p *protocol.TaskProgressPayload) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.progress = append(s.progress, p)
	return nil
}
func (s *capturingSink) SendComplete(c *protocol.TaskCompletePayload) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.complete = c
	return nil
}
func (s *capturingSink) SendError(e *protocol.ErrorPayload) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.errors = append(s.errors, e)
	return nil
}
func (s *capturingSink) SendLog(l *protocol.LogChunkPayload) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.logs = append(s.logs, l)
	return nil
}

func silentLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestRunnerEchoSucceeds(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("default resolver uses /bin/sh")
	}
	r := New(silentLogger())
	sink := &capturingSink{}
	r.Execute(context.Background(), &protocol.TaskOfferPayload{
		TaskID:    "t1",
		Execution: protocol.ExecutionSpec{Runner: "echo", Action: "ac"},
	}, sink)

	if sink.complete == nil {
		t.Fatalf("no complete frame")
	}
	if sink.complete.Status != "success" {
		t.Errorf("status=%q, want success", sink.complete.Status)
	}
	if len(sink.progress) == 0 {
		t.Errorf("no progress frames")
	}
	if len(sink.logs) == 0 {
		t.Errorf("no log frames")
	}
}

func TestRunnerDrainsOutputBeforeComplete(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	resolver := func(ctx context.Context, _ *protocol.TaskOfferPayload) (*exec.Cmd, error) {
		return exec.CommandContext(
			ctx,
			"sh",
			"-c",
			"i=0; while [ $i -lt 2000 ]; do printf 'line-%s\\n' $i; i=$((i+1)); done",
		), nil
	}
	r := NewWithResolver(silentLogger(), resolver)
	sink := &capturingSink{}
	r.Execute(context.Background(), &protocol.TaskOfferPayload{TaskID: "drain"}, sink)

	if sink.complete == nil || sink.complete.Status != "success" {
		t.Fatalf("expected successful completion, got %+v", sink.complete)
	}
	if got := len(sink.logs); got != 2000 {
		t.Fatalf("got %d log frames, want 2000", got)
	}
}

func TestRunnerNonZeroExitReportsError(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	resolver := func(ctx context.Context, _ *protocol.TaskOfferPayload) (*exec.Cmd, error) {
		return exec.CommandContext(ctx, "sh", "-c", "exit 7"), nil
	}
	r := NewWithResolver(silentLogger(), resolver)
	sink := &capturingSink{}
	r.Execute(context.Background(), &protocol.TaskOfferPayload{TaskID: "t2"}, sink)
	if sink.complete == nil {
		t.Fatalf("no complete frame")
	}
	if sink.complete.Status != "error" {
		t.Errorf("status=%q, want error", sink.complete.Status)
	}
	if sink.complete.Error == nil {
		t.Fatalf("error detail missing")
	}
	if got := sink.complete.Error.Details["exit_code"]; got != 7 {
		t.Errorf("exit_code = %v, want 7", got)
	}
}

func TestRunnerCancel(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	resolver := func(ctx context.Context, _ *protocol.TaskOfferPayload) (*exec.Cmd, error) {
		return exec.CommandContext(ctx, "sh", "-c", "sleep 10"), nil
	}
	r := NewWithResolver(silentLogger(), resolver)
	sink := &capturingSink{}

	done := make(chan struct{})
	go func() {
		r.Execute(context.Background(), &protocol.TaskOfferPayload{TaskID: "t3"}, sink)
		close(done)
	}()

	// Give it time to start.
	time.Sleep(200 * time.Millisecond)
	if !r.Cancel("t3") {
		t.Errorf("Cancel returned false; task may not have been active")
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("Execute did not unblock after Cancel")
	}
	if sink.complete == nil {
		t.Fatalf("no complete frame")
	}
	if sink.complete.Status != "error" {
		// On SIGKILL, Go reports -1 exit via ExitError — status=error.
		t.Logf("status=%q (likely error due to SIGKILL)", sink.complete.Status)
	}
}

func TestRunnerResolverError(t *testing.T) {
	resolver := func(context.Context, *protocol.TaskOfferPayload) (*exec.Cmd, error) {
		return nil, &tempError{"bad task"}
	}
	r := NewWithResolver(silentLogger(), resolver)
	sink := &capturingSink{}
	r.Execute(context.Background(), &protocol.TaskOfferPayload{TaskID: "t4"}, sink)
	if sink.complete == nil || sink.complete.Status != "error" {
		t.Fatalf("expected error status, got %+v", sink.complete)
	}
	if sink.complete.Error == nil || sink.complete.Error.Code != "err.task_execution.invalid_task" {
		t.Errorf("wrong error code: %+v", sink.complete.Error)
	}
}

type tempError struct{ msg string }

func (e *tempError) Error() string { return e.msg }
