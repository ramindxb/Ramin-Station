package updater

import (
	"archive/zip"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"time"
)

type Plan struct {
	Job       string `json:"job"`
	Target    string `json:"target"`
	Staged    string `json:"staged"`
	Backup    string `json:"backup"`
	Nonce     string `json:"nonce"`
	Build     int    `json:"build"`
	ParentPID int    `json:"parentPID"`
}
type Receipt struct {
	Nonce  string `json:"nonce"`
	Build  int    `json:"build"`
	PID    int    `json:"pid"`
	Target string `json:"target"`
}

func randomID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func validJob(id string) bool { b, err := hex.DecodeString(id); return err == nil && len(b) == 16 }
func noSymlink(file string) error {
	info, err := os.Lstat(file)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return errors.New("symbolic links are not allowed in update paths")
	}
	return nil
}
func writeJSON(file string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(file, data)
}
func extract(archive, destination string) error {
	reader, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer reader.Close()
	if len(reader.File) > 20000 {
		return errors.New("update archive contains too many files")
	}
	var total uint64
	seen := map[string]bool{}
	for _, entry := range reader.File {
		name := entry.Name
		if strings.HasPrefix(name, "__MACOSX/") {
			continue
		}
		if name == "" || strings.ContainsAny(name, "\\:\x00") || strings.HasPrefix(name, "/") || strings.HasPrefix(path.Clean(name), "../") || path.Clean(name) == ".." || path.Clean(name) != strings.TrimSuffix(name, "/") || entry.Mode()&os.ModeSymlink != 0 {
			return errors.New("unsafe path in update archive")
		}
		key := strings.ToLower(strings.TrimSuffix(name, "/"))
		if seen[key] {
			return errors.New("duplicate update archive path")
		}
		seen[key] = true
		if entry.UncompressedSize64 > (1<<30)-total {
			return errors.New("expanded update is too large")
		}
		total += entry.UncompressedSize64
		output := filepath.Join(destination, filepath.FromSlash(name))
		relative, err := filepath.Rel(destination, output)
		if err != nil || strings.HasPrefix(relative, "..") {
			return errors.New("unsafe update destination")
		}
		if entry.FileInfo().IsDir() {
			if err = os.MkdirAll(output, 0700); err != nil {
				return err
			}
			continue
		}
		if !entry.Mode().IsRegular() {
			return errors.New("special files are not allowed in updates")
		}
		if err = os.MkdirAll(filepath.Dir(output), 0700); err != nil {
			return err
		}
		input, err := entry.Open()
		if err != nil {
			return err
		}
		mode := os.FileMode(0600)
		if entry.Mode()&0111 != 0 {
			mode = 0700
		}
		file, err := os.OpenFile(output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
		if err != nil {
			_ = input.Close()
			return err
		}
		n, copyErr := io.Copy(file, io.LimitReader(input, int64(entry.UncompressedSize64)+1))
		closeErr := file.Close()
		_ = input.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		if uint64(n) != entry.UncompressedSize64 {
			return errors.New("invalid update archive size")
		}
	}
	return nil
}
func copyTree(source, target string) error {
	return filepath.Walk(source, func(file string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return errors.New("update contains a symbolic link")
		}
		relative, err := filepath.Rel(source, file)
		if err != nil {
			return err
		}
		destination := filepath.Join(target, relative)
		if info.IsDir() {
			return os.Mkdir(destination, 0700)
		}
		if !info.Mode().IsRegular() {
			return errors.New("invalid update file")
		}
		input, err := os.Open(file)
		if err != nil {
			return err
		}
		defer input.Close()
		output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, info.Mode().Perm())
		if err != nil {
			return err
		}
		_, err = io.Copy(output, input)
		closeErr := output.Close()
		if err != nil {
			return err
		}
		return closeErr
	})
}
func (m *Manager) validateTarget(target string) error {
	if !filepath.IsAbs(target) {
		return errors.New("application location must be absolute")
	}
	if err := noSymlink(target); err != nil {
		return err
	}
	canonical, err := filepath.EvalSymlinks(target)
	if err != nil || !strings.EqualFold(filepath.Clean(canonical), filepath.Clean(target)) {
		return errors.New("application location is not safe to replace")
	}
	if m.Platform == "macos" && !strings.HasSuffix(target, ".app") {
		return errors.New("move the application to a writable folder before updating")
	}
	if m.Platform == "windows" && !strings.EqualFold(filepath.Base(target), "Ramin Station.exe") {
		return errors.New("the application filename must remain Ramin Station.exe")
	}
	// Probe the actual parent before downloading anything; no privilege escalation.
	probe, err := os.CreateTemp(filepath.Dir(target), ".station-write-test-*")
	if err != nil {
		return errors.New("this application folder is read-only; move the app to a writable folder before updating")
	}
	name := probe.Name()
	_ = probe.Close()
	_ = os.Remove(name)
	return nil
}
func (m *Manager) validateMac(bundle string, manifest Manifest) error {
	value := func(key string) (string, error) {
		data, err := exec.Command("/usr/libexec/PlistBuddy", "-c", "Print :"+key, filepath.Join(bundle, "Contents", "Info.plist")).Output()
		return strings.TrimSpace(string(data)), err
	}
	identifier, err := value("CFBundleIdentifier")
	if err != nil || identifier != m.Config.BundleID {
		return errors.New("update application identity does not match")
	}
	build, err := value("CFBundleVersion")
	if err != nil || build != fmt.Sprint(manifest.Build) {
		return errors.New("update application build does not match")
	}
	next, err := ReadConfig(filepath.Join(bundle, "Contents", "Resources", "app", "update-config.json"))
	if err != nil || next.Build != manifest.Build || next.Version != manifest.Version || next.PublicKey != m.Config.PublicKey {
		return errors.New("update configuration does not match the signed release")
	}
	if output, err := exec.Command("/usr/bin/codesign", "--verify", "--deep", "--strict", bundle).CombinedOutput(); err != nil {
		return fmt.Errorf("application signature validation failed: %s", strings.TrimSpace(string(output)))
	}
	return nil
}
func (m *Manager) Prepare(ctx context.Context, target string, parentPID int, event func(Event)) (Plan, error) {
	var plan Plan
	if err := m.validateTarget(target); err != nil {
		return plan, err
	}
	data, manifest, err := m.cached()
	if err != nil || manifest.Build <= m.Config.Build {
		return plan, errors.New("no verified newer update is available; check for updates first")
	}
	root, err := m.root()
	if err != nil {
		return plan, err
	}
	job := randomID()
	directory := filepath.Join(root, "jobs", job)
	if err = os.MkdirAll(filepath.Dir(directory), 0700); err != nil {
		return plan, err
	}
	if err = os.Mkdir(directory, 0700); err != nil {
		return plan, err
	}
	success := false
	defer func() {
		if !success {
			_ = os.RemoveAll(directory)
		}
	}()
	if err = atomicWrite(filepath.Join(directory, "release.json"), data); err != nil {
		return plan, err
	}
	archive := filepath.Join(directory, "package.zip")
	if err = m.download(ctx, manifest.Packages[m.Platform], archive, event); err != nil {
		return plan, err
	}
	event(Event{"verify", 88, "Verifying and preparing the update…", ""})
	expanded := filepath.Join(directory, "expanded")
	if err = os.Mkdir(expanded, 0700); err != nil {
		return plan, err
	}
	if err = extract(archive, expanded); err != nil {
		return plan, err
	}
	staged := filepath.Join(filepath.Dir(target), ".station-update-"+job+filepath.Ext(target))
	if m.Platform == "macos" {
		source := filepath.Join(expanded, "Ramin Station.app")
		if err = m.validateMac(source, manifest); err != nil {
			return plan, err
		}
		if err = copyTree(source, staged); err != nil {
			_ = os.RemoveAll(staged)
			return plan, err
		}
	} else {
		source := filepath.Join(expanded, "Ramin Station.exe")
		file, openErr := os.Open(source)
		if openErr != nil {
			return plan, openErr
		}
		header := make([]byte, 2)
		_, openErr = io.ReadFull(file, header)
		_ = file.Close()
		if openErr != nil || string(header) != "MZ" {
			return plan, errors.New("invalid Windows update executable")
		}
		input, err := os.Open(source)
		if err != nil {
			return plan, err
		}
		defer input.Close()
		output, err := os.OpenFile(staged, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0700)
		if err != nil {
			return plan, err
		}
		_, err = io.Copy(output, input)
		closeErr := output.Close()
		if err != nil {
			_ = os.Remove(staged)
			return plan, err
		}
		if closeErr != nil {
			_ = os.Remove(staged)
			return plan, closeErr
		}
	}
	stagedOK := false
	defer func() {
		if !stagedOK {
			_ = os.RemoveAll(staged)
		}
	}()
	// Library media is outside the app. Back up its small index, never move or delete the library.
	index := filepath.Join(m.DataRoot, "visual-brain.json")
	if _, err = os.Lstat(index); err == nil {
		if err = noSymlink(index); err != nil {
			return plan, err
		}
		bytes, readErr := os.ReadFile(index)
		if readErr != nil {
			return plan, readErr
		}
		if !json.Valid(bytes) {
			return plan, errors.New("Visual Brain index is invalid; repair or back it up before updating")
		}
		if err = atomicWrite(filepath.Join(directory, "visual-brain.before-update.json"), bytes); err != nil {
			return plan, err
		}
	} else if !os.IsNotExist(err) {
		return plan, err
	}
	plan = Plan{job, target, staged, target + ".previous-" + job, randomID(), manifest.Build, parentPID}
	if err = writeJSON(filepath.Join(directory, "plan.json"), plan); err != nil {
		return plan, err
	}
	success = true
	stagedOK = true
	return plan, nil
}
func (m *Manager) jobPath(job string) (string, error) {
	if !validJob(job) {
		return "", errors.New("invalid update receipt")
	}
	root, err := m.root()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "jobs", job), nil
}
func (m *Manager) Receipt(job, target string, ready bool, appPID int) error {
	directory, err := m.jobPath(job)
	if err != nil {
		return err
	}
	var plan Plan
	data, err := os.ReadFile(filepath.Join(directory, "plan.json"))
	if err != nil {
		return err
	}
	if json.Unmarshal(data, &plan) != nil || plan.Job != job || plan.Build != m.Config.Build || filepath.Clean(plan.Target) != filepath.Clean(target) {
		return errors.New("update receipt does not match this application")
	}
	if appPID <= 0 {
		return errors.New("application process ID is required")
	}
	receipt := Receipt{plan.Nonce, m.Config.Build, appPID, target}
	name := "boot.json"
	if ready {
		name = "healthy.json"
	}
	return writeJSON(filepath.Join(directory, name), receipt)
}

