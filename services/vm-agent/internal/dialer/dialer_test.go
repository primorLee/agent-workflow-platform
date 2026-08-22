package dialer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/primorLee/agent-workflow-platform/services/vm-agent/internal/config"
	"github.com/primorLee/agent-workflow-platform/services/vm-agent/internal/protocol"
	agentulid "github.com/primorLee/agent-workflow-platform/services/vm-agent/internal/ulid"
	"nhooyr.io/websocket"
)

// -----------------------------------------------------------------------------
// Mock broker — a httptest server that speaks Agent Protocol v1.
// Each test scripts its own expectations.
// -----------------------------------------------------------------------------

type brokerScript func(ctx context.Context, t *testing.T, c *websocket.Conn) error

func newMockBroker(t *testing.T, script brokerScript) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			InsecureSkipVerify: true,
		})
		if err != nil {
			t.Logf("mock accept: %v", err)
			return
		}
		defer c.Close(websocket.StatusNormalClosure, "test done")

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		if err := script(ctx, t, c); err != nil && !errors.Is(err, context.Canceled) && !isWSClose(err) {
			t.Logf("script err: %v", err)
		}
	}))
	t.Cleanup(func() { srv.Close() })
	return srv
}

func isWSClose(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.EOF) {
		return true
	}
	var ce websocket.CloseError
	return errors.As(err, &ce)
}

func readFrame(ctx context.Context, c *websocket.Conn) (*protocol.Envelope, error) {
	_, raw, err := c.Read(ctx)
	if err != nil {
		return nil, err
	}
	return protocol.UnmarshalEnvelope(raw)
}

func writeFrame(ctx context.Context, c *websocket.Conn, t protocol.Type, inReplyTo string, payload any) error {
	env, err := protocol.NewEnvelope(agentulid.New(), t, payload)
	if err != nil {
		return err
	}
	if inReplyTo != "" {
		env.InReplyTo = inReplyTo
	}
	b, err := protocol.MarshalEnvelope(env)
	if err != nil {
		return err
	}
	return c.Write(ctx, websocket.MessageText, b)
}

func wsURL(httpURL string) string {
	return "ws" + strings.TrimPrefix(httpURL, "http")
}

func mkCfg(serverURL string) *config.Config {
	return &config.Config{
		ServerURL:          serverURL,
		APIKey:             "test-token",
		AgentName:          "test-agent",
		WorkDir:            ".",
		LogLevel:           "debug",
		MaxConcurrentTasks: 2,
		HeartbeatInterval:  500 * time.Millisecond,
		ShutdownTimeout:    time.Second,
	}
}

func mkLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

// -----------------------------------------------------------------------------
// Test 1: basic hello/welcome/auth succeeds and dialer reaches Running state.
// -----------------------------------------------------------------------------

func TestHandshakeHappyPath(t *testing.T) {
	var gotHello, gotLogin atomic.Bool
	srv := newMockBroker(t, func(ctx context.Context, t *testing.T, c *websocket.Conn) error {
		// 1. Expect hello.
		env, err := readFrame(ctx, c)
		if err != nil {
			return err
		}
		if env.Type != protocol.TypeHello {
			return fmt.Errorf("expected hello, got %q", env.Type)
		}
		gotHello.Store(true)

		// Validate hello payload has required fields.
		var hp protocol.HelloPayload
		if err := env.Decode(&hp); err != nil {
			return err
		}
		if hp.AgentID == "" || hp.AgentVersion == "" {
			return fmt.Errorf("hello missing agent_id/version: %+v", hp)
		}

		// 2. Reply welcome.
		if err := writeFrame(ctx, c, protocol.TypeWelcome, env.ID, &protocol.WelcomePayload{
			ServerVersion:        "mock 0.1",
			ProtocolVersion:      1,
			MinProtocolVersion:   1,
			RequiredAgentVersion: "0.0.1",
			SessionID:            "sess_test",
			SessionTTLSec:        3600,
			FeatureFlags: protocol.FeatureFlags{
				MaxConcurrentTasks: 2,
				Transport:          []string{"wss"},
			},
			HeartbeatIntervalSec: 1,
			HeartbeatGraceSec:    3,
			ClockSkewMaxSec:      300,
		}); err != nil {
			return err
		}

		// 3. Expect auth.login.
		env, err = readFrame(ctx, c)
		if err != nil {
			return err
		}
		if env.Type != protocol.TypeAuthLogin {
			return fmt.Errorf("expected auth.login, got %q", env.Type)
		}
		var lp protocol.AuthLoginPayload
		if err := env.Decode(&lp); err != nil {
			return err
		}
		if lp.AgentToken != "test-token" {
			return fmt.Errorf("bad token: %q", lp.AgentToken)
		}
		gotLogin.Store(true)

		// 4. Reply auth.session.
		if err := writeFrame(ctx, c, protocol.TypeAuthSession, env.ID, &protocol.AuthSessionPayload{
			BearerToken:  "sb_x",
			RefreshToken: "sr_x",
			NotAfter:     float64(time.Now().Add(15 * time.Minute).Unix()),
			TenantID:     "tenant_test",
			AgentID:      "agt_test",
			Scopes:       []string{"task.run"},
		}); err != nil {
			return err
		}

		// 5. Sit idle until the dialer's ctx is cancelled.
		<-ctx.Done()
		return nil
	})

	cfg := mkCfg(wsURL(srv.URL))
	d := New(cfg, mkLogger(), nil)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); _ = d.Run(ctx) }()

	// Poll for StateRunning.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if d.State() == StateRunning {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	if d.State() != StateRunning {
		t.Fatalf("dialer never reached Running; state=%s", d.State())
	}
	if !gotHello.Load() {
		t.Errorf("broker did not see hello")
	}
	if !gotLogin.Load() {
		t.Errorf("broker did not see auth.login")
	}

	cancel()
	wg.Wait()
}

