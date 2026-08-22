// Package replay owns the background goroutine that drains
// “pending_results“ rows from the offline queue back onto the wire
// once the dialer is authenticated.
//
// Protocol
// --------
//
// The replay frame is the same “task.complete“ envelope the runner
// emits live, with one addition: a “resume: true“ flag at the top of
// the payload so the broker's dedupe-via-idempotency logic can tell it
// apart from a first-time delivery in log output. Semantically it's
// exactly the same frame — the broker applies the existing idempotency
// rule from spec §5.5 (terminal state → cached response).
//
// Scheduling
// ----------
//
//   - Tick every “PollInterval“ (default 5s). When the dialer is not
//     authenticated, sleep until the next tick.
//   - Per tick, Dequeue up to “BatchSize“ (default 50) rows.
//   - Send each, in order, through the supplied “Sender.Send“ hook.
//   - On success → MarkUploaded.
//   - On failure (any error from Send) → MarkFailed with the error
//     message. MaxRetries (default 10) exhaustion moves the row to
//     “dropped“.
//
// Backpressure
// ------------
//
// Replay honours the dialer's “flow.pause“ / “flow.resume“ state
// via “FlowControl.Ready()“. If the broker is paused, the replayer
// stops claiming queued rows (leaves them in “queued“), waits for
// resume, then continues. Replay does NOT retry while paused — that
// would spin the CPU doing SQL churn for no wire egress.
//
// Exponential backoff
// -------------------
//
// When a batch sees N consecutive transient failures the poller
// extends its sleep up to 60s to avoid thrashing. Success resets the
// backoff to PollInterval.
package replay

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/primorLee/agent-workflow-platform/services/vm-agent/internal/queue"
)

// ---------------------------------------------------------------------------
// Collaborators — small interfaces so tests can swap in-memory fakes.
// ---------------------------------------------------------------------------

// Sender is what actually puts bytes on the wire. Typically implemented
// by the dialer.
type Sender interface {
	// Send transmits the provided task.complete envelope payload. Return
	// nil on broker-ack; any non-nil error is treated as transient
	// unless IsFatal returns true.
	Send(ctx context.Context, taskID string, payload []byte) error
}

// Authenticator reports whether the dialer is currently authenticated
// and able to receive replay frames.
type Authenticator interface {
	// IsAuthenticated should return true when the dialer state machine
	// is in ``authenticated`` or ``running``.
	IsAuthenticated() bool
}

// FlowControl is how the replayer asks "can I publish right now?"
// Pause / resume frames from the broker flip this flag.
type FlowControl interface {
	// Ready returns true when the broker has not signalled
	// ``flow.pause``. When false the replayer idles until the next tick.
	Ready() bool
}

