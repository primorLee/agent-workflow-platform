// Package dialer owns the outbound WebSocket connection to the control-plane
// broker. It implements Agent Protocol v1 end to end: connection, handshake,
// authentication, heartbeat, task offers, cancellation, progress, and
// reconnect with bounded backoff.
//
// The worker initiates every connection, so managed hosts need no inbound
// listener. Flow-control and version-gate state are exposed to the runner and
// replay packages through narrow interfaces.
package dialer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	cryptorand "crypto/rand"

	"github.com/primorLee/agent-workflow-platform/services/vm-agent/internal/config"
	"github.com/primorLee/agent-workflow-platform/services/vm-agent/internal/protocol"
	agentulid "github.com/primorLee/agent-workflow-platform/services/vm-agent/internal/ulid"
	"nhooyr.io/websocket"
)

// ExitCodeUpgradeRequired is the spec-mandated systemd-stop exit code (§4.5,
// §9). systemd unit MUST have RestartPreventExitStatus=77.
const ExitCodeUpgradeRequired = 77

// MaxAuthFailures — after this many consecutive auth rejections the dialer
// surfaces a terminal error (spec §12.2).
const MaxAuthFailures = 3

// AgentVersion is overridden by main.go via a setter so the version string
// stays a single source of truth (main's -ldflags var).
var (
	agentVersionMu sync.RWMutex
	agentVersion   = "0.1.0-alpha.0"
)

// SetAgentVersion lets main.go hand us the -ldflags-stamped version string.
func SetAgentVersion(v string) {
	agentVersionMu.Lock()
	defer agentVersionMu.Unlock()
	if v != "" {
		agentVersion = v
	}
}

func getAgentVersion() string {
	agentVersionMu.RLock()
	defer agentVersionMu.RUnlock()
	return agentVersion
}

// State represents the dialer's connection state.
type State int32

const (
	StateDisconnected State = iota
	StateDialing
	StateHandshake
	StateAuthenticating
	StateAuthenticated
	StateRunning
	StateDraining
	StateStopped
)

func (s State) String() string {
	switch s {
	case StateDisconnected:
		return "disconnected"
	case StateDialing:
		return "dialing"
	case StateHandshake:
		return "handshake"
	case StateAuthenticating:
		return "authenticating"
	case StateAuthenticated:
		return "authenticated"
	case StateRunning:
		return "running"
	case StateDraining:
		return "draining"
	case StateStopped:
		return "stopped"
	default:
		return "unknown"
	}
}

// KickFn is how the dialer notifies the watchdog it is alive.
type KickFn func()

// TaskExecutor decouples the dialer from the concrete runner package so tests
// can inject a fake. The real implementation lives in internal/runner.
type TaskExecutor interface {
	// Execute runs a single task and uses sink to publish progress/complete
	// frames. Must return only after the child has fully exited.
	Execute(ctx context.Context, offer *protocol.TaskOfferPayload, sink TaskSink)
	// Cancel requests termination of a running task. Returns true if the
	// task was found and a signal was sent.
	Cancel(taskID string) bool
}

// TaskSink is what the executor calls to publish frames. The dialer provides
// the implementation so the executor stays transport-agnostic.
type TaskSink interface {
	SendProgress(p *protocol.TaskProgressPayload) error
	SendComplete(c *protocol.TaskCompletePayload) error
	SendError(e *protocol.ErrorPayload) error
	SendLog(l *protocol.LogChunkPayload) error
}

// Dialer is the long-lived WSS client.
type Dialer struct {
	cfg  *config.Config
	log  *slog.Logger
	kick KickFn

	// exec may be nil during early boot / tests that don't care about tasks.
	exec TaskExecutor

	// exitCode is read by main() after Run() returns. Default 0. Set to
	// ExitCodeUpgradeRequired when welcome.required_agent_version > ours.
	exitCode atomic.Int32

	state     atomic.Int32
	mu        sync.Mutex
	conn      *websocket.Conn
	sessionID string
	closed    atomic.Bool
	authFails atomic.Int32
	startTime time.Time

	// write serialisation — nhooyr/websocket requires only one concurrent
	// writer at a time.
	writeMu sync.Mutex

	// running tasks — task_id → cancel fn.
	tasksMu sync.Mutex
	tasks   map[string]context.CancelFunc

	// flow — broker-signalled flow-control state (flow.pause / flow.resume).
	// Zero-value = not paused. See flowcontrol.go.
	flow flowCtl
}