// Apply is deliberately separate from Prepare: no application file is touched until
// its process has exited, the archive is verified, and the library index is backed up.
func (m *Manager) Apply(plan Plan, launch func(string, string) error, alive func(int) bool, healthTimeout time.Duration) error {
	directory, err := m.jobPath(plan.Job)
	if err != nil {
		return err
	}
	result := func(message string) {
		_ = writeJSON(filepath.Join(filepath.Dir(filepath.Dir(directory)), "last-result.json"), map[string]any{"message": message, "time": m.now().Format(time.RFC3339), "build": plan.Build})
	}
	deadline := time.Now().Add(45 * time.Second)
	for alive(plan.ParentPID) {
		if time.Now().After(deadline) {
			_ = os.RemoveAll(plan.Staged)
			result("Update cancelled: application did not close. Original kept.")
			return errors.New("application did not close")
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err = noSymlink(plan.Target); err != nil {
		return err
	}
	if err = noSymlink(plan.Staged); err != nil {
		return err
	}
	if _, err = os.Lstat(plan.Backup); !os.IsNotExist(err) {
		return errors.New("update backup location already exists")
	}
	if err = os.Rename(plan.Target, plan.Backup); err != nil {
		result("Update could not replace the application. Original kept.")
		_ = launch(plan.Target, "")
		return err
	}
	if err = os.Rename(plan.Staged, plan.Target); err != nil {
		_ = os.Rename(plan.Backup, plan.Target)
		_ = launch(plan.Target, "")
		result("Update could not be installed. Original restored.")
		return err
	}
	rollback := func(cause error) error {
		var boot Receipt
		bytes, _ := os.ReadFile(filepath.Join(directory, "boot.json"))
		_ = json.Unmarshal(bytes, &boot)
		if boot.Nonce == plan.Nonce && boot.Target == plan.Target && boot.Build == plan.Build && boot.PID > 0 && alive(boot.PID) {
			if process, findErr := os.FindProcess(boot.PID); findErr == nil {
				_ = process.Kill()
				until := time.Now().Add(10 * time.Second)
				for alive(boot.PID) && time.Now().Before(until) {
					time.Sleep(100 * time.Millisecond)
				}
			}
		}
		failed := plan.Staged + ".failed"
		if renameErr := os.Rename(plan.Target, failed); renameErr != nil {
			result("Update failed. Previous app retained at " + plan.Backup)
			return fmt.Errorf("%w; close the new app and restore %s", cause, plan.Backup)
		}
		if renameErr := os.Rename(plan.Backup, plan.Target); renameErr != nil {
			_ = os.Rename(failed, plan.Target)
			return fmt.Errorf("%w; previous app retained at %s", cause, plan.Backup)
		}
		_ = os.RemoveAll(failed)
		if before, readErr := os.ReadFile(filepath.Join(directory, "visual-brain.before-update.json")); readErr == nil && json.Valid(before) {
			index := filepath.Join(m.DataRoot, "visual-brain.json")
			if current, err := os.ReadFile(index); err == nil {
				_ = atomicWrite(filepath.Join(directory, "visual-brain.after-failed-update.json"), current)
			}
			if err = atomicWrite(index, before); err != nil {
				result("Previous app restored. Visual Brain backup is at " + directory)
				return err
			}
		}
		_ = launch(plan.Target, "")
		result("Update failed; the previous application was restored. Visual Brain was not changed.")
		return cause
	}
	if err = launch(plan.Target, plan.Job); err != nil {
		return rollback(err)
	}
	deadline = time.Now().Add(healthTimeout)
	for time.Now().Before(deadline) {
		var receipt Receipt
		bytes, readErr := os.ReadFile(filepath.Join(directory, "healthy.json"))
		if readErr == nil && json.Unmarshal(bytes, &receipt) == nil && receipt.Nonce == plan.Nonce && receipt.Build == plan.Build && receipt.Target == plan.Target && receipt.PID > 0 {
			_ = os.RemoveAll(plan.Backup)
			_ = os.RemoveAll(filepath.Join(directory, "expanded"))
			_ = os.Remove(filepath.Join(directory, "package.zip"))
			result("Update completed. Visual Brain kept.")
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return rollback(errors.New("new application did not confirm a healthy startup"))
}

func (m *Manager) Install(ctx context.Context, target string, parentPID int, event func(Event), ready func()) error {
	root, err := m.root()
	if err != nil {
		return err
	}
	lockFile := filepath.Join(root, "install.lock")
	lock, err := os.OpenFile(lockFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		var pid int
		bytes, _ := os.ReadFile(lockFile)
		_ = json.Unmarshal(bytes, &pid)
		if pid > 0 && !ProcessAlive(pid) {
			_ = os.Remove(lockFile)
			lock, err = os.OpenFile(lockFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		}
	}
	if err != nil {
		return errors.New("another update is already running")
	}
	defer os.Remove(lockFile)
	bytes, _ := json.Marshal(os.Getpid())
	_, _ = lock.Write(bytes)
	_ = lock.Close()
	plan, err := m.Prepare(ctx, target, parentPID, event)
	if err != nil {
		return err
	}
	if ctx.Err() != nil {
		_ = os.RemoveAll(plan.Staged)
		return ctx.Err()
	}
	event(Event{"ready", 100, "Ready to restart — Visual Brain is backed up", plan.Job})
	ready() // Close the event pipe; the helper must survive its parent exiting.
	return m.Apply(plan, Launch, ProcessAlive, 45*time.Second)
}
