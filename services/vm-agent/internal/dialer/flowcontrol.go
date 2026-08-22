// Flow-control state for the dialer: pause / resume signalling from the
// broker (see ``cloud/broker_v2_backpressure.py``).
//
// When the broker signals ``flow.pause`` the agent MUST suspend new
// task pulls AND replay uploads for ``retry_after_s`` (or until an
// explicit ``flow.resume``, whichever comes first). When it signals
// ``flow.resume`` the agent resumes both.
//
// We model this as a tiny atomic state machine the rest of the agent
// can query via two public methods:
//
//   - (*Dialer).FlowReady() bool — used by the replayer's Ready() hook
//     and by any dispatcher asking "may I pull new work?"
//   - (*Dialer).IsAuthenticated() bool — convenience for the replayer's
//     Authenticator interface.
//
// Exported as small adapter types at the bottom of the file so callers
// don't need to reach into dialer internals.

package dialer

import (
	"encoding/json"
	"log/slog"
	"sync/atomic"
	"time"
)

// ---------------------------------------------------------------------------
// Flow-control state on Dialer
// ---------------------------------------------------------------------------
//
// We attach a single atomic pointer (to an fcState struct) so both the
// reader goroutine and the replayer goroutine can inspect state without
// locks. Pointer semantics let us swap the whole snapshot on each
// pause/resume transition.

type fcState struct {
	paused         bool
	reason         string
	resumeDeadline time.Time // absolute wall-clock; zero means "until explicit resume"
	updated        time.Time
}

// flowCtl is the storage slot on Dialer. We put the helper on a file
// that's kept small so the giant dialer.go doesn't need to grow.
type flowCtl struct {
	state atomic.Pointer[fcState]
}

func (f *flowCtl) snapshot() fcState {
	s := f.state.Load()
	if s == nil {
		return fcState{}
	}
	return *s
}

func (f *flowCtl) isPaused() bool {
	s := f.snapshot()
	if !s.paused {
		return false
	}
	// Auto-resume once the broker-hinted deadline elapses, even if no
	// flow.resume arrives. Prevents a single dropped resume frame from
	// wedging the agent.
	if !s.resumeDeadline.IsZero() && time.Now().After(s.resumeDeadline) {
		return false
	}
	return true
}

func (f *flowCtl) setPause(reason string, retryAfterS float64) {
	deadline := time.Time{}
	if retryAfterS > 0 {
		deadline = time.Now().Add(time.Duration(retryAfterS * float64(time.Second)))
	}
	f.state.Store(&fcState{
		paused:         true,
		reason:         reason,
		resumeDeadline: deadline,
		updated:        time.Now(),
	})
}

func (f *flowCtl) setResume() {
	f.state.Store(&fcState{paused: false, updated: time.Now()})
}

// ---------------------------------------------------------------------------
// Public adapters on Dialer
// ---------------------------------------------------------------------------

// FlowReady reports whether the broker has NOT signalled a pause (or if
// any previous pause has expired). Safe to call from any goroutine.
//
// Before the first frame the Dialer is considered ready — we don't pause
// by default. Agents that haven't yet authenticated have IsAuthenticated
// gated separately.
func (d *Dialer) FlowReady() bool {
	return !d.flow.isPaused()
}

// IsAuthenticated reports whether the state machine is currently in
// authenticated or running states.
func (d *Dialer) IsAuthenticated() bool {
	s := d.State()
	return s == StateAuthenticated || s == StateRunning
}

// ---------------------------------------------------------------------------
// Frame handlers
// ---------------------------------------------------------------------------

// handleFlowPause is called from the reader loop when a “flow.pause“
// envelope arrives. Public so integration tests can simulate broker
// signals without round-tripping a real WebSocket.
type flowPausePayload struct {
	Reason      string  `json:"reason"`
	RetryAfterS float64 `json:"retry_after_s"`
	QueueDepth  int     `json:"queue_depth"`
	Threshold   int     `json:"threshold"`
	SinceTS     float64 `json:"since_ts"`
}

type flowResumePayload struct {
	TS         float64 `json:"ts"`
	QueueDepth int     `json:"queue_depth"`
}

// HandleFlowFrame parses & applies a flow.pause / flow.resume envelope.
// Exposed for tests and for a future broker-message dispatcher.
func (d *Dialer) HandleFlowFrame(frameType string, payload []byte,
	log *slog.Logger) {
	if log == nil {
		log = d.log
	}
	switch frameType {
	case "flow.pause":
		var p flowPausePayload
		if err := json.Unmarshal(payload, &p); err != nil {
			log.Warn("flow.pause: bad payload", "err", err)
			// Default to a conservative short pause so we don't get
			// stuck on a malformed frame.
			d.flow.setPause("unknown", 5.0)
			return
		}
		d.flow.setPause(p.Reason, p.RetryAfterS)
		log.Info("flow.pause received",
			"reason", p.Reason,
			"retry_after_s", p.RetryAfterS,
			"queue_depth", p.QueueDepth,
			"threshold", p.Threshold,
		)
	case "flow.resume":
		var p flowResumePayload
		// Ignore parse errors — the resume is action, not data.
		_ = json.Unmarshal(payload, &p)
		d.flow.setResume()
		log.Info("flow.resume received", "queue_depth", p.QueueDepth)
	}
}
