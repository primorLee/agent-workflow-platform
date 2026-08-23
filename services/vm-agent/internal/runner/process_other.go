//go:build !linux

package runner

import "os/exec"

// The public VM agent is Linux-oriented. Other targets retain direct-child
// termination so the package remains buildable for tooling and tests.
func prepareProcessTree(_ *exec.Cmd) {}

func killProcessTree(cmd *exec.Cmd) error {
	return cmd.Process.Kill()
}