// FatalChecker classifies errors from the Sender. Implementations that
// know their wire format can surface permanent-failure errors (e.g.
// 400-class from the broker) so the replayer drops immediately instead
// of burning retry budget.
type FatalChecker interface {
	IsFatal(err error) bool
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Config controls the replayer's scheduling.
type Config struct {
	// PollInterval — tick spacing when authenticated & ready. Default 5s.
	PollInterval time.Duration
	// BatchSize — max rows claimed per tick. Default 50.
	BatchSize int
	// MaxRetries — per-row attempt ceiling. Default 10.
	MaxRetries int
	// MaxBackoff — upper cap when backing off after consecutive failures.
	// Default 60s.
	MaxBackoff time.Duration
	// PruneEvery — how often Prune() runs alongside the regular poll.
	// Default 1h.
	PruneEvery time.Duration
	// TransitionTimeout bounds durable terminal writes and targeted batch
	// recovery, including time spent waiting for the queue writer lock.
	// Default 5s.
	TransitionTimeout time.Duration
	// Log — where to write slog events. Default slog.Default().
	Log *slog.Logger
}

// ---------------------------------------------------------------------------
// Replayer
// ---------------------------------------------------------------------------

type terminalKind uint8

const (
	terminalUploaded terminalKind = iota + 1
	terminalDropped
)

type pendingTerminal struct {
	kind   terminalKind
	id     int64
	reason string
}

// Replayer drains the offline queue in a goroutine started by Run.
type Replayer struct {
	q      *queue.Queue
	sender Sender
	auth   Authenticator
	flow   FlowControl
	fatal  FatalChecker
	cfg    Config
	log    *slog.Logger

	// Run owns these recovery fields. A failed terminal write is retried before
	// any new dequeue, then only the unsent IDs from that batch are re-queued.
	pendingTerminal *pendingTerminal
	pendingRequeue  []int64
	running         atomic.Bool

	// Metrics — atomic counters so the watchdog / /metrics endpoint can
	// read them without a mutex.
	uploaded atomic.Int64
	failed   atomic.Int64
	dropped  atomic.Int64
	ticks    atomic.Int64
	paused   atomic.Int64 // cumulative ticks skipped due to pause
}

// New constructs a Replayer. q, sender and auth must be non-nil; flow
// and fatal may be nil (treated as "always ready" / "all errors transient").
func New(
	q *queue.Queue, sender Sender, auth Authenticator,
	flow FlowControl, fatal FatalChecker, cfg Config,
) (*Replayer, error) {
	if q == nil {
		return nil, errors.New("replay: queue required")
	}
	if sender == nil {
		return nil, errors.New("replay: sender required")
	}
	if auth == nil {
		return nil, errors.New("replay: authenticator required")
	}
	if cfg.PollInterval <= 0 {
		cfg.PollInterval = 5 * time.Second
	}
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = 50
	}
	if cfg.MaxRetries <= 0 {
		cfg.MaxRetries = 10
	}
	if cfg.MaxBackoff <= 0 {
		cfg.MaxBackoff = 60 * time.Second
	}
	if cfg.PruneEvery <= 0 {
		cfg.PruneEvery = time.Hour
	}
	if cfg.TransitionTimeout <= 0 {
		cfg.TransitionTimeout = 5 * time.Second
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	return &Replayer{
		q:      q,
		sender: sender,
		auth:   auth,
		flow:   flow,
		fatal:  fatal,
		cfg:    cfg,
		log:    cfg.Log,
	}, nil
}

// ---------------------------------------------------------------------------
// Metrics — public for the watchdog / prometheus endpoint
// ---------------------------------------------------------------------------

// Metrics is a snapshot of the replayer's counters.
type Metrics struct {
	Uploaded    int64
	Failed      int64
	Dropped     int64
	Ticks       int64
	PausedTicks int64
}

// Metrics returns a copy of the current counters.
func (r *Replayer) Metrics() Metrics {
	return Metrics{
		Uploaded:    r.uploaded.Load(),
		Failed:      r.failed.Load(),
		Dropped:     r.dropped.Load(),
		Ticks:       r.ticks.Load(),
		PausedTicks: r.paused.Load(),
	}
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Run blocks until ctx is cancelled. Safe to call from its own goroutine.
//
// Run first finishes any externally final result still known in memory, then
// ReclaimUploading() rescues rows stranded by a prior process crash / kill-9.
func (r *Replayer) Run(ctx context.Context) error {
	if !r.running.CompareAndSwap(false, true) {
		return errors.New("replay: Run already active")
	}
	defer r.running.Store(false)

	// A restarted Run on the same Replayer still knows which externally final
	// result must be persisted. Complete that before crash-style reclamation.
	if err := r.recoverPending(ctx); err != nil {
		return fmt.Errorf("replay: recover pending before startup reclaim: %w", err)
	}
	if n, err := r.q.ReclaimUploading(ctx); err != nil {
		r.log.Warn("replay: reclaim failed", "err", err)
	} else if n > 0 {
		r.log.Info("replay: reclaimed stranded rows", "count", n)
	}

	interval := r.cfg.PollInterval
	backoff := interval
	lastPrune := time.Now()

	for {
		// Interruptible wait.
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(interval):
		}

		r.ticks.Add(1)

		// Local durability recovery must not depend on broker authentication or
		// flow-control state. Finish it before applying network gatekeepers.
		if err := r.recoverPending(ctx); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			r.log.Warn("replay: pending recovery error", "err", err)
			backoff *= 2
			if backoff > r.cfg.MaxBackoff {
				backoff = r.cfg.MaxBackoff
			}
			interval = backoff
			continue
		}
		if ctx.Err() != nil {
			return nil
		}

		// Gatekeepers: only attempt if the dialer is authenticated AND
		// the broker isn't signalling pause.
		if !r.auth.IsAuthenticated() {
			interval = r.cfg.PollInterval // reset
			continue
		}
		if r.flow != nil && !r.flow.Ready() {
			r.paused.Add(1)
			// Use configured poll interval when paused so we pick up the
			// resume quickly — don't apply transient-failure backoff on
			// cooperative pauses.
			interval = r.cfg.PollInterval
			continue
		}

		anyFailed, err := r.tick(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			r.log.Warn("replay: tick error", "err", err)
			// Treat infrastructure errors (SQLite unavailable etc.) like
			// transient upload failures — back off so we don't spin.
			anyFailed = true
		}

		if anyFailed {
			backoff *= 2
			if backoff > r.cfg.MaxBackoff {
				backoff = r.cfg.MaxBackoff
			}
			interval = backoff
		} else {
			backoff = r.cfg.PollInterval
			interval = r.cfg.PollInterval
		}

		// Periodic prune — cheap, runs alongside regular ticks.
		if time.Since(lastPrune) >= r.cfg.PruneEvery {
			if _, err := r.q.Prune(ctx); err != nil {
				r.log.Warn("replay: prune failed", "err", err)
			}
			lastPrune = time.Now()
		}
	}
}

