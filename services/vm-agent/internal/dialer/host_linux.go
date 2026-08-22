//go:build linux

package dialer

import (
	"golang.org/x/sys/unix"
)

func readKernel() string {
	var u unix.Utsname
	if err := unix.Uname(&u); err != nil {
		return ""
	}
	return cstr(u.Release[:])
}

func readDiskFreeKB(path string) int64 {
	if path == "" {
		path = "/"
	}
	var s unix.Statfs_t
	if err := unix.Statfs(path, &s); err != nil {
		return 0
	}
	return int64(s.Bavail) * int64(s.Bsize) / 1024
}

func cstr(b []byte) string {
	for i, c := range b {
		if c == 0 {
			return string(b[:i])
		}
	}
	return string(b)
}