// New constructs a Dialer. kick may be nil for tests.
func New(cfg *config.Config, log *slog.Logger, kick KickFn) *Dialer {
	d := &Dialer{
		cfg:       cfg,
		log:       log,
		kick:      kick,
		startTime: time.Now(),
		tasks:     map[string]context.CancelFunc{},
	}
	if d.kick == nil {
		d.kick = func() {}
	}
	d.state.Store(int32(StateDisconnected))
	return d
}

// SetExecutor installs the task executor. Must be called before Run() if tasks
// should actually run; leave nil for tests that only exercise handshake.
func (d *Dialer) SetExecutor(e TaskExecutor) { d.exec = e }

// State returns the current connection state (thread-safe).
func (d *Dialer) State() State { return State(d.state.Load()) }

// ExitCode returns the recommended process exit code. 0 normally,
// ExitCodeUpgradeRequired (77) when the broker rejected us for being too old.
func (d *Dialer) ExitCode() int { return int(d.exitCode.Load()) }

func (d *Dialer) setState(s State) {
	prev := State(d.state.Swap(int32(s)))
	if prev != s {
		d.log.Info("state transition", "from", prev.String(), "to", s.String())
	}
}

// Run blocks until ctx is cancelled or a terminal error (e.g. upgrade_required)
// is encountered. Transient failures trigger exponential backoff reconnect.
func (d *Dialer) Run(ctx context.Context) error {
	defer d.setState(StateStopped)
	backoff := newBackoff(1*time.Second, 60*time.Second)

	for {
		if ctx.Err() != nil {
			return nil
		}
		if d.closed.Load() {
			return nil
		}

		err := d.sessionOnce(ctx)
		if err == nil || errors.Is(err, context.Canceled) {
			return nil
		}

		// Terminal: upgrade required. main() should exit with code 77.
		if errors.Is(err, errUpgradeRequired) {
			d.exitCode.Store(int32(ExitCodeUpgradeRequired))
			return err
		}

		// Terminal: persistent auth failure.
		if d.authFails.Load() >= MaxAuthFailures {
			d.log.Error("giving up after persistent auth failures", "attempts", d.authFails.Load())
			d.exitCode.Store(int32(ExitCodeUpgradeRequired)) // systemd-stop per §12.2
			return err
		}

		d.log.Warn("session ended", "err", err)
		wait := backoff.next()
		d.log.Info("reconnecting", "after", wait.String())
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(wait):
		}
	}
}

// Shutdown politely closes: control.shutdown + bye, drain running tasks up to
// ctx deadline.
func (d *Dialer) Shutdown(ctx context.Context) error {
	if !d.closed.CompareAndSwap(false, true) {
		return nil
	}
	d.setState(StateDraining)

	d.mu.Lock()
	c := d.conn
	d.mu.Unlock()

	if c != nil {
		// Best-effort: send bye, then close. Errors ignored — we're leaving.
		_ = d.sendFrame(ctx, c, protocol.TypeBye, &protocol.ByePayload{Reason: "agent_shutdown"})
	}

	// Wait for running tasks to complete (runner has its own ctx).
	done := make(chan struct{})
	go func() {
		for {
			d.tasksMu.Lock()
			n := len(d.tasks)
			d.tasksMu.Unlock()
			if n == 0 {
				close(done)
				return
			}
			time.Sleep(200 * time.Millisecond)
		}
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}

	if c != nil {
		_ = c.Close(websocket.StatusNormalClosure, "agent shutdown")
	}
	return nil
}

// -----------------------------------------------------------------------------
// sessionOnce — one connect → handshake → auth → pump cycle
// -----------------------------------------------------------------------------

var errUpgradeRequired = errors.New("upgrade_required")

