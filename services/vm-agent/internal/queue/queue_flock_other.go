//go:build !linux && !darwin && !freebsd && !netbsd && !openbsd

package queue

import "os"

// Windows / unsupported OS — advisory lock is a no-op. Production agents
// run on Linux; this lets developers cross-compile on Windows without
// link errors. Two Windows dev processes writing the same queue.db would
// corrupt each other, but that's a non-scenario in prod.
func flockExclusive(f *os.File) error { return nil }

func flockUnlock(f *os.File) error { return nil }
