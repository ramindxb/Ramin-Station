package main

import (
	"embed"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

//go:embed "payload/Ramin Station.exe" payload/licenses/*
var payload embed.FS

const (
	appName = "Ramin Station"
	version = "1.0"
	idYes   = 6
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--uninstall" {
		uninstall()
		return
	}
	install()
}

func install() {
	answer := messageBox("Install Ramin Station 1.0 for this Windows user?", "Ramin Station Setup", windows.MB_YESNO|windows.MB_ICONQUESTION)
	if answer != idYes {
		return
	}

	installDir, err := installationDirectory()
	if err != nil {
		fail(err)
		return
	}
	if err := os.MkdirAll(installDir, 0o755); err != nil {
		fail(err)
		return
	}
	appData, err := payload.ReadFile("payload/Ramin Station.exe")
	if err != nil {
		fail(err)
		return
	}
	appPath := filepath.Join(installDir, "Ramin Station.exe")
	if err := os.WriteFile(appPath, appData, 0o755); err != nil {
		fail(err)
		return
	}
	licenseDir := filepath.Join(installDir, "licenses")
	if err := os.MkdirAll(licenseDir, 0o755); err != nil {
		fail(err)
		return
	}
	licenseEntries, err := payload.ReadDir("payload/licenses")
	if err != nil {
		fail(err)
		return
	}
	for _, entry := range licenseEntries {
		if entry.IsDir() {
			continue
		}
		licenseData, readErr := payload.ReadFile("payload/licenses/" + entry.Name())
		if readErr != nil {
			fail(readErr)
			return
		}
		if writeErr := os.WriteFile(filepath.Join(licenseDir, entry.Name()), licenseData, 0o644); writeErr != nil {
			fail(writeErr)
			return
		}
	}

	self, err := os.Executable()
	if err != nil {
		fail(err)
		return
	}
	setupData, err := os.ReadFile(self)
	if err != nil {
		fail(err)
		return
	}
	uninstaller := filepath.Join(installDir, "Uninstall Ramin Station.exe")
	if err := os.WriteFile(uninstaller, setupData, 0o755); err != nil {
		fail(err)
		return
	}

	shortcut, err := startMenuShortcut()
	if err != nil {
		fail(err)
		return
	}
	if err := createShortcut(shortcut, appPath, installDir); err != nil {
		fail(err)
		return
	}
	if err := registerUninstaller(installDir, appPath, uninstaller); err != nil {
		fail(err)
		return
	}

	_ = exec.Command(appPath).Start()
	messageBox("Ramin Station 1.0 is installed and ready.", "Ramin Station Setup", windows.MB_OK|windows.MB_ICONINFORMATION)
}

func uninstall() {
	answer := messageBox("Remove Ramin Station and its Start Menu shortcut? Downloaded media will not be deleted.", "Uninstall Ramin Station", windows.MB_YESNO|windows.MB_ICONQUESTION)
	if answer != idYes {
		return
	}
	installDir, err := installationDirectory()
	if err != nil {
		fail(err)
		return
	}
	if shortcut, shortcutErr := startMenuShortcut(); shortcutErr == nil {
		_ = os.Remove(shortcut)
	}
	_ = registry.DeleteKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Uninstall\RaminStation`)
	script := fmt.Sprintf("Start-Sleep -Seconds 2; Remove-Item -LiteralPath '%s' -Recurse -Force", psQuote(installDir))
	_ = exec.Command("powershell.exe", "-NoProfile", "-WindowStyle", "Hidden", "-Command", script).Start()
	messageBox("Ramin Station has been removed.", "Uninstall Ramin Station", windows.MB_OK|windows.MB_ICONINFORMATION)
}

func installationDirectory() (string, error) {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		return "", fmt.Errorf("LOCALAPPDATA is not available")
	}
	return filepath.Join(base, "Programs", appName), nil
}

func startMenuShortcut() (string, error) {
	base := os.Getenv("APPDATA")
	if base == "" {
		return "", fmt.Errorf("APPDATA is not available")
	}
	return filepath.Join(base, "Microsoft", "Windows", "Start Menu", "Programs", appName+".lnk"), nil
}

func createShortcut(shortcut, target, workingDirectory string) error {
	script := fmt.Sprintf("$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut('%s'); $s.TargetPath='%s'; $s.WorkingDirectory='%s'; $s.Description='Ramin Station Media Toolkit'; $s.Save()", psQuote(shortcut), psQuote(target), psQuote(workingDirectory))
	return exec.Command("powershell.exe", "-NoProfile", "-Command", script).Run()
}

func registerUninstaller(installDir, appPath, uninstaller string) error {
	key, _, err := registry.CreateKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Uninstall\RaminStation`, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	values := map[string]string{
		"DisplayName":     appName,
		"DisplayVersion":  version,
		"Publisher":       "Ramin Piri",
		"InstallLocation": installDir,
		"DisplayIcon":     appPath,
		"UninstallString": `"` + uninstaller + `" --uninstall`,
	}
	for name, value := range values {
		if err := key.SetStringValue(name, value); err != nil {
			return err
		}
	}
	if err := key.SetDWordValue("NoModify", 1); err != nil {
		return err
	}
	return key.SetDWordValue("NoRepair", 1)
}

func psQuote(value string) string { return strings.ReplaceAll(value, "'", "''") }

func messageBox(text, title string, style uint32) int {
	returnValue, _ := windows.MessageBox(0, windows.StringToUTF16Ptr(text), windows.StringToUTF16Ptr(title), style)
	return int(returnValue)
}

func fail(err error) {
	messageBox(err.Error(), "Ramin Station Setup", windows.MB_OK|windows.MB_ICONERROR)
}
