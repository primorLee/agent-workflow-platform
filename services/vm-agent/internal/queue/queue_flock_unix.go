//go:build linux || darwin || freebsd || netbsd || openbsd

package queue

import (
	"fmt"
	"os"
	"syscall"
)

func flockExclusive(f *os.File) error {
	// Non-blocking: if another process holds the lock we fail fast with
	// ErrLocked rather than hanging in the systemd start path.
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if err == syscall.EWOULDBLOCK {
			return ErrLocked
		}
		return fmt.Errorf("queue: flock exclusive: %w", err)
	}
	return nil
}

func flockUnlock(f *os.File) error {
	return syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
}
