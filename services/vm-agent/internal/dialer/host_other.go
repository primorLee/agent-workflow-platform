//go:build !linux && !darwin && !windows

package dialer

func readKernel() string               { return "" }
func readDiskFreeKB(path string) int64 { return 0 }
