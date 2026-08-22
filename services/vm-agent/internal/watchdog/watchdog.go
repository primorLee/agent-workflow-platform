// Package watchdog runs a self-kick goroutine that kills the process if the
// main dispatcher loop stops calling Kick().
//
// Rationale: any lock-free system eventually wedges. Go's race detector and
// defer-based cleanup catch *most* livelocks, but a corrupt pipe, a buggy
// syscall, or a third-party library doing `for {}` will silently take the
// agent offline. Rather than babysit every goroutine, we let systemd do what
// it's good at: restart us fast.
//
// Behaviour:
//   - Kick() is called by the dialer on every heartbeat (default 15s) and on
//     every successful frame read/write.
//   - Run() tickers at 10s; if the last Kick is older than `deadline`, we
//     log at ERROR and call os.Exit(42).
//   - systemd's Restart=always, RestartSec=5 ensures we're back inside 10s.
package watchdog

import (
	"context"
	"log/slog"
	"os"
	"sync/atomic"
	"time"
)

// ExitCode is the process exit code used when the watchdog fires. Chosen to
// be distinct from the "normal error" exit (1) and the "bad config" exit (2)
// so operators grepping journalctl can spot it quickly.
const ExitCode = 42

// Watchdog watches for dispatcher liveness.
type Watchdog struct {
	deadline time.Duration
	last     atomic.Int64 // unix nanos of last Kick
	log      *slog.Logger
	// exit is overridable for tests.
	exit func(int)
}

// New creates a Watchdog that fires if Kick isn't called for `deadline`.
// Recommended deadline: ≥ 3 × heartbeat_interval.
func New(deadline time.Duration, log *slog.Logger) *Watchdog {
	wd := &Watchdog{
		deadline: deadline,
		log:      log,
		exit:     os.Exit,
	}
	wd.Kick() // prime so we don't fire before the first dial attempt
	return wd
}

// Kick records liveness. Safe for concurrent use.
func (w *Watchdog) Kick() {
	w.last.Store(time.Now().UnixNano())
}

// Run blocks until ctx is cancelled or the deadline is breached (in which
// case it exits the process).
func (w *Watchdog) Run(ctx context.Context) {
	tickEvery := w.deadline / 6
	if tickEvery < time.Second {
		tickEvery = time.Second
	}
	if tickEvery > 10*time.Second {
		tickEvery = 10 * time.Second
	}
	t := time.NewTicker(tickEvery)
	defer t.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			last := time.Unix(0, w.last.Load())
			age := now.Sub(last)
			if age > w.deadline {
				w.log.Error("watchdog fired — dispatcher wedged",
					"last_kick", last.Format(time.RFC3339Nano),
					"age", age.String(),
					"deadline", w.deadline.String(),
					"exit_code", ExitCode,
				)
				w.exit(ExitCode)
				return
			}
		}
	}
}