func (d *Dialer) sessionOnce(ctx context.Context) error {
	d.setState(StateDialing)

	u, err := url.Parse(d.cfg.ServerURL)
	if err != nil {
		return fmt.Errorf("bad server_url: %w", err)
	}
	if u.Scheme != "wss" && u.Scheme != "ws" {
		return fmt.Errorf("server_url scheme must be wss:// or ws://, got %q", u.Scheme)
	}

	hdr := http.Header{}
	hdr.Set("Authorization", "Bearer "+d.cfg.APIKey)
	hdr.Set("X-AWP-Agent-Name", d.cfg.AgentName)
	hdr.Set("User-Agent", "awp-vm-agent/"+getAgentVersion())

	dialCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	conn, resp, err := websocket.Dial(dialCtx, d.cfg.ServerURL, &websocket.DialOptions{
		HTTPHeader: hdr,
	})
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		return fmt.Errorf("dial %s (http=%d): %w", d.cfg.ServerURL, status, err)
	}
	// Spec §2.3 — 16 MiB hard cap.
	conn.SetReadLimit(16 << 20)

	d.mu.Lock()
	d.conn = conn
	d.mu.Unlock()

	defer func() {
		_ = conn.Close(websocket.StatusGoingAway, "session end")
		d.mu.Lock()
		d.conn = nil
		d.sessionID = ""
		d.mu.Unlock()
		d.setState(StateDisconnected)
	}()

	d.setState(StateHandshake)
	welcome, err := d.doHelloWelcome(ctx, conn)
	if err != nil {
		return fmt.Errorf("handshake: %w", err)
	}
	// Spec §9 — required_agent_version check.
	if cmp, ok := compareSemver(getAgentVersion(), welcome.RequiredAgentVersion); ok && cmp < 0 {
		d.log.Error("agent version below required minimum",
			"our", getAgentVersion(),
			"required", welcome.RequiredAgentVersion,
		)
		return errUpgradeRequired
	}
	d.mu.Lock()
	d.sessionID = welcome.SessionID
	d.mu.Unlock()

	d.setState(StateAuthenticating)
	if err := d.doAuth(ctx, conn); err != nil {
		d.authFails.Add(1)
		return fmt.Errorf("auth: %w", err)
	}
	d.authFails.Store(0)
	d.setState(StateAuthenticated)

	d.setState(StateRunning)
	// Apply heartbeat interval from welcome.
	hbInterval := time.Duration(welcome.HeartbeatIntervalSec) * time.Second
	if hbInterval <= 0 {
		hbInterval = d.cfg.HeartbeatInterval
	}
	if hbInterval <= 0 {
		hbInterval = 30 * time.Second
	}
	return d.pump(ctx, conn, hbInterval, welcome.FeatureFlags.MaxConcurrentTasks)
}

// -----------------------------------------------------------------------------
// Handshake
// -----------------------------------------------------------------------------

func (d *Dialer) doHelloWelcome(ctx context.Context, c *websocket.Conn) (*protocol.WelcomePayload, error) {
	// Build hello payload from the host environment.
	hp := buildHello(d.cfg, d.startTime)
	if err := d.sendFrame(ctx, c, protocol.TypeHello, hp); err != nil {
		return nil, fmt.Errorf("send hello: %w", err)
	}

	readCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	env, err := d.readEnvelope(readCtx, c)
	if err != nil {
		return nil, fmt.Errorf("read welcome: %w", err)
	}

	// Broker may send control.upgrade_required immediately if we're too old.
	if env.Type == protocol.TypeControlUpgradeRequired {
		var p protocol.ControlUpgradeRequiredPayload
		_ = env.Decode(&p)
		d.log.Error("broker requires upgrade",
			"minimum", p.MinimumVersion,
			"latest", p.LatestVersion,
			"our", getAgentVersion(),
		)
		// Ack so the broker knows we got it, then return terminal error.
		_ = d.sendFrame(ctx, c, protocol.TypeAck, &protocol.AckPayload{ForID: env.ID})
		return nil, errUpgradeRequired
	}

	if env.Type != protocol.TypeWelcome {
		return nil, fmt.Errorf("expected %q, got %q", protocol.TypeWelcome, env.Type)
	}
	var w protocol.WelcomePayload
	if err := env.Decode(&w); err != nil {
		return nil, fmt.Errorf("decode welcome payload: %w", err)
	}
	d.log.Info("welcomed by broker",
		"server_version", w.ServerVersion,
		"session_id", w.SessionID,
		"required_agent_version", w.RequiredAgentVersion,
	)
	return &w, nil
}