func (r *Replayer) transitionContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), r.cfg.TransitionTimeout)
}

func (r *Replayer) applyTerminal(ctx context.Context, pending pendingTerminal) error {
	switch pending.kind {
	case terminalUploaded:
		return r.q.MarkUploaded(ctx, pending.id)
	case terminalDropped:
		return r.q.ForceDropped(ctx, pending.id, pending.reason)
	default:
		return fmt.Errorf("unknown terminal kind %d", pending.kind)
	}
}

func (r *Replayer) countTerminal(kind terminalKind) {
	switch kind {
	case terminalUploaded:
		r.uploaded.Add(1)
	case terminalDropped:
		r.dropped.Add(1)
	}
}

func itemIDs(items []*queue.QueuedItem, start int) []int64 {
	if start >= len(items) {
		return nil
	}
	ids := make([]int64, 0, len(items)-start)
	for _, item := range items[start:] {
		ids = append(ids, item.ID)
	}
	return ids
}

// recoverPending completes a previously observed external terminal result
// before any new send. Only after that succeeds are the unsent rows from the
// same claimed batch returned to queued state.
func (r *Replayer) recoverPending(ctx context.Context) error {
	if r.pendingTerminal == nil && len(r.pendingRequeue) == 0 {
		return nil
	}
	transitionCtx, cancel := r.transitionContext(ctx)
	defer cancel()
	if r.pendingTerminal != nil {
		if err := r.applyTerminal(transitionCtx, *r.pendingTerminal); err != nil {
			return fmt.Errorf("persist pending terminal: %w", err)
		}
		r.countTerminal(r.pendingTerminal.kind)
		r.pendingTerminal = nil
	}
	if len(r.pendingRequeue) > 0 {
		if err := r.q.RequeueUploading(transitionCtx, r.pendingRequeue); err != nil {
			return fmt.Errorf("requeue pending batch: %w", err)
		}
		r.pendingRequeue = nil
	}
	return nil
}

func (r *Replayer) persistTerminal(ctx context.Context, pending pendingTerminal) error {
	transitionCtx, cancel := r.transitionContext(ctx)
	defer cancel()
	return r.applyTerminal(transitionCtx, pending)
}

func (r *Replayer) requeueItems(ctx context.Context, ids []int64) error {
	transitionCtx, cancel := r.transitionContext(ctx)
	defer cancel()
	return r.q.RequeueUploading(transitionCtx, ids)
}

