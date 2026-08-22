// Command awp-vm-agent is the VM-side task runner for Agent Workflow Platform.
//
// It dials outbound `ws://127.0.0.1:8100/agent/connect` (or whatever
// server_url is configured), authenticates with an API key, and waits for
// task envelopes from the broker. Tasks are executed as child processes
// through an explicit allowlist, with stdout/stderr streamed back as
// progress frames.
//
// Design notes:
//   - Single static binary. No CGO, no dlopen, no runtime deps.
//   - Outbound-only. The VM never opens a listening socket.
//   - Crash evidence. Top-level panics are serialised to the local work
//     directory for operator inspection; the public dialer does not upload it.
//   - Graceful shutdown. SIGTERM / SIGINT drain running tasks up to
//     config.ShutdownTimeout, then exit.
//   - Self-watchdog. Separate goroutine kicks the process with os.Exit(42)
//     if the dispatcher loop is wedged, so systemd Restart=always respawns.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"syscall"
	"time"

	"github.com/primorLee/agent-workflow-platform/services/vm-agent/internal/config"
	"github.com/primorLee/agent-workflow-platform/services/vm-agent/internal/dialer"
	"github.com/primorLee/agent-workflow-platform/services/vm-agent/internal/runner"
	"github.com/primorLee/agent-workflow-platform/services/vm-agent/internal/watchdog"
	"gopkg.in/natefinch/lumberjack.v2"
)

// Version is stamped by -ldflags at build time.
//
//	go build -ldflags "-X main.Version=0.1.0-alpha.0 -X main.Commit=$(git rev-parse --short HEAD)"
var (
	Version = "0.0.0-dev"
	Commit  = "unknown"
	Date    = "unknown"
)

func main() {
	var (
		configPath  = flag.String("config", defaultConfigPath(), "path to config YAML")
		showVersion = flag.Bool("version", false, "print version and exit")
		daemon      = flag.Bool("daemon", false, "run in daemon mode (suppress console log, use logfile)")
	)
	flag.Parse()

	if *showVersion {
		fmt.Printf("awp-vm-agent %s (commit %s, built %s)\n", Version, Commit, Date)
		os.Exit(0)
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "awp-vm-agent: load config %q: %v\n", *configPath, err)
		os.Exit(2)
	}

	logger := newLogger(cfg, *daemon)
	slog.SetDefault(logger)

	// Capture the top-level panic so we do not lose the goroutine trace when
	// systemd reads only the last line of stderr. The report stays local.
	defer func() {
		if r := recover(); r != nil {
			writeCrashReport(cfg, r, debug.Stack())
			logger.Error("fatal panic", "panic", fmt.Sprint(r))
			os.Exit(3)
		}
	}()

	logger.Info("awp-vm-agent starting",
		"version", Version,
		"commit", Commit,
		"config", *configPath,
		"agent_name", cfg.AgentName,
		"server_url", cfg.ServerURL,
	)

	// Root context cancelled on SIGTERM / SIGINT. All long-running goroutines
	// must honour it.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Self-watchdog. If Kick() isn't called for >60s the process self-exits
	// with code 42 and systemd (Restart=always) brings us back.
	wd := watchdog.New(60*time.Second, logger.With("comp", "watchdog"))
	go wd.Run(ctx)

	// Publish -ldflags version to the dialer so hello frames carry it.
	dialer.SetAgentVersion(Version)

	// Dialer owns the WSS connection, reconnect loop, and task dispatch.
	// It calls wd.Kick() on every heartbeat so the watchdog stays quiet.
	d := dialer.New(cfg, logger.With("comp", "dialer"), wd.Kick)
	d.SetExecutor(runner.New(logger.With("comp", "runner")))

	exitCode := 0
	if err := d.Run(ctx); err != nil && ctx.Err() == nil {
		logger.Error("dialer exited with error", "err", err)
		exitCode = 1
	}
	// Spec §4.5 / §9: broker may demand upgrade; systemd unit has
	// RestartPreventExitStatus=77 and stops respawning on that code.
	if ec := d.ExitCode(); ec != 0 {
		exitCode = ec
	}

	// Drain window — let dialer finish in-flight task reports.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := d.Shutdown(shutdownCtx); err != nil {
		logger.Warn("shutdown drain exceeded timeout", "err", err)
	}

	logger.Info("awp-vm-agent stopped", "exit_code", exitCode)
	os.Exit(exitCode)
}

func defaultConfigPath() string {
	// systemd install drops the config here. For dev, users pass --config.
	return "/etc/awp-vm-agent/config.yaml"
}

// newLogger returns a structured JSON logger. In daemon mode output goes to
// a rotated file; otherwise to stderr.
func newLogger(cfg *config.Config, daemon bool) *slog.Logger {
	var w io.Writer = os.Stderr
	if daemon && cfg.LogFile != "" {
		w = &lumberjack.Logger{
			Filename:   cfg.LogFile,
			MaxSize:    50, // MB
			MaxBackups: 5,
			MaxAge:     14, // days
			Compress:   true,
		}
	}
	level := slog.LevelInfo
	_ = level.UnmarshalText([]byte(cfg.LogLevel))
	return slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{
		Level:     level,
		AddSource: false,
	})).With("agent", cfg.AgentName)
}

// writeCrashReport serialises a panic to work_dir/crash/<ts>.log for local
// operator inspection.
func writeCrashReport(cfg *config.Config, reason any, stack []byte) {
	if cfg == nil || cfg.WorkDir == "" {
		return
	}
	dir := filepath.Join(cfg.WorkDir, "crash")
	if err := os.MkdirAll(dir, 0o750); err != nil {
		fmt.Fprintln(os.Stderr, "crash report mkdir:", err)
		return
	}
	name := filepath.Join(dir, fmt.Sprintf("panic-%s.log", time.Now().UTC().Format("20060102T150405Z")))
	body := fmt.Sprintf("version=%s commit=%s\npanic=%v\n\n%s\n", Version, Commit, reason, stack)
	_ = os.WriteFile(name, []byte(body), 0o640)
}