// -----------------------------------------------------------------------------
// Auth
// -----------------------------------------------------------------------------

func (d *Dialer) doAuth(ctx context.Context, c *websocket.Conn) error {
	loginID := agentulid.New()
	login := &protocol.AuthLoginPayload{
		Method:     "agent_token",
		AgentToken: d.cfg.APIKey,
		AgentID:    d.cfg.AgentName, // for preflight; broker assigns canonical agent_id via /register
	}
	if err := d.sendFrameWithID(ctx, c, loginID, protocol.TypeAuthLogin, login); err != nil {
		return fmt.Errorf("send auth.login: %w", err)
	}

	readCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	env, err := d.readEnvelope(readCtx, c)
	if err != nil {
		return fmt.Errorf("read auth response: %w", err)
	}

	if env.Type.IsError() {
		var ep protocol.ErrorPayload
		_ = env.Decode(&ep)
		return fmt.Errorf("auth rejected: %s: %s", ep.Code, ep.Message)
	}
	if env.Type != protocol.TypeAuthSession {
		return fmt.Errorf("expected %q, got %q", protocol.TypeAuthSession, env.Type)
	}
	var s protocol.AuthSessionPayload
	if err := env.Decode(&s); err != nil {
		return fmt.Errorf("decode auth.session: %w", err)
	}
	d.log.Info("authenticated",
		"tenant_id", s.TenantID,
		"agent_id", s.AgentID,
		"scopes", s.Scopes,
		"not_after", s.NotAfter,
	)
	return nil
}

// -----------------------------------------------------------------------------
// pump — heartbeat + reader
// -----------------------------------------------------------------------------

func (d *Dialer) pump(ctx context.Context, c *websocket.Conn, hbInterval time.Duration, _ int) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	errCh := make(chan error, 2)

	go func() {
		defer func() {
			if r := recover(); r != nil {
				errCh <- fmt.Errorf("heartbeat panic: %v", r)
			}
		}()
		errCh <- d.heartbeatLoop(ctx, c, hbInterval)
	}()

	go func() {
		defer func() {
			if r := recover(); r != nil {
				errCh <- fmt.Errorf("reader panic: %v", r)
			}
		}()
		errCh <- d.readerLoop(ctx, c)
	}()

	return <-errCh
}

func (d *Dialer) heartbeatLoop(ctx context.Context, c *websocket.Conn, interval time.Duration) error {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			hp := d.buildHeartbeat()
			if err := d.sendFrame(ctx, c, protocol.TypeHeartbeat, hp); err != nil {
				return fmt.Errorf("heartbeat send: %w", err)
			}
			d.kick()
		}
	}
}

func (d *Dialer) readerLoop(ctx context.Context, c *websocket.Conn) error {
	for {
		env, err := d.readEnvelope(ctx, c)
		if err != nil {
			return err
		}
		d.kick()

		switch env.Type {
		case protocol.TypeTaskOffer:
			d.handleTaskOffer(ctx, c, env)

		case protocol.TypeTaskCancel:
			var p protocol.TaskCancelPayload
			if err := env.Decode(&p); err != nil {
				d.log.Warn("bad task.cancel payload", "err", err)
				continue
			}
			d.log.Info("task.cancel received", "task_id", p.TaskID, "reason", p.Reason)
			if d.exec != nil {
				d.exec.Cancel(p.TaskID)
			}

		case protocol.TypePing:
			// Reply with pong carrying in_reply_to.
			pong := &protocol.Envelope{
				V:         protocol.ProtocolVersion,
				Type:      protocol.TypePong,
				ID:        agentulid.New(),
				InReplyTo: env.ID,
				TS:        protocol.NowTS(),
				Payload:   json.RawMessage(`{}`),
			}
			if err := d.writeEnvelope(ctx, c, pong); err != nil {
				return fmt.Errorf("pong send: %w", err)
			}

		case protocol.TypeAck:
			// Broker ack of our earlier frame. Nothing to do beyond tracing.
			d.log.Debug("ack received", "in_reply_to", env.InReplyTo)

		case protocol.TypeControlUpgradeRequired:
			return errUpgradeRequired

		case protocol.TypeControlShutdown:
			return errors.New("broker requested shutdown")

		case protocol.TypeFlowPause, protocol.TypeFlowResume:
			// Broker-side backpressure. Only the flow-control state
			// changes — no outbound reply, no side-effect on in-flight
			// tasks. The replayer and any future dispatcher consult
			// FlowReady() before issuing new work or queue drains.
			d.HandleFlowFrame(string(env.Type), env.Payload, d.log)

		default:
			if env.Type.IsError() {
				var ep protocol.ErrorPayload
				_ = env.Decode(&ep)
				d.log.Warn("error frame from broker",
					"code", ep.Code,
					"message", ep.Message,
					"retryable", ep.Retryable,
				)
				continue
			}
			d.log.Debug("unhandled frame", "type", string(env.Type))
		}
	}
}

