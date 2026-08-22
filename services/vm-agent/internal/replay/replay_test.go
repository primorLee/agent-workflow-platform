package replay

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/primorLee/agent-workflow-platform/services/vm-agent/internal/queue"
)

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type fakeAuth struct{ ok atomic.Bool }

func (f *fakeAuth) IsAuthenticated() bool { return f.ok.Load() }
func (f *fakeAuth) set(v bool)            { f.ok.Store(v) }

type fakeFlow struct{ ready atomic.Bool }

func (f *fakeFlow) Ready() bool { return f.ready.Load() }
func (f *fakeFlow) set(v bool)  { f.ready.Store(v) }

// fakeSender records every payload it's asked to send and can be
// scripted to fail a configurable number of times per task_id.
type fakeSender struct {
	mu            sync.Mutex
	sent          []sentRecord
	failUntil     map[string]int // task_id -> remaining failures
	fatalForIDs   map[string]bool
	beforeFatal   func()
	beforeSuccess func()
	errText       string
}

type sentRecord struct {
	taskID  string
	payload []byte
}

func newFakeSender() *fakeSender {
	return &fakeSender{
		failUntil:   make(map[string]int),
		fatalForIDs: make(map[string]bool),
		errText:     "transient network error",
	}
}

func (f *fakeSender) Send(ctx context.Context, taskID string, payload []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fatalForIDs[taskID] {
		if f.beforeFatal != nil {
			f.beforeFatal()
		}
		return errFatal{msg: "broker rejected: bad task"}
	}
	if n := f.failUntil[taskID]; n > 0 {
		f.failUntil[taskID] = n - 1
		return errors.New(f.errText)
	}
	cp := make([]byte, len(payload))
	copy(cp, payload)
	f.sent = append(f.sent, sentRecord{taskID: taskID, payload: cp})
	if f.beforeSuccess != nil {
		f.beforeSuccess()
	}
	return nil
}

func (f *fakeSender) sentTaskIDs() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.sent))
	for i, r := range f.sent {
		out[i] = r.taskID
	}
	return out
}

type errFatal struct{ msg string }

func (e errFatal) Error() string { return e.msg }

type fakeChecker struct{}

func (fakeChecker) IsFatal(err error) bool {
	var f errFatal
	return errors.As(err, &f)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func openTestQueue(t *testing.T) *queue.Queue {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "queue.db")
	q, err := queue.Open(queue.Config{
		Path:       path,
		MaxRetries: 3,
		PruneAfter: time.Hour,
	})
	if err != nil {
		t.Fatalf("open queue: %v", err)
	}
	t.Cleanup(func() {
		if err := q.Close(); err != nil {
			t.Errorf("close queue: %v", err)
		}
	})
	return q
}

type replayerRunHandle struct {
	cancel context.CancelFunc
	done   <-chan error
	once   sync.Once
}

func startReplayer(t *testing.T, r *Replayer, ctx context.Context, cancel context.CancelFunc) *replayerRunHandle {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- r.Run(ctx) }()
	handle := &replayerRunHandle{cancel: cancel, done: done}
	t.Cleanup(func() { handle.stop(t) })
	return handle
}

func (h *replayerRunHandle) stop(t *testing.T) {
	t.Helper()
	h.once.Do(func() {
		h.cancel()
		select {
		case err := <-h.done:
			if err != nil {
				t.Errorf("replayer Run: %v", err)
			}
		case <-time.After(time.Second):
			t.Errorf("replayer did not stop within one second")
		}
	})
}

func completePayload(taskID string) []byte {
	raw, _ := json.Marshal(map[string]any{
		"task_id": taskID,
		"status":  "success",
		"metrics": map[string]any{"duration_ms": 200000},
	})
	return raw
}

// ---------------------------------------------------------------------------
// Case 1 — Happy path: once authenticated + ready, pending rows drain.
// ---------------------------------------------------------------------------

