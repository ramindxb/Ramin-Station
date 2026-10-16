package main

import (
	"bufio"
	"crypto/sha256"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

//go:embed updater-payload/StationUpdater.exe
var updaterExecutable []byte

//go:embed update-config.json
var updaterConfiguration []byte

func (a *application) initUpdates() error {
	var config map[string]any
	if err := json.Unmarshal(updaterConfiguration, &config); err != nil {
		return err
	}
	a.updateState = map[string]any{"available": false, "currentVersion": config["version"], "platform": "windows", "message": "Updates have not been checked yet"}
	root := filepath.Join(filepath.Dir(a.binDir), "Updates", "runners")
	if err := os.MkdirAll(root, 0700); err != nil {
		return err
	}
	digest := sha256.Sum256(updaterExecutable)
	directory := filepath.Join(root, fmt.Sprintf("runner-%v-%x", config["build"], digest[:8]))
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	a.updaterPath = filepath.Join(directory, "StationUpdater.exe")
	a.updaterConfigPath = filepath.Join(directory, "update-config.json")
	if existing, err := os.ReadFile(a.updaterPath); err != nil || sha256.Sum256(existing) != digest {
		if err = os.WriteFile(a.updaterPath, updaterExecutable, 0700); err != nil {
			return err
		}
	}
	return os.WriteFile(a.updaterConfigPath, updaterConfiguration, 0600)
}
func (a *application) updaterCommand(action string, extra ...string) *exec.Cmd {
	args := []string{action, "--config", a.updaterConfigPath, "--data", filepath.Dir(a.binDir)}
	args = append(args, extra...)
	command := exec.Command(a.updaterPath, args...)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	return command
}
func (a *application) updaterRun(action string, extra ...string) (map[string]any, error) {
	output, err := a.updaterCommand(action, extra...).Output()
	var result map[string]any
	_ = json.Unmarshal(output, &result)
	if err != nil {
		if message, ok := result["error"].(string); ok {
			return nil, errors.New(message)
		}
		return nil, errors.New("could not check for updates; try again later")
	}
	return result, nil
}
func (a *application) updateStatus() map[string]any {
	a.updateMu.Lock()
	defer a.updateMu.Unlock()
	result := map[string]any{}
	for k, v := range a.updateState {
		result[k] = v
	}
	return result
}
func (a *application) emitUpdate(value map[string]any) {
	if _, isProgress := value["phase"]; !isProgress && value["available"] != nil {
		a.updateMu.Lock()
		a.updateState = value
		a.updateMu.Unlock()
	}
	data, _ := json.Marshal(value)
	a.view.Dispatch(func() { a.view.Eval("window.raminUpdateChanged && window.raminUpdateChanged(" + string(data) + ");") })
}
func (a *application) checkUpdates(force bool) (map[string]any, error) {
	extra := []string{}
	if force {
		extra = append(extra, "--force")
	}
	result, err := a.updaterRun("check", extra...)
	if err == nil {
		a.emitUpdate(result)
	}
	return result, err
}
func (a *application) updateReceipt(ready bool) bool {
	job := ""
	for i, arg := range os.Args {
		if arg == "--station-update-receipt" && i+1 < len(os.Args) {
			job = os.Args[i+1]
			break
		}
	}
	if job == "" {
		return true
	}
	target, err := os.Executable()
	if err != nil {
		return false
	}
	action := "boot"
	if ready {
		action = "ack"
	}
	_, err = a.updaterRun(action, "--job", job, "--target", target, "--parent", fmt.Sprint(os.Getpid()))
	return err == nil
}
func (a *application) installUpdate() (map[string]any, error) {
	if a.updateStatus()["available"] != true {
		return nil, errors.New("check for a verified update first")
	}
	if err := a.beginJob(); err != nil {
		return nil, err
	}
	defer a.finishJob()
	target, err := os.Executable()
	if err != nil {
		return nil, err
	}
	command := a.updaterCommand("install", "--target", target, "--parent", fmt.Sprint(os.Getpid()))
	reader, err := command.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err = command.Start(); err != nil {
		return nil, err
	}
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4096), 128<<10)
	message := ""
	for scanner.Scan() {
		var event map[string]any
		if json.Unmarshal(scanner.Bytes(), &event) != nil {
			continue
		}
		if text, ok := event["error"].(string); ok {
			message = text
		}
		if event["phase"] == "ready" {
			a.updateMu.Lock()
			a.updateReady = true
			a.updateMu.Unlock()
		}
		a.emitUpdate(event)
	}
	a.updateMu.Lock()
	ready := a.updateReady
	a.updateMu.Unlock()
	if ready {
		go func() { _ = command.Wait() }()
		return map[string]any{"ok": true}, nil
	}
	if err = command.Wait(); err != nil {
		if message == "" {
			message = "the update could not be prepared; original application kept"
		}
		return nil, errors.New(message)
	}
	return map[string]any{"ok": true}, nil
}