// -----------------------------------------------------------------------------
// Test 2: welcome.required_agent_version > ours → dialer exits with code 77.
// -----------------------------------------------------------------------------

func TestUpgradeRequiredExits77(t *testing.T) {
	// Isolate this test's SetAgentVersion mutation from others.
	prev := getAgentVersion()
	defer SetAgentVersion(prev)

	srv := newMockBroker(t, func(ctx context.Context, t *testing.T, c *websocket.Conn) error {
		hello, err := readFrame(ctx, c)
		if err != nil {
			return err
		}
		return writeFrame(ctx, c, protocol.TypeWelcome, hello.ID, &protocol.WelcomePayload{
			ServerVersion:        "mock 0.1",
			ProtocolVersion:      1,
			MinProtocolVersion:   1,
			RequiredAgentVersion: "99.0.0",
			SessionID:            "sess_test",
			HeartbeatIntervalSec: 30,
			HeartbeatGraceSec:    90,
		})
	})

	SetAgentVersion("1.0.0")
	cfg := mkCfg(wsURL(srv.URL))
	d := New(cfg, mkLogger(), nil)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	err := d.Run(ctx)
	if err == nil {
		t.Fatalf("expected terminal error, got nil")
	}
	if d.ExitCode() != ExitCodeUpgradeRequired {
		t.Fatalf("exit_code = %d, want %d", d.ExitCode(), ExitCodeUpgradeRequired)
	}
}

// -----------------------------------------------------------------------------
// Test 3: auth failure surfaces error and increments fail counter to cap.
// -----------------------------------------------------------------------------

func TestAuthFailureRetriesThenGivesUp(t *testing.T) {
	prev := getAgentVersion()
	defer SetAgentVersion(prev)

	srv := newMockBroker(t, func(ctx context.Context, t *testing.T, c *websocket.Conn) error {
		hello, err := readFrame(ctx, c)
		if err != nil {
			return err
		}
		if err := writeFrame(ctx, c, protocol.TypeWelcome, hello.ID, &protocol.WelcomePayload{
			ServerVersion:        "mock",
			ProtocolVersion:      1,
			MinProtocolVersion:   1,
			RequiredAgentVersion: "0.0.1",
			SessionID:            "sess_bad_auth",
			HeartbeatIntervalSec: 30,
			HeartbeatGraceSec:    90,
		}); err != nil {
			return err
		}
		login, err := readFrame(ctx, c)
		if err != nil {
			return err
		}
		// Respond with an err.auth.* frame.
		errEnv, _ := protocol.NewEnvelope(agentulid.New(), "err.auth.invalid_credentials", &protocol.ErrorPayload{
			Code: "err.auth.invalid_credentials", Message: "bad token", Retryable: false,
		})
		errEnv.InReplyTo = login.ID
		b, _ := protocol.MarshalEnvelope(errEnv)
		_ = c.Write(ctx, websocket.MessageText, b)
		_ = c.Close(websocket.StatusCode(4001), "auth failed")
		return nil
	})

	SetAgentVersion("1.0.0")
	cfg := mkCfg(wsURL(srv.URL))
	d := New(cfg, mkLogger(), nil)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	err := d.Run(ctx)
	if err == nil {
		t.Fatalf("expected error after repeated auth failures")
	}
	if d.ExitCode() == 0 {
		t.Errorf("expected non-zero exit code after auth give-up")
	}
}