// tick claims up to BatchSize rows and sends each through the Sender.
// Returns anyFailed=true if at least one row saw a transient failure.
func (r *Replayer) tick(ctx context.Context) (bool, error) {
	if err := r.recoverPending(ctx); err != nil {
		return true, fmt.Errorf("recover pending replay state: %w", err)
	}
	items, err := r.q.Dequeue(ctx, r.cfg.BatchSize)
	if err != nil {
		return false, fmt.Errorf("dequeue: %w", err)
	}
	if len(items) == 0 {
		return false, nil
	}

	anyFailed := false
	for index, item := range items {
		if ctx.Err() != nil {
			ids := itemIDs(items, index)
			if err := r.requeueItems(ctx, ids); err != nil {
				r.pendingRequeue = ids
			}
			return anyFailed, ctx.Err()
		}
		// Re-check the pause flag per item. Return exactly the current and
		// remaining claimed rows without consuming their retry budgets.
		if r.flow != nil && !r.flow.Ready() {
			ids := itemIDs(items, index)
			r.log.Info("replay: flow paused mid-batch, returning unsent items",
				"remaining", len(ids))
			if err := r.requeueItems(ctx, ids); err != nil {
				r.pendingRequeue = ids
				return true, fmt.Errorf("requeue paused batch: %w", err)
			}
			return anyFailed, nil
		}

		payload := decorateResume(item.Payload)
		err := r.sender.Send(ctx, item.TaskID, payload)
		if err == nil {
			pending := pendingTerminal{kind: terminalUploaded, id: item.ID}
			if markErr := r.persistTerminal(ctx, pending); markErr != nil {
				r.pendingTerminal = &pending
				r.pendingRequeue = itemIDs(items, index+1)
				return true, fmt.Errorf("persist broker acknowledgement: %w", markErr)
			}
			r.countTerminal(pending.kind)
			continue
		}

		// Classify: fatal means immediate drop; transient means retry.
		if r.fatal != nil && r.fatal.IsFatal(err) {
			r.log.Warn("replay: fatal error, dropping row",
				"id", item.ID, "err", err)
			pending := pendingTerminal{
				kind: terminalDropped, id: item.ID, reason: err.Error(),
			}
			if dropErr := r.persistTerminal(ctx, pending); dropErr != nil {
				r.pendingTerminal = &pending
				r.pendingRequeue = itemIDs(items, index+1)
				return true, fmt.Errorf("persist fatal rejection: %w", dropErr)
			}
			r.countTerminal(pending.kind)
			continue
		}

		anyFailed = true
		r.failed.Add(1)
		if markErr := r.q.MarkFailed(ctx, item.ID, err.Error(),
			r.cfg.MaxRetries); markErr != nil {
			// The send was not accepted, so returning this item and all later
			// claimed rows to queued is safe. Same-state or terminal rows are
			// idempotent no-ops if the failed commit actually took effect.
			r.pendingRequeue = itemIDs(items, index)
			return true, fmt.Errorf("persist transient failure: %w", markErr)
		}
		// If that mark pushed the row into dropped state, record it.
		if item.RetryCount+1 >= r.cfg.MaxRetries {
			r.dropped.Add(1)
		}
	}
	return anyFailed, nil
}

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

// decorateResume mutates the JSON payload to add “resume: true“ at the
// top level. If the payload isn't a JSON object (shouldn't happen for
// task.complete) we return it unchanged — the broker will still accept
// it, we just skip the hint.
func decorateResume(raw []byte) []byte {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return raw
	}
	m["resume"] = true
	out, err := json.Marshal(m)
	if err != nil {
		return raw
	}
	return out
}

// EnqueueTaskComplete is the canonical way the runner hands off a
// task.complete payload to the offline queue. It centralises the JSON
// marshal + Enqueue pair so the runner doesn't need to import both
// packages directly at the call site.
func EnqueueTaskComplete(
	ctx context.Context, q *queue.Queue, taskID string, payload any,
) (int64, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return 0, fmt.Errorf("replay: marshal complete: %w", err)
	}
	return q.Enqueue(ctx, taskID, raw)
}
