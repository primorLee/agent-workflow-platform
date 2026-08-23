//go:build linux

package runner

import (
	"os/exec"
	"syscall"
)

// prepareProcessTree isolates every task in its own process group. Both an
// explicit task cancellation and exec.CommandContext cancellation then remove
// descendants as well as the direct child.
func prepareProcessTree(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
	cmd.SysProcAttr.Pgid = 0
	if cmd.Cancel != nil {
		cmd.Cancel = func() error { return killProcessTree(cmd) }
	}
}

func killProcessTree(cmd *exec.Cmd) error {
	return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}