// -----------------------------------------------------------------------------
// Task offer handling
// -----------------------------------------------------------------------------

// handleTaskOffer implements spec §5.3: ack within 1s, then accept (or reject),
// then run via the executor, then complete.
func (d *Dialer) handleTaskOffer(ctx context.Context, c *websocket.Conn, env *protocol.Envelope) {
	var offer protocol.TaskOfferPayload
	if err := env.Decode(&offer); err != nil {
		d.log.Warn("bad task.offer payload", "err", err)
		_ = d.sendFrame(ctx, c, protocol.Type("err.protocol.bad_envelope"), &protocol.ErrorPayload{
			Code:    "err.protocol.bad_envelope",
			Message: err.Error(),
		})
		return
	}

	// 1. Ack the offer ID so the broker knows we got it (spec happy-path).
	_ = d.sendFrame(ctx, c, protocol.TypeAck, &protocol.AckPayload{ForID: env.ID})

	// 2. Reject if we can't run it.
	if d.exec == nil {
		_ = d.sendFrame(ctx, c, protocol.TypeTaskReject, &protocol.TaskRejectPayload{
			TaskID: offer.TaskID,
			Reason: "unhealthy",
			Detail: "no executor installed",
		})
		return
	}

	// 3. Accept.
	if err := d.sendFrame(ctx, c, protocol.TypeTaskAccept, &protocol.TaskAcceptPayload{
		TaskID:     offer.TaskID,
		AcceptedAt: protocol.NowTS(),
	}); err != nil {
		d.log.Warn("send task.accept failed", "err", err)
		return
	}

	// 4. Run. Each task gets its own cancellable ctx so task.cancel works.
	taskCtx, cancelTask := context.WithCancel(ctx)
	if offer.TimeoutSec > 0 {
		var tcancel context.CancelFunc
		taskCtx, tcancel = context.WithTimeout(taskCtx, time.Duration(offer.TimeoutSec)*time.Second)
		// Wrap so we cancel both if the outer is cancelled.
		origCancel := cancelTask
		cancelTask = func() { tcancel(); origCancel() }
	}
	d.tasksMu.Lock()
	d.tasks[offer.TaskID] = cancelTask
	d.tasksMu.Unlock()

	go func() {
		defer func() {
			d.tasksMu.Lock()
			delete(d.tasks, offer.TaskID)
			d.tasksMu.Unlock()
			cancelTask()
		}()
		sink := &connSink{d: d, ctx: ctx, conn: c}
		d.exec.Execute(taskCtx, &offer, sink)
	}()
}

// connSink implements TaskSink by sending frames over the current connection.
type connSink struct {
	d    *Dialer
	ctx  context.Context
	conn *websocket.Conn
}

func (s *connSink) SendProgress(p *protocol.TaskProgressPayload) error {
	return s.d.sendFrame(s.ctx, s.conn, protocol.TypeTaskProgress, p)
}
func (s *connSink) SendComplete(c *protocol.TaskCompletePayload) error {
	return s.d.sendFrame(s.ctx, s.conn, protocol.TypeTaskComplete, c)
}
func (s *connSink) SendError(e *protocol.ErrorPayload) error {
	// Type must mirror e.Code per spec §8. Fallback if caller forgot to set it.
	t := protocol.Type(e.Code)
	if t == "" {
		t = protocol.TypeError
	}
	return s.d.sendFrame(s.ctx, s.conn, t, e)
}
func (s *connSink) SendLog(l *protocol.LogChunkPayload) error {
	return s.d.sendFrame(s.ctx, s.conn, protocol.TypeLogChunk, l)
}