// -----------------------------------------------------------------------------
// Test 4: task.offer → ack → accept → progress → complete flow.
// -----------------------------------------------------------------------------

func TestTaskOfferFlow(t *testing.T) {
	var (
		gotAck          atomic.Bool
		gotAccept       atomic.Bool
		gotProgress     atomic.Int32
		gotComplete     atomic.Bool
		completePayload protocol.TaskCompletePayload
		completeMu      sync.Mutex
	)

	srv := newMockBroker(t, func(ctx context.Context, t *testing.T, c *websocket.Conn) error {
		// Standard handshake.
		hello, err := readFrame(ctx, c)
		if err != nil {
			return err
		}
		_ = writeFrame(ctx, c, protocol.TypeWelcome, hello.ID, &protocol.WelcomePayload{
			ServerVersion: "mock", ProtocolVersion: 1, MinProtocolVersion: 1,
			RequiredAgentVersion: "0.0.1", SessionID: "sess",
			HeartbeatIntervalSec: 30, HeartbeatGraceSec: 90,
		})
		login, err := readFrame(ctx, c)
		if err != nil {
			return err
		}
		_ = writeFrame(ctx, c, protocol.TypeAuthSession, login.ID, &protocol.AuthSessionPayload{
			BearerToken: "sb", RefreshToken: "sr",
			TenantID: "cust", AgentID: "agt",
			Scopes: []string{"task.run"},
		})

		// Send a task.offer.
		offerEnv, _ := protocol.NewEnvelope(agentulid.New(), protocol.TypeTaskOffer, &protocol.TaskOfferPayload{
			TaskID:         "task_test_1",
			IdempotencyKey: "idem_1",
			TenantID:       "cust",
			Priority:       5,
			TimeoutSec:     60,
			Execution: protocol.ExecutionSpec{
				Runner: "echo", Runtime: "python3", Action: "ac",
				Input:      protocol.InputSpec{Mode: "inline", Inline: "// mock"},
				Parameters: map[string]interface{}{},
				Includes:   []protocol.ArtifactRef{},
				Options:    map[string]string{},
			},
		})
		b, _ := protocol.MarshalEnvelope(offerEnv)
		_ = c.Write(ctx, websocket.MessageText, b)

		// Collect frames until complete or timeout.
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			env, err := readFrame(ctx, c)
			if err != nil {
				return err
			}
			switch env.Type {
			case protocol.TypeAck:
				var a protocol.AckPayload
				_ = env.Decode(&a)
				if a.ForID == offerEnv.ID {
					gotAck.Store(true)
				}
			case protocol.TypeTaskAccept:
				gotAccept.Store(true)
			case protocol.TypeTaskProgress:
				gotProgress.Add(1)
			case protocol.TypeTaskComplete:
				gotComplete.Store(true)
				completeMu.Lock()
				_ = env.Decode(&completePayload)
				completeMu.Unlock()
				return nil
			case protocol.TypeLogChunk, protocol.TypeHeartbeat:
				// expected, ignore
			}
		}
		return fmt.Errorf("timed out waiting for task.complete")
	})

	cfg := mkCfg(wsURL(srv.URL))
	d := New(cfg, mkLogger(), nil)
	d.SetExecutor(&fakeExecutor{})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	go func() { _ = d.Run(ctx) }()

	// Wait for complete.
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) && !gotComplete.Load() {
		time.Sleep(30 * time.Millisecond)
	}

	if !gotAck.Load() {
		t.Errorf("agent did not ack the offer")
	}
	if !gotAccept.Load() {
		t.Errorf("agent did not send task.accept")
	}
	if gotProgress.Load() == 0 {
		t.Errorf("agent did not send any task.progress frames")
	}
	if !gotComplete.Load() {
		t.Fatalf("agent did not send task.complete")
	}
	completeMu.Lock()
	status := completePayload.Status
	completeMu.Unlock()
	if status != "success" {
		t.Errorf("complete.status = %q, want success", status)
	}
}

// fakeExecutor — echoes the offer into two progress frames then completes.
type fakeExecutor struct{}

