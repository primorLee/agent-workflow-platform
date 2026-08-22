//go:build windows

package dialer

// Windows is not a production target for awp-vm-agent (managed worker hosts are
// Linux). The stubs below let the package build on dev boxes so tests can
// exercise the wire protocol.

func readKernel() string { return "windows" }

func readDiskFreeKB(path string) int64 { return 0 }