func TestReplayHappyPath(t *testing.T) {
	q := openTestQueue(t)
	ctx := context.Background()

	var ids []int64
	for i := 0; i < 5; i++ {
		id, err := q.Enqueue(ctx, fmt.Sprintf("t-%d", i),
			completePayload(fmt.Sprintf("t-%d", i)))
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}

	sender := newFakeSender()
	auth := &fakeAuth{}
	auth.set(true)
	flow := &fakeFlow{}
	flow.set(true)

	r, err := New(q, sender, auth, flow, fakeChecker{}, Config{
		PollInterval: 10 * time.Millisecond,
		BatchSize:    50,
		MaxRetries:   3,
	})
	if err != nil {
		t.Fatal(err)
	}
	runCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	run := startReplayer(t, r, runCtx, cancel)

	deadline := time.Now().Add(1500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if len(sender.sentTaskIDs()) == len(ids) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	run.stop(t)

	if got := sender.sentTaskIDs(); len(got) != len(ids) {
		t.Fatalf("expected %d sends, got %d (%v)", len(ids), len(got), got)
	}
	// All rows should now be in ``uploaded``.
	st, _ := q.Stats(ctx)
	if st.Uploaded != int64(len(ids)) || st.Queued != 0 {
		t.Fatalf("expected all uploaded, got %+v", st)
	}

	// resume:true must be stamped on every replayed envelope.
	for _, rec := range sender.sent {
		var m map[string]any
		if err := json.Unmarshal(rec.payload, &m); err != nil {
			t.Fatalf("bad json: %v", err)
		}
		if m["resume"] != true {
			t.Fatalf("expected resume:true on replay, got %v", m["resume"])
		}
	}
}

// ---------------------------------------------------------------------------
// Case 2 — Transient failures retry with exp. backoff; eventual success.
// ---------------------------------------------------------------------------

func TestReplayTransientRetries(t *testing.T) {
	q := openTestQueue(t)
	ctx := context.Background()

	id, err := q.Enqueue(ctx, "t-flaky", completePayload("t-flaky"))
	if err != nil {
		t.Fatal(err)
	}
	_ = id

	sender := newFakeSender()
	// Fail the first 2 attempts, succeed on the 3rd.
	sender.failUntil["t-flaky"] = 2

	auth := &fakeAuth{}
	auth.set(true)
	flow := &fakeFlow{}
	flow.set(true)

	r, _ := New(q, sender, auth, flow, fakeChecker{}, Config{
		PollInterval: 5 * time.Millisecond,
		BatchSize:    10,
		MaxRetries:   5,
		MaxBackoff:   50 * time.Millisecond,
	})
	runCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	run := startReplayer(t, r, runCtx, cancel)

	deadline := time.Now().Add(1500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if len(sender.sentTaskIDs()) == 1 && r.Metrics().Uploaded == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	run.stop(t)

	if got := sender.sentTaskIDs(); len(got) != 1 || got[0] != "t-flaky" {
		t.Fatalf("expected 1 send of t-flaky after retries, got %v", got)
	}
	m := r.Metrics()
	if m.Failed < 2 {
		t.Fatalf("expected >=2 transient failures recorded, got %+v", m)
	}
	if m.Uploaded != 1 {
		t.Fatalf("expected 1 uploaded, got %+v", m)
	}
}

// ---------------------------------------------------------------------------
// Case 3 — Fatal errors drop immediately, no retry budget burn.
// ---------------------------------------------------------------------------

func TestReplayFatalDropsImmediately(t *testing.T) {
	q := openTestQueue(t)
	ctx := context.Background()

	_, err := q.Enqueue(ctx, "t-bad", completePayload("t-bad"))
	if err != nil {
		t.Fatal(err)
	}

	sender := newFakeSender()
	sender.fatalForIDs["t-bad"] = true

	auth := &fakeAuth{}
	auth.set(true)
	flow := &fakeFlow{}
	flow.set(true)

	r, _ := New(q, sender, auth, flow, fakeChecker{}, Config{
		PollInterval: 5 * time.Millisecond,
		BatchSize:    10,
		MaxRetries:   10,
	})
	runCtx, cancel := context.WithTimeout(ctx, 1*time.Second)
	run := startReplayer(t, r, runCtx, cancel)

	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if r.Metrics().Dropped == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	run.stop(t)

	m := r.Metrics()
	if m.Dropped != 1 {
		t.Fatalf("expected 1 dropped (fatal), got %+v", m)
	}
	if m.Uploaded != 0 {
		t.Fatalf("expected 0 uploaded, got %+v", m)
	}
	st, _ := q.Stats(ctx)
	if st.Dropped != 1 {
		t.Fatalf("expected row marked dropped, got %+v", st)
	}
}

func TestReplayFatalDropSurvivesShutdownCancellation(t *testing.T) {
	q := openTestQueue(t)
	ctx := context.Background()

	_, err := q.Enqueue(ctx, "t-bad-during-shutdown", completePayload("t-bad-during-shutdown"))
	if err != nil {
		t.Fatal(err)
	}

	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	sender := newFakeSender()
	sender.fatalForIDs["t-bad-during-shutdown"] = true
	sender.beforeFatal = cancel

	auth := &fakeAuth{}
	auth.set(true)
	flow := &fakeFlow{}
	flow.set(true)

	r, err := New(q, sender, auth, flow, fakeChecker{}, Config{
		PollInterval: 5 * time.Millisecond,
		BatchSize:    10,
		MaxRetries:   10,
	})
	if err != nil {
		t.Fatal(err)
	}
	anyFailed, err := r.tick(runCtx)
	if err != nil {
		t.Fatalf("fatal replay tick: %v", err)
	}
	if anyFailed {
		t.Fatal("fatal rejection must not be classified as transient")
	}
	if !errors.Is(runCtx.Err(), context.Canceled) {
		t.Fatalf("sender did not trigger shutdown cancellation: %v", runCtx.Err())
	}

	if got := r.Metrics().Dropped; got != 1 {
		t.Fatalf("expected fatal result to be dropped during shutdown, got %d", got)
	}
	st, err := q.Stats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.Dropped != 1 || st.Uploading != 0 {
		t.Fatalf("expected durable dropped state during shutdown, got %+v", st)
	}
}

func TestReplayAcknowledgementSurvivesShutdownCancellation(t *testing.T) {
	q := openTestQueue(t)
	ctx := context.Background()
	for _, taskID := range []string{"t-acked-during-shutdown", "t-unsent-during-shutdown"} {
		if _, err := q.Enqueue(ctx, taskID, completePayload(taskID)); err != nil {
			t.Fatal(err)
		}
	}

	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	sender := newFakeSender()
	sender.beforeSuccess = cancel
	auth := &fakeAuth{}
	auth.set(true)
	flow := &fakeFlow{}
	flow.set(true)
	r, err := New(q, sender, auth, flow, fakeChecker{}, Config{})
	if err != nil {
		t.Fatal(err)
	}
	anyFailed, err := r.tick(runCtx)
	if !errors.Is(err, context.Canceled) || anyFailed {
		t.Fatalf("acknowledged replay tick: failed=%v err=%v", anyFailed, err)
	}
	if !errors.Is(runCtx.Err(), context.Canceled) {
		t.Fatalf("sender did not trigger shutdown cancellation: %v", runCtx.Err())
	}
	if got := sender.sentTaskIDs(); len(got) != 1 || got[0] != "t-acked-during-shutdown" {
		t.Fatalf("expected exactly one send, got %v", got)
	}
	st, err := q.Stats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.Uploaded != 1 || st.Queued != 1 || st.Uploading != 0 || r.Metrics().Uploaded != 1 {
		t.Fatalf("expected durable uploaded state and unsent requeue during shutdown, queue=%+v metrics=%+v", st, r.Metrics())
	}
	if r.pendingTerminal != nil || len(r.pendingRequeue) != 0 {
		t.Fatalf("shutdown recovery state was not cleared: terminal=%v requeue=%v", r.pendingTerminal, r.pendingRequeue)
	}
}

func TestRunRecoversPendingTerminalBeforeNetworkGates(t *testing.T) {
	q := openTestQueue(t)
	ctx := context.Background()
	for _, taskID := range []string{"t-already-acked", "t-not-sent"} {
		if _, err := q.Enqueue(ctx, taskID, completePayload(taskID)); err != nil {
			t.Fatal(err)
		}
	}
	items, err := q.Dequeue(ctx, 2)
	if err != nil || len(items) != 2 {
		t.Fatalf("Dequeue: err=%v len=%d", err, len(items))
	}

	sender := newFakeSender()
	auth := &fakeAuth{} // disconnected
	flow := &fakeFlow{} // paused
	r, err := New(q, sender, auth, flow, fakeChecker{}, Config{
		PollInterval: 5 * time.Millisecond,
		BatchSize:    10,
	})
	if err != nil {
		t.Fatal(err)
	}
	r.pendingTerminal = &pendingTerminal{kind: terminalUploaded, id: items[0].ID}
	r.pendingRequeue = []int64{items[1].ID}
	runCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	run := startReplayer(t, r, runCtx, cancel)

	deadline := time.Now().Add(time.Second)
	recovered := false
	for time.Now().Before(deadline) {
		st, statsErr := q.Stats(ctx)
		if statsErr == nil && st.Uploaded == 1 && st.Queued == 1 && st.Uploading == 0 {
			recovered = true
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !recovered {
		st, _ := q.Stats(ctx)
		t.Fatalf("pending state was not recovered before network gates: %+v", st)
	}
	if got := sender.sentTaskIDs(); len(got) != 0 {
		t.Fatalf("network gates must prevent sends during local recovery: %v", got)
	}

	auth.set(true)
	flow.set(true)
	deadline = time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if len(sender.sentTaskIDs()) == 1 && r.Metrics().Uploaded == 2 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	run.stop(t)

	if got := sender.sentTaskIDs(); len(got) != 1 || got[0] != "t-not-sent" {
		t.Fatalf("pending terminal was resent or unsent item was lost: %v", got)
	}
	st, err := q.Stats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.Uploaded != 2 || st.Uploading != 0 || r.pendingTerminal != nil || len(r.pendingRequeue) != 0 {
		t.Fatalf("pending recovery incomplete: queue=%+v metrics=%+v", st, r.Metrics())
	}
}

func TestReplayMidBatchPauseRequeuesEveryUnsentItem(t *testing.T) {
	q := openTestQueue(t)
	ctx := context.Background()
	for _, taskID := range []string{"pause-0", "pause-1", "pause-2"} {
		if _, err := q.Enqueue(ctx, taskID, completePayload(taskID)); err != nil {
			t.Fatal(err)
		}
	}

	auth := &fakeAuth{}
	auth.set(true)
	flow := &fakeFlow{}
	flow.set(true)
	sender := newFakeSender()
	var pauseOnce sync.Once
	sender.beforeSuccess = func() { pauseOnce.Do(func() { flow.set(false) }) }
	r, err := New(q, sender, auth, flow, fakeChecker{}, Config{BatchSize: 10})
	if err != nil {
		t.Fatal(err)
	}
	anyFailed, err := r.tick(ctx)
	if err != nil || anyFailed {
		t.Fatalf("paused tick: failed=%v err=%v", anyFailed, err)
	}
	st, err := q.Stats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.Uploaded != 1 || st.Queued != 2 || st.Uploading != 0 {
		t.Fatalf("mid-batch pause stranded rows: %+v", st)
	}
	if got := sender.sentTaskIDs(); len(got) != 1 || got[0] != "pause-0" {
		t.Fatalf("unexpected sends before pause: %v", got)
	}

	flow.set(true)
	anyFailed, err = r.tick(ctx)
	if err != nil || anyFailed {
		t.Fatalf("resumed tick: failed=%v err=%v", anyFailed, err)
	}
	st, err = q.Stats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.Uploaded != 3 || st.Queued != 0 || st.Uploading != 0 {
		t.Fatalf("resume did not drain all rows: %+v", st)
	}
}

func TestTerminalWriteFailureStagesRecoveryWithoutMetric(t *testing.T) {
	q := openTestQueue(t)
	ctx := context.Background()
	_, err := q.Enqueue(ctx, "t-stage-terminal", completePayload("t-stage-terminal"))
	if err != nil {
		t.Fatal(err)
	}

	sender := newFakeSender()
	sender.beforeSuccess = func() { _ = q.Close() }
	auth := &fakeAuth{}
	auth.set(true)
	flow := &fakeFlow{}
	flow.set(true)
	r, err := New(q, sender, auth, flow, fakeChecker{}, Config{})
	if err != nil {
		t.Fatal(err)
	}
	anyFailed, err := r.tick(ctx)
	if err == nil || !anyFailed {
		t.Fatalf("terminal persistence failure must stop the batch: failed=%v err=%v", anyFailed, err)
	}
	if r.pendingTerminal == nil || r.pendingTerminal.kind != terminalUploaded {
		t.Fatalf("terminal recovery was not staged: %+v", r.pendingTerminal)
	}
	if r.Metrics().Uploaded != 0 {
		t.Fatalf("metric advanced before durable terminal write: %+v", r.Metrics())
	}
	if got := sender.sentTaskIDs(); len(got) != 1 || got[0] != "t-stage-terminal" {
		t.Fatalf("unexpected sends while staging recovery: %v", got)
	}
}

func TestPendingRecoveryPhasesDoNotDoubleCountTerminalMetric(t *testing.T) {
	q := openTestQueue(t)
	ctx := context.Background()
	terminalID, err := q.Enqueue(ctx, "t-phase-terminal", completePayload("t-phase-terminal"))
	if err != nil {
		t.Fatal(err)
	}
	items, err := q.Dequeue(ctx, 1)
	if err != nil || len(items) != 1 || items[0].ID != terminalID {
		t.Fatalf("Dequeue: err=%v items=%v", err, items)
	}

	sender := newFakeSender()
	r, err := New(q, sender, &fakeAuth{}, &fakeFlow{}, fakeChecker{}, Config{})
	if err != nil {
		t.Fatal(err)
	}
	missingID := terminalID + 1
	r.pendingTerminal = &pendingTerminal{kind: terminalUploaded, id: terminalID}
	r.pendingRequeue = []int64{missingID}
	if err := r.recoverPending(ctx); err == nil {
		t.Fatal("missing requeue row must fail the second recovery phase")
	}
	if r.pendingTerminal != nil || r.Metrics().Uploaded != 1 || len(r.pendingRequeue) != 1 {
		t.Fatalf("terminal phase did not commit exactly once: pending=%+v metrics=%+v requeue=%v",
			r.pendingTerminal, r.Metrics(), r.pendingRequeue)
	}

	requeueID, err := q.Enqueue(ctx, "t-phase-requeue", completePayload("t-phase-requeue"))
	if err != nil {
		t.Fatal(err)
	}
	if requeueID != missingID {
		t.Fatalf("expected recovery row id %d, got %d", missingID, requeueID)
	}
	items, err = q.Dequeue(ctx, 1)
	if err != nil || len(items) != 1 || items[0].ID != requeueID {
		t.Fatalf("recovery Dequeue: err=%v items=%v", err, items)
	}
	if err := r.recoverPending(ctx); err != nil {
		t.Fatal(err)
	}
	if r.Metrics().Uploaded != 1 || r.pendingTerminal != nil || len(r.pendingRequeue) != 0 {
		t.Fatalf("requeue phase repeated terminal metric: pending=%+v metrics=%+v requeue=%v",
			r.pendingTerminal, r.Metrics(), r.pendingRequeue)
	}
	if got := sender.sentTaskIDs(); len(got) != 0 {
		t.Fatalf("local recovery must not resend: %v", got)
	}
	st, err := q.Stats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.Uploaded != 1 || st.Queued != 1 || st.Uploading != 0 {
		t.Fatalf("phase recovery state mismatch: %+v", st)
	}
}

func TestRecoverPendingFatalIsIdempotentAndDoesNotSend(t *testing.T) {
	q := openTestQueue(t)
	ctx := context.Background()
	id, err := q.Enqueue(ctx, "t-fatal-pending", completePayload("t-fatal-pending"))
	if err != nil {
		t.Fatal(err)
	}
	if err := q.ForceDropped(ctx, id, "already committed"); err != nil {
		t.Fatal(err)
	}

	sender := newFakeSender()
	r, err := New(q, sender, &fakeAuth{}, &fakeFlow{}, fakeChecker{}, Config{})
	if err != nil {
		t.Fatal(err)
	}
	r.pendingTerminal = &pendingTerminal{
		kind: terminalDropped, id: id, reason: "broker rejected",
	}
	if err := r.recoverPending(ctx); err != nil {
		t.Fatal(err)
	}
	if err := r.recoverPending(ctx); err != nil {
		t.Fatal(err)
	}
	if r.Metrics().Dropped != 1 || r.pendingTerminal != nil {
		t.Fatalf("fatal recovery was not counted exactly once: %+v", r.Metrics())
	}
	if got := sender.sentTaskIDs(); len(got) != 0 {
		t.Fatalf("fatal local recovery must not send: %v", got)
	}
	st, err := q.Stats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.Dropped != 1 || st.Uploading != 0 {
		t.Fatalf("fatal recovery state mismatch: %+v", st)
	}
}

func TestRunRejectsConcurrentInvocation(t *testing.T) {
	q := openTestQueue(t)
	auth := &fakeAuth{}
	flow := &fakeFlow{}
	r, err := New(q, newFakeSender(), auth, flow, fakeChecker{}, Config{
		PollInterval: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	runCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- r.Run(runCtx) }()

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && !r.running.Load() {
		time.Sleep(time.Millisecond)
	}
	if !r.running.Load() {
		t.Fatal("first Run did not become active")
	}
	if err := r.Run(context.Background()); err == nil || err.Error() != "replay: Run already active" {
		t.Fatalf("second Run must fail fast, got %v", err)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("first Run: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("first Run did not stop after cancellation")
	}
}

// ---------------------------------------------------------------------------
// Case 4 — Not-authenticated suspends drain; authentication resumes.
// ---------------------------------------------------------------------------

func TestReplayRespectsAuthState(t *testing.T) {
	q := openTestQueue(t)
	ctx := context.Background()

	_, _ = q.Enqueue(ctx, "t-auth", completePayload("t-auth"))

	sender := newFakeSender()
	auth := &fakeAuth{} // starts NOT authenticated
	flow := &fakeFlow{}
	flow.set(true)

	r, _ := New(q, sender, auth, flow, fakeChecker{}, Config{
		PollInterval: 10 * time.Millisecond,
		BatchSize:    10,
		MaxRetries:   3,
	})
	runCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	run := startReplayer(t, r, runCtx, cancel)

	// 200ms with auth=false → no sends.
	time.Sleep(200 * time.Millisecond)
	if got := sender.sentTaskIDs(); len(got) != 0 {
		t.Fatalf("expected no sends while unauthenticated, got %v", got)
	}

	// Flip to authenticated → drain.
	auth.set(true)
	deadline := time.Now().Add(1 * time.Second)
	for time.Now().Before(deadline) {
		if len(sender.sentTaskIDs()) == 1 && r.Metrics().Uploaded == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	run.stop(t)

	if got := sender.sentTaskIDs(); len(got) != 1 {
		t.Fatalf("expected 1 send after auth, got %v", got)
	}
}

// ---------------------------------------------------------------------------
// Case 5 — flow.pause freezes replay; flow.resume unfreezes.
// ---------------------------------------------------------------------------

func TestReplayRespectsFlowControl(t *testing.T) {
	q := openTestQueue(t)
	ctx := context.Background()

	for i := 0; i < 3; i++ {
		_, _ = q.Enqueue(ctx, fmt.Sprintf("t-fc-%d", i),
			completePayload(fmt.Sprintf("t-fc-%d", i)))
	}

	sender := newFakeSender()
	auth := &fakeAuth{}
	auth.set(true)
	flow := &fakeFlow{} // starts NOT ready (paused)

	r, _ := New(q, sender, auth, flow, fakeChecker{}, Config{
		PollInterval: 10 * time.Millisecond,
		BatchSize:    10,
		MaxRetries:   3,
	})
	runCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	run := startReplayer(t, r, runCtx, cancel)

	time.Sleep(200 * time.Millisecond)
	if got := sender.sentTaskIDs(); len(got) != 0 {
		t.Fatalf("paused: expected 0 sends, got %v", got)
	}
	if r.Metrics().PausedTicks < 1 {
		t.Fatalf("expected paused ticks to accumulate, got %+v", r.Metrics())
	}

	// Resume.
	flow.set(true)
	deadline := time.Now().Add(1 * time.Second)
	for time.Now().Before(deadline) {
		if len(sender.sentTaskIDs()) == 3 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	run.stop(t)
	if got := sender.sentTaskIDs(); len(got) != 3 {
		t.Fatalf("resume: expected 3 sends, got %d", len(got))
	}
}

// ---------------------------------------------------------------------------
// Case 6 — MaxRetries exhaustion moves row to dropped.
// ---------------------------------------------------------------------------

func TestReplayRetriesExhaustedToDropped(t *testing.T) {
	q := openTestQueue(t)
	ctx := context.Background()

	_, _ = q.Enqueue(ctx, "t-forever", completePayload("t-forever"))

	sender := newFakeSender()
	// Never succeed for this task.
	sender.failUntil["t-forever"] = 99

	auth := &fakeAuth{}
	auth.set(true)
	flow := &fakeFlow{}
	flow.set(true)

	r, _ := New(q, sender, auth, flow, fakeChecker{}, Config{
		PollInterval: 5 * time.Millisecond,
		BatchSize:    10,
		MaxRetries:   3,
		MaxBackoff:   30 * time.Millisecond,
	})
	runCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	run := startReplayer(t, r, runCtx, cancel)

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		st, _ := q.Stats(ctx)
		if st.Dropped >= 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	run.stop(t)

	st, _ := q.Stats(ctx)
	if st.Dropped != 1 {
		t.Fatalf("expected 1 dropped after exhaustion, got %+v", st)
	}
	if st.Queued != 0 {
		t.Fatalf("expected 0 queued after drop, got %+v", st)
	}
	if sender.sentTaskIDs() != nil && len(sender.sentTaskIDs()) > 0 {
		t.Fatalf("expected no successful sends for doomed task, got %v",
			sender.sentTaskIDs())
	}
}

// ---------------------------------------------------------------------------
// Case 7 — Items replay in FIFO order.
// ---------------------------------------------------------------------------

func TestReplayPreservesOrder(t *testing.T) {
	q := openTestQueue(t)
	ctx := context.Background()

	var want []string
	for i := 0; i < 10; i++ {
		tid := fmt.Sprintf("t-ord-%02d", i)
		want = append(want, tid)
		_, _ = q.Enqueue(ctx, tid, completePayload(tid))
	}

	sender := newFakeSender()
	auth := &fakeAuth{}
	auth.set(true)
	flow := &fakeFlow{}
	flow.set(true)

	r, _ := New(q, sender, auth, flow, fakeChecker{}, Config{
		PollInterval: 5 * time.Millisecond,
		BatchSize:    100,
		MaxRetries:   3,
	})

	// Exercise one complete claim/send/mark cycle synchronously. This test is
	// about FIFO semantics, not Run's wall-clock scheduler (covered by the
	// lifecycle tests above). Waiting for a background ticker made the result
	// depend on host scheduling and synchronous SQLite fsync latency under a
	// busy test runner, so cancellation could cut a valid batch short.
	anyFailed, err := r.tick(ctx)
	if err != nil {
		t.Fatalf("tick: %v", err)
	}
	if anyFailed {
		t.Fatal("unexpected replay failure")
	}

	got := sender.sentTaskIDs()
	if len(got) != len(want) {
		t.Fatalf("expected %d sends, got %d", len(want), len(got))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("ordering violated at %d: want %q got %q",
				i, want[i], got[i])
		}
	}
	st, err := q.Stats(ctx)
	if err != nil {
		t.Fatalf("stats: %v", err)
	}
	if st.Uploaded != int64(len(want)) || st.Queued != 0 || st.Uploading != 0 {
		t.Fatalf("expected a fully persisted batch, got %+v", st)
	}
}

// ---------------------------------------------------------------------------
// Case 8 — ReclaimUploading on Run() start rescues stranded rows.
// ---------------------------------------------------------------------------

func TestReplayReclaimsOnStart(t *testing.T) {
	q := openTestQueue(t)
	ctx := context.Background()

	_, _ = q.Enqueue(ctx, "t-reclaim", completePayload("t-reclaim"))
	// Simulate crash: Dequeue claims it, then no mark.
	if items, err := q.Dequeue(ctx, 10); err != nil || len(items) != 1 {
		t.Fatalf("pre-crash dequeue: %v len=%d", err, len(items))
	}
	st, _ := q.Stats(ctx)
	if st.Uploading != 1 {
		t.Fatalf("expected 1 uploading (stranded), got %+v", st)
	}

	sender := newFakeSender()
	auth := &fakeAuth{}
	auth.set(true)
	flow := &fakeFlow{}
	flow.set(true)

	r, _ := New(q, sender, auth, flow, fakeChecker{}, Config{
		PollInterval: 5 * time.Millisecond,
		BatchSize:    10,
	})
	runCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	run := startReplayer(t, r, runCtx, cancel)

	deadline := time.Now().Add(1 * time.Second)
	for time.Now().Before(deadline) {
		if len(sender.sentTaskIDs()) == 1 && r.Metrics().Uploaded == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	run.stop(t)

	if len(sender.sentTaskIDs()) != 1 {
		t.Fatalf("expected reclaimed row to be replayed, got %v",
			sender.sentTaskIDs())
	}
}

// ---------------------------------------------------------------------------
// Case 9 — Input-validation for New().
// ---------------------------------------------------------------------------

func TestNewValidation(t *testing.T) {
	q := openTestQueue(t)
	if _, err := New(nil, nil, nil, nil, nil, Config{}); err == nil {
		t.Fatal("expected err for nil queue")
	}
	if _, err := New(q, nil, nil, nil, nil, Config{}); err == nil {
		t.Fatal("expected err for nil sender")
	}
	if _, err := New(q, newFakeSender(), nil, nil, nil, Config{}); err == nil {
		t.Fatal("expected err for nil auth")
	}
	if _, err := New(q, newFakeSender(), &fakeAuth{}, nil, nil,
		Config{}); err != nil {
		t.Fatalf("flow+fatal nil should be accepted, got %v", err)
	}
}

// ---------------------------------------------------------------------------
// Case 10 — EnqueueTaskComplete convenience helper round-trips.
// ---------------------------------------------------------------------------

func TestEnqueueTaskCompleteHelper(t *testing.T) {
	q := openTestQueue(t)
	ctx := context.Background()

	payload := map[string]any{
		"task_id": "t-help",
		"status":  "success",
		"metrics": map[string]any{"x": 1},
	}
	id, err := EnqueueTaskComplete(ctx, q, "t-help", payload)
	if err != nil {
		t.Fatal(err)
	}
	if id <= 0 {
		t.Fatalf("bad id: %d", id)
	}
	items, _ := q.Dequeue(ctx, 10)
	if len(items) != 1 {
		t.Fatalf("expected 1, got %d", len(items))
	}
	var got map[string]any
	if err := json.Unmarshal(items[0].Payload, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got["task_id"] != "t-help" {
		t.Fatalf("wrong task_id in payload: %v", got)
	}
}