func (f *fakeExecutor) Execute(ctx context.Context, offer *protocol.TaskOfferPayload, sink TaskSink) {
	_ = sink.SendProgress(&protocol.TaskProgressPayload{TaskID: offer.TaskID, Seq: 1, Percent: 10, Phase: "running"})
	_ = sink.SendProgress(&protocol.TaskProgressPayload{TaskID: offer.TaskID, Seq: 2, Percent: 90, Phase: "post"})
	_ = sink.SendComplete(&protocol.TaskCompletePayload{
		TaskID:      offer.TaskID,
		Status:      "success",
		Metrics:     map[string]interface{}{"items_processed": 42},
		DurationSec: 0.05,
		Artifacts:   []protocol.ArtifactRef{},
		CompletedAt: protocol.NowTS(),
	})
}

func (f *fakeExecutor) Cancel(taskID string) bool { return false }

// -----------------------------------------------------------------------------
// Test 5: semver compare behaviour.
// -----------------------------------------------------------------------------

func TestCompareSemver(t *testing.T) {
	cases := []struct {
		a, b string
		cmp  int
		ok   bool
	}{
		{"1.0.0", "1.0.0", 0, true},
		{"1.0.0", "1.0.1", -1, true},
		{"1.0.1", "1.0.0", 1, true},
		{"1.4.19", "1.4.10", 1, true},
		{"1.4.19+sha.abc", "1.4.19", 0, true},
		{"0.0.1-alpha.0", "0.0.1", 0, true},
		{"not-a-version", "1.0.0", 0, false},
	}
	for _, c := range cases {
		got, ok := compareSemver(c.a, c.b)
		if ok != c.ok {
			t.Errorf("compareSemver(%q, %q) ok = %v, want %v", c.a, c.b, ok, c.ok)
			continue
		}
		if got != c.cmp {
			t.Errorf("compareSemver(%q, %q) = %d, want %d", c.a, c.b, got, c.cmp)
		}
	}
}

// -----------------------------------------------------------------------------
// Test 6: ping → pong reply.
// -----------------------------------------------------------------------------

func TestPingPong(t *testing.T) {
	gotPong := make(chan string, 1)
	srv := newMockBroker(t, func(ctx context.Context, t *testing.T, c *websocket.Conn) error {
		hello, _ := readFrame(ctx, c)
		_ = writeFrame(ctx, c, protocol.TypeWelcome, hello.ID, &protocol.WelcomePayload{
			ServerVersion: "m", ProtocolVersion: 1, MinProtocolVersion: 1,
			RequiredAgentVersion: "0.0.1", SessionID: "s",
			HeartbeatIntervalSec: 30, HeartbeatGraceSec: 90,
		})
		login, _ := readFrame(ctx, c)
		_ = writeFrame(ctx, c, protocol.TypeAuthSession, login.ID, &protocol.AuthSessionPayload{
			BearerToken: "sb", RefreshToken: "sr", TenantID: "c", AgentID: "a", Scopes: []string{},
		})

		// Send a ping, expect a pong with in_reply_to.
		ping, _ := protocol.NewEnvelope(agentulid.New(), protocol.TypePing, map[string]any{})
		b, _ := protocol.MarshalEnvelope(ping)
		_ = c.Write(ctx, websocket.MessageText, b)

		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			env, err := readFrame(ctx, c)
			if err != nil {
				return err
			}
			if env.Type == protocol.TypePong {
				gotPong <- env.InReplyTo
				return nil
			}
		}
		return fmt.Errorf("no pong")
	})

	cfg := mkCfg(wsURL(srv.URL))
	d := New(cfg, mkLogger(), nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go func() { _ = d.Run(ctx) }()

	select {
	case inReplyTo := <-gotPong:
		if inReplyTo == "" {
			t.Errorf("pong missing in_reply_to")
		}
	case <-ctx.Done():
		t.Fatalf("timed out waiting for pong")
	}
}

// -----------------------------------------------------------------------------
// Test 7: heartbeat frames are emitted after auth.
// -----------------------------------------------------------------------------

