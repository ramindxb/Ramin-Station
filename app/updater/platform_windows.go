package updater

import (
	"os/exec"
	"syscall"
	"unsafe"
)

var kernel = syscall.NewLazyDLL("kernel32.dll")

func replaceFile(source, target string) error {
	from, e1 := syscall.UTF16PtrFromString(source)
	to, e2 := syscall.UTF16PtrFromString(target)
	if e1 != nil {
		return e1
	}
	if e2 != nil {
		return e2
	}
	ok, _, err := kernel.NewProc("MoveFileExW").Call(uintptr(unsafe.Pointer(from)), uintptr(unsafe.Pointer(to)), 0x1|0x8)
	if ok == 0 {
		return err
	}
	return nil
}
func ProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	handle, _, _ := kernel.NewProc("OpenProcess").Call(0x1000, 0, uintptr(pid))
	if handle == 0 {
		return false
	}
	defer kernel.NewProc("CloseHandle").Call(handle)
	var code uint32
	ok, _, _ := kernel.NewProc("GetExitCodeProcess").Call(handle, uintptr(unsafe.Pointer(&code)))
	return ok != 0 && code == 259
}
func Launch(target, job string) error {
	command := exec.Command(target, "--station-update-receipt", job)
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}
func StopApplication(target string) {}
