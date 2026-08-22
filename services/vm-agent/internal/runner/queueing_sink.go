// Queueing progress-sink — fall-back path that persists task.complete
// envelopes to the offline queue when the online sink rejects them.
//
// This is how we keep the "agent NEVER loses a task result" contract:
// if the dialer is disconnected, OR the broker responds with a retryable
// error, OR any transient wire issue — we commit to SQLite and let the
// replayer drain when the connection comes back. Only then do we
// consider the task "done" from the runner's point of view.

package runner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"

	"github.com/primorLee/agent-workflow-platform/services/vm-agent/internal/protocol"
	"github.com/primorLee/agent-workflow-platform/services/vm-agent/internal/queue"
)

// ---------------------------------------------------------------------------
// Retryable classification
// ---------------------------------------------------------------------------

// ErrRetryable is returned (wrapped via Retryable) from the online sink
// when the broker responded with a retryable error (e.g. 5xx, ack
// timeout). The adapter's strategy is:
//
//	nil            → online path succeeded, nothing to do.
//	ErrRetryable   → enqueue locally and return success to the runner.
//	other          → enqueue locally (we err on the side of preservation)
//	                 but also log the underlying error.
//
// The adapter deliberately conflates "connection down" and "broker 5xx"
// into the same action: persist. Differentiation lives in the replayer.
var ErrRetryable = errors.New("retryable")

// Retryable wraps err with an ErrRetryable sentinel.
func Retryable(err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%w: %v", ErrRetryable, err)
}

// IsRetryable reports whether err was tagged via Retryable().
func IsRetryable(err error) bool { return errors.Is(err, ErrRetryable) }

// ---------------------------------------------------------------------------
// Queueing sink
// ---------------------------------------------------------------------------

// OnlineSink is the upstream dialer sink interface — a minimal mirror
// of dialer.TaskSink so this package doesn't import dialer (and create
// a cycle).
type OnlineSink interface {
	SendProgress(p *protocol.TaskProgressPayload) error
	SendComplete(c *protocol.TaskCompletePayload) error
	SendError(e *protocol.ErrorPayload) error
	SendLog(l *protocol.LogChunkPayload) error
}

// QueueingSink wraps an OnlineSink with an SQLite fallback for Complete
// and Error frames. Progress / Log frames are best-effort — they're
// advisory per spec §5.3, so dropping them on network blip is
// acceptable (the replayed Complete frame carries the final outcome).
type QueueingSink struct {
	Online OnlineSink
	Queue  *queue.Queue
	Log    *slog.Logger
}

// NewQueueingSink constructs a sink. online may be nil (everything
// diverts to queue) but q MUST be non-nil.
func NewQueueingSink(online OnlineSink, q *queue.Queue,
	log *slog.Logger) *QueueingSink {
	if log == nil {
		log = slog.Default()
	}
	return &QueueingSink{Online: online, Queue: q, Log: log}
}

// SendProgress forwards to the online sink. Errors are logged and
// dropped — progress is advisory.
func (s *QueueingSink) SendProgress(p *protocol.TaskProgressPayload) error {
	if s.Online == nil {
		return nil
	}
	if err := s.Online.SendProgress(p); err != nil {
		s.Log.Debug("queueing sink: drop progress", "err", err,
			"task_id", p.TaskID, "seq", p.Seq)
	}
	return nil
}

// SendLog mirrors SendProgress — best-effort, dropped on wire failure.
func (s *QueueingSink) SendLog(l *protocol.LogChunkPayload) error {
	if s.Online == nil {
		return nil
	}
	if err := s.Online.SendLog(l); err != nil {
		s.Log.Debug("queueing sink: drop log", "err", err,
			"task_id", l.TaskID, "seq", l.Seq)
	}
	return nil
}

// SendComplete tries the online path first; on any error (retryable or
// not) persists the envelope to the offline queue. Returns nil to the
// runner in both branches — the durability guarantee is "the frame is
// either on the wire or on disk".
//
// Never returns the underlying online error: swallowing is intentional
// so runner cleanup proceeds (kill child PIDs, free slot).
func (s *QueueingSink) SendComplete(c *protocol.TaskCompletePayload) error {
	if c == nil {
		return errors.New("queueing sink: nil complete")
	}
	if s.Online != nil {
		err := s.Online.SendComplete(c)
		if err == nil {
			return nil
		}
		s.Log.Warn("queueing sink: online complete failed, enqueuing",
			"err", err, "task_id", c.TaskID,
			"retryable", IsRetryable(err))
	}
	return s.enqueueComplete(c)
}

// SendError mirrors SendComplete semantics — we treat broker-delivered
// error frames as terminal-state events, so we persist on wire failure
// to retain the audit trail.
func (s *QueueingSink) SendError(e *protocol.ErrorPayload) error {
	if e == nil {
		return errors.New("queueing sink: nil error")
	}
	if s.Online != nil {
		if err := s.Online.SendError(e); err == nil {
			return nil
		}
	}
	// Packaged as a synthetic Complete(status=error) so the replayer
	// uses the same code path. Idempotency is by (task_id, sha256) so
	// duplicates coalesce if the runner ALSO emits a proper Complete.
	raw, err := json.Marshal(map[string]any{
		"task_id": e.TaskID,
		"status":  "error",
		"error": map[string]any{
			"code":      e.Code,
			"message":   e.Message,
			"retryable": e.Retryable,
		},
	})
	if err != nil {
		return fmt.Errorf("queueing sink: marshal synthetic: %w", err)
	}
	_, enqErr := s.Queue.Enqueue(context.Background(), e.TaskID, raw)
	if enqErr != nil {
		s.Log.Error("queueing sink: enqueue failed — DATA LOSS RISK",
			"err", enqErr, "task_id", e.TaskID)
		return enqErr
	}
	return nil
}

// enqueueComplete serialises the Complete envelope and persists to the
// offline queue. Errors here are logged loudly because they break the
// durability contract.
func (s *QueueingSink) enqueueComplete(c *protocol.TaskCompletePayload) error {
	// Shape mirrors the on-wire task.complete payload so the replayer
	// can just wrap it in an envelope header and push.
	raw, err := json.Marshal(map[string]any{
		"task_id":      c.TaskID,
		"status":       c.Status,
		"metrics":      c.Metrics,
		"duration_s":   c.DurationSec,
		"artifacts":    c.Artifacts,
		"error":        c.Error,
		"completed_at": c.CompletedAt,
	})
	if err != nil {
		return fmt.Errorf("queueing sink: marshal complete: %w", err)
	}
	_, err = s.Queue.Enqueue(context.Background(), c.TaskID, raw)
	if err != nil {
		s.Log.Error("queueing sink: enqueue failed — DATA LOSS RISK",
			"err", err, "task_id", c.TaskID)
		return err
	}
	s.Log.Info("queueing sink: persisted complete to offline queue",
		"task_id", c.TaskID, "status", c.Status)
	return nil
}