func TestHeartbeatEmitted(t *testing.T) {
	gotHeartbeat := make(chan struct{}, 1)
	srv := newMockBroker(t, func(ctx context.Context, t *testing.T, c *websocket.Conn) error {
		hello, _ := readFrame(ctx, c)
		_ = writeFrame(ctx, c, protocol.TypeWelcome, hello.ID, &protocol.WelcomePayload{
			ServerVersion: "m", ProtocolVersion: 1, MinProtocolVersion: 1,
			RequiredAgentVersion: "0.0.1", SessionID: "s",
			HeartbeatIntervalSec: 1, HeartbeatGraceSec: 3,
		})
		login, _ := readFrame(ctx, c)
		_ = writeFrame(ctx, c, protocol.TypeAuthSession, login.ID, &protocol.AuthSessionPayload{
			BearerToken: "sb", RefreshToken: "sr", TenantID: "c", AgentID: "a", Scopes: []string{},
		})
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			env, err := readFrame(ctx, c)
			if err != nil {
				return err
			}
			if env.Type == protocol.TypeHeartbeat {
				var hp protocol.HeartbeatPayload
				_ = env.Decode(&hp)
				if hp.UptimeSec < 0 {
					return fmt.Errorf("negative uptime")
				}
				select {
				case gotHeartbeat <- struct{}{}:
				default:
				}
				return nil
			}
		}
		return fmt.Errorf("no heartbeat")
	})

	cfg := mkCfg(wsURL(srv.URL))
	d := New(cfg, mkLogger(), nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go func() { _ = d.Run(ctx) }()

	select {
	case <-gotHeartbeat:
	case <-ctx.Done():
		t.Fatalf("no heartbeat received")
	}
}

// -----------------------------------------------------------------------------
// Test 8: malformed welcome → session fails with handshake error.
// -----------------------------------------------------------------------------

func TestMalformedWelcomeFails(t *testing.T) {
	srv := newMockBroker(t, func(ctx context.Context, t *testing.T, c *websocket.Conn) error {
		_, _ = readFrame(ctx, c)
		// Wrong type where welcome should be.
		bogus := &protocol.Envelope{
			V: 1, Type: "garbage", ID: agentulid.New(), TS: protocol.NowTS(),
			Payload: json.RawMessage(`{}`),
		}
		b, _ := protocol.MarshalEnvelope(bogus)
		_ = c.Write(ctx, websocket.MessageText, b)
		return nil
	})

	cfg := mkCfg(wsURL(srv.URL))
	d := New(cfg, mkLogger(), nil)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	// The dialer will backoff-retry; we just need to observe it doesn't reach Running.
	go func() { _ = d.Run(ctx) }()

	time.Sleep(500 * time.Millisecond)
	if d.State() == StateRunning {
		t.Errorf("dialer should not reach Running after bad welcome")
	}
}

// -----------------------------------------------------------------------------
// Test 9: task.cancel reaches runner.
// -----------------------------------------------------------------------------

func TestTaskCancelRoutedToRunner(t *testing.T) {
	cancelled := make(chan string, 1)

	srv := newMockBroker(t, func(ctx context.Context, t *testing.T, c *websocket.Conn) error {
		hello, _ := readFrame(ctx, c)
		_ = writeFrame(ctx, c, protocol.TypeWelcome, hello.ID, &protocol.WelcomePayload{
			ServerVersion: "m", ProtocolVersion: 1, MinProtocolVersion: 1,
			RequiredAgentVersion: "0.0.1", SessionID: "s",
			HeartbeatIntervalSec: 30, HeartbeatGraceSec: 90,
		})
		login, _ := readFrame(ctx, c)
		_ = writeFrame(ctx, c, protocol.TypeAuthSession, login.ID, &protocol.AuthSessionPayload{
			BearerToken: "sb", RefreshToken: "sr", TenantID: "c", AgentID: "a", Scopes: []string{},
		})
		// Offer, then cancel.
		offer, _ := protocol.NewEnvelope(agentulid.New(), protocol.TypeTaskOffer, &protocol.TaskOfferPayload{
			TaskID: "task_cancel_me", IdempotencyKey: "k", TenantID: "c", TimeoutSec: 60,
			Execution: protocol.ExecutionSpec{Runner: "echo", Runtime: "python3", Action: "ac",
				Input: protocol.InputSpec{Mode: "inline", Inline: "// x"}},
		})
		b, _ := protocol.MarshalEnvelope(offer)
		_ = c.Write(ctx, websocket.MessageText, b)

		time.Sleep(100 * time.Millisecond)

		cancel, _ := protocol.NewEnvelope(agentulid.New(), protocol.TypeTaskCancel, &protocol.TaskCancelPayload{
			TaskID: "task_cancel_me", Reason: "user_requested", GraceS: 5,
		})
		b, _ = protocol.MarshalEnvelope(cancel)
		_ = c.Write(ctx, websocket.MessageText, b)

		// Drain the rest.
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := readFrame(ctx, c); err != nil {
				return nil
			}
		}
		return nil
	})

	cfg := mkCfg(wsURL(srv.URL))
	d := New(cfg, mkLogger(), nil)
	d.SetExecutor(&cancelWatchingExec{cancelled: cancelled})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go func() { _ = d.Run(ctx) }()

	select {
	case id := <-cancelled:
		if id != "task_cancel_me" {
			t.Errorf("wrong task cancelled: %q", id)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("executor never received Cancel")
	}
}