// -----------------------------------------------------------------------------
// Framing helpers
// -----------------------------------------------------------------------------

func (d *Dialer) sendFrame(ctx context.Context, c *websocket.Conn, t protocol.Type, payload any) error {
	return d.sendFrameWithID(ctx, c, agentulid.New(), t, payload)
}

func (d *Dialer) sendFrameWithID(ctx context.Context, c *websocket.Conn, id string, t protocol.Type, payload any) error {
	env, err := protocol.NewEnvelope(id, t, payload)
	if err != nil {
		return err
	}
	return d.writeEnvelope(ctx, c, env)
}

func (d *Dialer) writeEnvelope(ctx context.Context, c *websocket.Conn, env *protocol.Envelope) error {
	b, err := protocol.MarshalEnvelope(env)
	if err != nil {
		return err
	}
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	return c.Write(ctx, websocket.MessageText, b)
}

func (d *Dialer) readEnvelope(ctx context.Context, c *websocket.Conn) (*protocol.Envelope, error) {
	_, raw, err := c.Read(ctx)
	if err != nil {
		return nil, err
	}
	return protocol.UnmarshalEnvelope(raw)
}

// -----------------------------------------------------------------------------
// Host introspection for hello / heartbeat
// -----------------------------------------------------------------------------

func buildHello(cfg *config.Config, startTime time.Time) *protocol.HelloPayload {
	distro, distroID, distroVersion := readOSRelease()
	kernel := readKernel()
	mem := readMemTotalKB()
	cpuModel, cores, threads := readCPUInfo()

	arch := runtime.GOARCH
	if arch == "amd64" {
		arch = "x86_64"
	} else if arch == "arm64" {
		arch = "aarch64"
	}

	return &protocol.HelloPayload{
		AgentID:            cfg.AgentName,
		AgentVersion:       getAgentVersion(),
		ProtocolVersions:   []int{protocol.ProtocolVersion},
		MinProtocolVersion: protocol.ProtocolVersion,
		Distro:             distro,
		DistroID:           distroID,
		DistroVersion:      distroVersion,
		Kernel:             kernel,
		Arch:               arch,
		CPU: protocol.CPUInfo{
			Model:   cpuModel,
			Cores:   cores,
			Threads: threads,
		},
		MemKB:          mem,
		RuntimeVersion: detectRuntimeVersion(),
		RunnerVersion:  "", // filled by probe in a future task
		RuntimeList:    []string{},
		Features:       []string{"echo"},
		Timezone:       detectTimezone(),
		BootID:         readBootID(),
		StartTime:      float64(startTime.Unix()),
	}
}

func (d *Dialer) buildHeartbeat() *protocol.HeartbeatPayload {
	ids := d.runningTaskIDs()
	maxC := d.cfg.MaxConcurrentTasks
	if maxC <= 0 {
		maxC = 2
	}
	free := maxC - len(ids)
	if free < 0 {
		free = 0
	}
	return &protocol.HeartbeatPayload{
		RunningTaskIDs: ids,
		Load: protocol.LoadInfo{
			CPUPct:        0, // TODO: sample /proc/stat delta in a later task
			MemUsedKB:     0,
			MemTotalKB:    readMemTotalKB(),
			DiskFreeKB:    readDiskFreeKB(d.cfg.WorkDir),
			TaskSlotsFree: free,
		},
		DrainRequested: d.State() == StateDraining,
		UptimeSec:      time.Since(d.startTime).Seconds(),
	}
}

func (d *Dialer) runningTaskIDs() []string {
	d.tasksMu.Lock()
	defer d.tasksMu.Unlock()
	out := make([]string, 0, len(d.tasks))
	for id := range d.tasks {
		out = append(out, id)
	}
	return out
}

// -----------------------------------------------------------------------------
// /proc, /etc/os-release sniffing. All best-effort; missing files return
// zero-values per the spec ("" or 0), never errors.
// -----------------------------------------------------------------------------

