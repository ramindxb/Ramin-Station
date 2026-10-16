package updater

import (
	"os"
	"os/exec"
	"syscall"
)

func replaceFile(source, target string) error { return os.Rename(source, target) }
func ProcessAlive(pid int) bool               { return pid > 0 && syscall.Kill(pid, 0) == nil }
func Launch(target, job string) error {
	return exec.Command("/usr/bin/open", "-n", target, "--args", "--station-update-receipt", job).Run()
}
func StopApplication(target string) { /* Rollback never replaces a running application; a failed launch is handled by the caller. */
}