type cancelWatchingExec struct {
	cancelled chan string
}

func (e *cancelWatchingExec) Execute(ctx context.Context, offer *protocol.TaskOfferPayload, sink TaskSink) {
	// Block until cancelled.
	<-ctx.Done()
	_ = sink.SendComplete(&protocol.TaskCompletePayload{
		TaskID: offer.TaskID, Status: "canceled",
		Metrics:   map[string]interface{}{},
		Artifacts: []protocol.ArtifactRef{},
	})
}

func (e *cancelWatchingExec) Cancel(taskID string) bool {
	select {
	case e.cancelled <- taskID:
	default:
	}
	return true
}

// -----------------------------------------------------------------------------
// Test 10: Shutdown sends bye and drains.
// -----------------------------------------------------------------------------

func TestShutdownSendsBye(t *testing.T) {
	gotBye := make(chan struct{}, 1)

	srv := newMockBroker(t, func(ctx context.Context, t *testing.T, c *websocket.Conn) error {
		hello, _ := readFrame(ctx, c)
		_ = writeFrame(ctx, c, protocol.TypeWelcome, hello.ID, &protocol.WelcomePayload{
			ServerVersion: "m", ProtocolVersion: 1, MinProtocolVersion: 1,
			RequiredAgentVersion: "0.0.1", SessionID: "s",
			HeartbeatIntervalSec: 30, HeartbeatGraceSec: 90,
		})
		login, _ := readFrame(ctx, c)
		_ = writeFrame(ctx, c, protocol.TypeAuthSession, login.ID, &protocol.AuthSessionPayload{
			BearerToken: "sb", RefreshToken: "sr", TenantID: "c", AgentID: "a", Scopes: []string{},
		})
		for {
			env, err := readFrame(ctx, c)
			if err != nil {
				return nil
			}
			if env.Type == protocol.TypeBye {
				select {
				case gotBye <- struct{}{}:
				default:
				}
				return nil
			}
		}
	})

	cfg := mkCfg(wsURL(srv.URL))
	d := New(cfg, mkLogger(), nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go func() { _ = d.Run(ctx) }()

	// Wait for auth to complete.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && d.State() != StateRunning {
		time.Sleep(20 * time.Millisecond)
	}

	shutCtx, shutCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer shutCancel()
	_ = d.Shutdown(shutCtx)

	select {
	case <-gotBye:
	case <-time.After(2 * time.Second):
		t.Fatalf("broker never saw bye frame")
	}
}

// -----------------------------------------------------------------------------
// Test 11: buildHello fills basic fields.
// -----------------------------------------------------------------------------

func TestBuildHelloFillsBasics(t *testing.T) {
	cfg := &config.Config{AgentName: "my-vm", APIKey: "x", ServerURL: "wss://x/"}
	hp := buildHello(cfg, time.Unix(1713530000, 0))
	if hp.AgentID != "my-vm" {
		t.Errorf("agent_id = %q", hp.AgentID)
	}
	if hp.AgentVersion == "" {
		t.Errorf("agent_version empty")
	}
	if len(hp.ProtocolVersions) == 0 || hp.ProtocolVersions[0] != 1 {
		t.Errorf("protocol_versions = %v", hp.ProtocolVersions)
	}
	if hp.Arch == "" {
		t.Errorf("arch empty")
	}
	if hp.StartTime != 1713530000 {
		t.Errorf("start_time = %v", hp.StartTime)
	}
}

// -----------------------------------------------------------------------------
// Test 12: backoff grows.
// -----------------------------------------------------------------------------

func TestBackoffGrows(t *testing.T) {
	b := newBackoff(100*time.Millisecond, 5*time.Second)
	// Fire off several — we care that it monotonically grows until cap.
	prev := time.Duration(0)
	grew := false
	for i := 0; i < 20; i++ {
		n := b.next()
		if n > prev {
			grew = true
		}
		prev = n
	}
	if !grew {
		t.Errorf("backoff never grew")
	}
	if b.cur < b.max/2 {
		t.Errorf("backoff didn't approach max: cur=%v max=%v", b.cur, b.max)
	}
}