func readOSRelease() (pretty, id, version string) {
	pretty, id, version = "linux", "linux", "0"
	raw, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(raw), "\n") {
		switch {
		case strings.HasPrefix(line, "PRETTY_NAME="):
			pretty = trimOSValue(line[len("PRETTY_NAME="):])
		case strings.HasPrefix(line, "ID="):
			id = trimOSValue(line[len("ID="):])
		case strings.HasPrefix(line, "VERSION_ID="):
			version = trimOSValue(line[len("VERSION_ID="):])
		}
	}
	return
}

func trimOSValue(s string) string {
	s = strings.TrimSpace(s)
	s = strings.Trim(s, `"`)
	return s
}

func readMemTotalKB() int64 {
	raw, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(line, "MemTotal:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				if n, err := strconv.ParseInt(fields[1], 10, 64); err == nil {
					return n
				}
			}
		}
	}
	return 0
}

func readCPUInfo() (model string, cores, threads int) {
	raw, err := os.ReadFile("/proc/cpuinfo")
	if err != nil {
		return "", 0, 0
	}
	seenCore := map[string]struct{}{}
	for _, line := range strings.Split(string(raw), "\n") {
		switch {
		case strings.HasPrefix(line, "model name"):
			if i := strings.Index(line, ":"); i > 0 && model == "" {
				model = strings.TrimSpace(line[i+1:])
			}
		case strings.HasPrefix(line, "core id"):
			if i := strings.Index(line, ":"); i > 0 {
				seenCore[strings.TrimSpace(line[i+1:])] = struct{}{}
			}
		case strings.HasPrefix(line, "processor"):
			threads++
		}
	}
	cores = len(seenCore)
	if cores == 0 {
		cores = threads
	}
	return
}

func readBootID() string {
	raw, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		// Fallback: crypto-random pseudo boot id.
		var buf [16]byte
		_, _ = cryptorand.Read(buf[:])
		return fmt.Sprintf("%x", buf)
	}
	return strings.TrimSpace(string(raw))
}

func detectTimezone() string {
	if tz := os.Getenv("TZ"); tz != "" {
		return tz
	}
	// /etc/timezone on Debian/Ubuntu.
	if raw, err := os.ReadFile("/etc/timezone"); err == nil {
		return strings.TrimSpace(string(raw))
	}
	return time.Now().Location().String()
}

func detectRuntimeVersion() string {
	if v := os.Getenv("AWP_AGENT_RUNTIME_VERSION"); v != "" {
		return v
	}
	return ""
}

// -----------------------------------------------------------------------------
// backoff with full jitter
// -----------------------------------------------------------------------------

type backoff struct {
	cur, min, max time.Duration
}

func newBackoff(min, max time.Duration) *backoff { return &backoff{min: min, max: max, cur: min} }

func (b *backoff) next() time.Duration {
	d := b.cur
	jittered := d
	if n, err := cryptorand.Int(cryptorand.Reader, big.NewInt(int64(d))); err == nil {
		jittered = time.Duration(n.Int64())
	}
	b.cur *= 2
	if b.cur > b.max {
		b.cur = b.max
	}
	if jittered < b.min {
		jittered = b.min
	}
	return jittered
}

// -----------------------------------------------------------------------------
// Semver compare (minimal, digits.digits.digits with optional build).
// Returns (-1, 0, +1, true) on success; (0, false) when either side is unparseable.
// -----------------------------------------------------------------------------

func compareSemver(a, b string) (int, bool) {
	pa, okA := parseSemver(a)
	pb, okB := parseSemver(b)
	if !okA || !okB {
		return 0, false
	}
	for i := 0; i < 3; i++ {
		if pa[i] < pb[i] {
			return -1, true
		}
		if pa[i] > pb[i] {
			return 1, true
		}
	}
	return 0, true
}

func parseSemver(s string) ([3]int, bool) {
	// Drop build suffix ("+...") and pre-release ("-...") for comparison purposes.
	if i := strings.IndexAny(s, "+-"); i >= 0 {
		s = s[:i]
	}
	parts := strings.Split(s, ".")
	var out [3]int
	if len(parts) < 1 || len(parts) > 3 {
		return out, false
	}
	for i, p := range parts {
		if i >= 3 {
			break
		}
		n, err := strconv.Atoi(p)
		if err != nil {
			return out, false
		}
		out[i] = n
	}
	return out, true
}
