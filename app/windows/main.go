package main

import (
	"archive/zip"
	"bufio"
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/moxcomic/go-webview"
	_ "github.com/moxcomic/go-webview/embedded"
	"golang.org/x/sys/windows"
)

//go:embed web
var webFiles embed.FS

const bridgeScript = `
window.webkit = window.webkit || {};
window.webkit.messageHandlers = window.webkit.messageHandlers || {};
window.webkit.messageHandlers.raminStation = {
  postMessage(message) {
    window.nativeBridgeMessage(JSON.stringify(message))
      .then(result => window.raminNativeResolve && window.raminNativeResolve(message.id, result))
      .catch(error => window.raminNativeResolve && window.raminNativeResolve(message.id, {error: String(error)}));
  }
};
document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('mousedown', event => {
    if (event.button !== 0 || event.target.closest('button,a,input,select')) return;
    if (event.clientY < Math.max(90, window.innerHeight * .14)) {
      window.webkit.messageHandlers.raminStation.postMessage({id: Date.now(), action:'windowControl', payload:{control:'drag'}});
    }
  });
});
`

type bridgeRequest struct {
	ID      int            `json:"id"`
	Action  string         `json:"action"`
	Payload map[string]any `json:"payload"`
}

type application struct {
	view       webview.WebView
	hwnd       uintptr
	binDir     string
	client     *http.Client
	jobMu      sync.Mutex
	jobCancel  context.CancelFunc
	jobProcess *exec.Cmd
	cancelled  bool
}

func main() {
	serverURL, closeServer, err := serveAssets()
	if err != nil {
		windows.MessageBox(0, windows.StringToUTF16Ptr(err.Error()), windows.StringToUTF16Ptr("Ramin Station"), windows.MB_OK|windows.MB_ICONERROR)
		return
	}
	defer closeServer()

	w, err := webview.New(false)
	if err != nil {
		windows.MessageBox(0, windows.StringToUTF16Ptr(err.Error()), windows.StringToUTF16Ptr("Ramin Station"), windows.MB_OK|windows.MB_ICONERROR)
		return
	}
	defer w.Destroy()
	w.SetTitle("Ramin Station")
	w.SetSize(1269, 794, webview.HintNone)
	w.SetSize(960, 601, webview.HintMin)

	binDir, err := managedBinDirectory()
	if err != nil {
		windows.MessageBox(0, windows.StringToUTF16Ptr(err.Error()), windows.StringToUTF16Ptr("Ramin Station"), windows.MB_OK|windows.MB_ICONERROR)
		return
	}
	app := &application{
		view:   w,
		hwnd:   uintptr(w.Window()),
		binDir: binDir,
		client: &http.Client{Timeout: 30 * time.Minute},
	}
	configureNativeWindow(app.hwnd)
	if err := w.Bind("nativeBridgeMessage", app.handleBridge); err != nil {
		panic(err)
	}
	w.Init(bridgeScript)
	w.Navigate(serverURL + "/index.html")
	w.Run()
}

func configureNativeWindow(hwnd uintptr) {
	user32 := windows.NewLazySystemDLL("user32.dll")
	index := int32(-16)
	style, _, _ := user32.NewProc("GetWindowLongPtrW").Call(hwnd, uintptr(index))
	style &^= uintptr(0x00C00000) // WS_CAPTION
	style &^= uintptr(0x00080000) // WS_SYSMENU
	user32.NewProc("SetWindowLongPtrW").Call(hwnd, uintptr(index), style)
	user32.NewProc("SetWindowPos").Call(hwnd, 0, 0, 0, 0, 0x0001|0x0002|0x0004|0x0020)
}

func serveAssets() (string, func(), error) {
	content, err := fs.Sub(webFiles, "web")
	if err != nil {
		return "", nil, err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", nil, err
	}
	server := &http.Server{Handler: http.FileServer(http.FS(content)), ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = server.Serve(listener) }()
	return "http://" + listener.Addr().String(), func() { _ = server.Close() }, nil
}

func managedBinDirectory() (string, error) {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, "AppData", "Local")
	}
	path := filepath.Join(base, "Ramin Station", "bin")
	return path, os.MkdirAll(path, 0o755)
}

func (a *application) handleBridge(raw string) map[string]any {
	var request bridgeRequest
	if err := json.Unmarshal([]byte(raw), &request); err != nil {
		return errorResult(err)
	}
	var result map[string]any
	var err error
	switch request.Action {
	case "dependencies":
		result = a.dependencies(stringList(request.Payload["tools"]))
	case "install":
		result, err = a.installTools(request.Payload)
	case "download":
		result, err = a.download(request.Payload)
	case "compress":
		result, err = a.compress(request.Payload)
	case "chooseFolder":
		result, err = chooseFolder()
	case "chooseFile":
		result, err = chooseFile(stringValue(request.Payload, "kind", "video"))
	case "readClipboard":
		result, err = readClipboard()
	case "cancel":
		a.cancelCurrentJob()
		result = map[string]any{"message": "Cancelled"}
	case "windowControl":
		a.windowControl(stringValue(request.Payload, "control", ""))
		result = map[string]any{"ok": true}
	case "openExternal":
		err = openExternal(stringValue(request.Payload, "url", ""))
		result = map[string]any{"ok": err == nil}
	default:
		err = errors.New("unknown action")
	}
	if err != nil {
		return errorResult(err)
	}
	return result
}

func errorResult(err error) map[string]any { return map[string]any{"error": err.Error()} }

func (a *application) windowControl(control string) {
	user32 := windows.NewLazySystemDLL("user32.dll")
	switch control {
	case "close":
		proc := user32.NewProc("PostMessageW")
		proc.Call(a.hwnd, 0x0010, 0, 0)
	case "minimize":
		proc := user32.NewProc("ShowWindow")
		proc.Call(a.hwnd, 6)
	case "zoom":
		isZoomed, _, _ := user32.NewProc("IsZoomed").Call(a.hwnd)
		show := uintptr(3)
		if isZoomed != 0 {
			show = 9
		}
		user32.NewProc("ShowWindow").Call(a.hwnd, show)
	case "drag":
		user32.NewProc("ReleaseCapture").Call()
		user32.NewProc("SendMessageW").Call(a.hwnd, 0x00A1, 2, 0)
	}
}

func openExternal(url string) error {
	if !strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "http://") {
		return errors.New("invalid external URL")
	}
	return exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", url).Start()
}

func chooseFolder() (map[string]any, error) {
	script := `Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='Choose a video folder'; $d.ShowNewFolderButton=$true; if($d.ShowDialog() -eq 'OK'){[Console]::OutputEncoding=[Text.UTF8Encoding]::UTF8; Write-Output $d.SelectedPath}`
	command := exec.Command("powershell.exe", "-NoProfile", "-STA", "-Command", script)
	output, err := command.Output()
	if err != nil {
		return nil, err
	}
	path := strings.TrimSpace(string(output))
	if path == "" {
		return map[string]any{"cancelled": true}, nil
	}
	return map[string]any{"path": path}, nil
}

func chooseFile(kind string) (map[string]any, error) {
	filter := "Video Files|*.mp4;*.mov;*.mkv;*.avi;*.m4v;*.webm|All Files|*.*"
	title := "Choose one video file"
	if kind == "cookies" {
		filter = "Netscape Cookies|*.txt|All Files|*.*"
		title = "Choose a Netscape cookies.txt file"
	}
	script := fmt.Sprintf(`Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.Title='%s'; $d.Filter='%s'; if($d.ShowDialog() -eq 'OK'){[Console]::OutputEncoding=[Text.UTF8Encoding]::UTF8; Write-Output $d.FileName}`, title, filter)
	output, err := exec.Command("powershell.exe", "-NoProfile", "-STA", "-Command", script).Output()
	if err != nil {
		return nil, err
	}
	path := strings.TrimSpace(string(output))
	if path == "" {
		return map[string]any{"cancelled": true}, nil
	}
	return map[string]any{"path": path}, nil
}

func readClipboard() (map[string]any, error) {
	output, err := exec.Command("powershell.exe", "-NoProfile", "-STA", "-Command", "Get-Clipboard -Raw").Output()
	if err != nil {
		return nil, err
	}
	return map[string]any{"text": strings.TrimRight(string(output), "\r\n")}, nil
}

func (a *application) dependencies(requested []string) map[string]any {
	if len(requested) == 0 {
		requested = []string{"ffmpeg", "ytdlp", "deno"}
	}
	result := map[string]any{}
	if contains(requested, "ffmpeg") {
		result["ffmpeg"] = a.commandInfo("ffmpeg", "-version")
	}
	if contains(requested, "ytdlp") {
		result["ytdlp"] = a.commandInfo("yt-dlp", "--version")
	}
	if contains(requested, "deno") {
		result["deno"] = a.commandInfo("deno", "--version")
	}
	return result
}

func (a *application) commandInfo(name string, args ...string) map[string]any {
	path, err := a.findExecutable(name)
	if err != nil {
		return map[string]any{"ready": false, "version": "missing"}
	}
	if strings.HasPrefix(strings.ToLower(path), strings.ToLower(a.binDir)+strings.ToLower(string(os.PathSeparator))) {
		return map[string]any{"ready": true, "version": "managed • ready"}
	}
	command := exec.Command(path, args...)
	command.Env = a.environment()
	output, err := command.CombinedOutput()
	if err != nil {
		return map[string]any{"ready": false, "version": "missing"}
	}
	line := strings.Split(strings.TrimSpace(string(output)), "\n")[0]
	if len(line) > 42 {
		line = line[:42]
	}
	return map[string]any{"ready": true, "version": line}
}

func (a *application) findExecutable(name string) (string, error) {
	candidates := []string{filepath.Join(a.binDir, name+".exe"), filepath.Join(a.binDir, name)}
	for _, path := range candidates {
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			return path, nil
		}
	}
	return exec.LookPath(name)
}

func (a *application) environment() []string {
	return append(os.Environ(), "PATH="+a.binDir+";"+os.Getenv("PATH"))
}

func (a *application) installTools(payload map[string]any) (map[string]any, error) {
	requested := stringList(payload["tools"])
	if contains(requested, "ffmpeg") {
		if _, err := a.findExecutable("ffmpeg"); err != nil {
			a.emit("Installing verified FFmpeg package…", nil)
			if err := a.installFFmpeg(); err != nil {
				return nil, err
			}
		}
	}
	if contains(requested, "deno") {
		if _, err := a.findExecutable("deno"); err != nil {
			a.emit("Installing verified Deno runtime…", nil)
			if err := a.installDeno(); err != nil {
				return nil, err
			}
		}
	}
	if contains(requested, "ytdlp") {
		a.emit("Installing the latest verified yt-dlp…", nil)
		if err := a.installYTDLP(); err != nil {
			return nil, err
		}
	}
	result := a.dependencies(requested)
	for _, tool := range requested {
		info, _ := result[tool].(map[string]any)
		ready, _ := info["ready"].(bool)
		if !ready {
			return nil, fmt.Errorf("could not finish installing %s", tool)
		}
	}
	a.emit("Setup complete — media tools are ready.", nil)
	return result, nil
}

func (a *application) installYTDLP() error {
	const base = "https://github.com/yt-dlp/yt-dlp/releases/latest/download"
	manifest, err := a.fetch(base + "/SHA2-256SUMS")
	if err != nil {
		return err
	}
	expected := checksumFromManifest(string(manifest), "yt-dlp.exe")
	if expected == "" {
		return errors.New("could not verify the yt-dlp release manifest")
	}
	data, err := a.fetch(base + "/yt-dlp.exe")
	if err != nil {
		return err
	}
	return verifiedWrite(filepath.Join(a.binDir, "yt-dlp.exe"), data, expected)
}

func (a *application) installDeno() error {
	const name = "deno-x86_64-pc-windows-msvc.zip"
	const base = "https://github.com/denoland/deno/releases/latest/download"
	sum, err := a.fetch(base + "/" + name + ".sha256sum")
	if err != nil {
		return err
	}
	fields := strings.Fields(string(sum))
	if len(fields) == 0 {
		return errors.New("could not verify the Deno release manifest")
	}
	data, err := a.fetch(base + "/" + name)
	if err != nil {
		return err
	}
	if err := verifyBytes(data, fields[0], name); err != nil {
		return err
	}
	return extractNamedFile(data, "deno.exe", filepath.Join(a.binDir, "deno.exe"))
}

func (a *application) installFFmpeg() error {
	const name = "ffmpeg-master-latest-win64-gpl-shared.zip"
	const base = "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest"
	manifest, err := a.fetch(base + "/checksums.sha256")
	if err != nil {
		return err
	}
	expected := checksumFromManifest(string(manifest), name)
	if expected == "" {
		return errors.New("could not verify the FFmpeg release manifest")
	}
	data, err := a.fetch(base + "/" + name)
	if err != nil {
		return err
	}
	if err := verifyBytes(data, expected, name); err != nil {
		return err
	}
	return extractBinDirectory(data, a.binDir)
}

func (a *application) fetch(url string) ([]byte, error) {
	request, _ := http.NewRequest(http.MethodGet, url, nil)
	request.Header.Set("User-Agent", "Ramin-Station/1.0")
	response, err := a.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("download failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return nil, fmt.Errorf("download failed: %s", response.Status)
	}
	return io.ReadAll(response.Body)
}

func checksumFromManifest(manifest, name string) string {
	for _, line := range strings.Split(manifest, "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && strings.TrimPrefix(fields[len(fields)-1], "*") == name {
			return fields[0]
		}
	}
	return ""
}

func verifyBytes(data []byte, expected, name string) error {
	digest := sha256.Sum256(data)
	if !strings.EqualFold(hex.EncodeToString(digest[:]), expected) {
		return fmt.Errorf("security check failed for %s; nothing was installed", name)
	}
	return nil
}

func verifiedWrite(destination string, data []byte, expected string) error {
	if err := verifyBytes(data, expected, filepath.Base(destination)); err != nil {
		return err
	}
	temporary := destination + ".tmp"
	if err := os.WriteFile(temporary, data, 0o755); err != nil {
		return err
	}
	_ = os.Remove(destination)
	return os.Rename(temporary, destination)
}

func extractNamedFile(data []byte, name, destination string) error {
	reader, err := zip.NewReader(bytesReaderAt(data), int64(len(data)))
	if err != nil {
		return err
	}
	for _, file := range reader.File {
		if strings.EqualFold(filepath.Base(file.Name), name) {
			return extractZipFile(file, destination)
		}
	}
	return fmt.Errorf("%s was not found in the package", name)
}

type byteReaderAt []byte

func (b byteReaderAt) ReadAt(p []byte, off int64) (int, error) {
	if off >= int64(len(b)) {
		return 0, io.EOF
	}
	n := copy(p, b[off:])
	if n < len(p) {
		return n, io.EOF
	}
	return n, nil
}
func bytesReaderAt(data []byte) io.ReaderAt { return byteReaderAt(data) }

func extractBinDirectory(data []byte, destination string) error {
	reader, err := zip.NewReader(bytesReaderAt(data), int64(len(data)))
	if err != nil {
		return err
	}
	foundFFmpeg := false
	for _, file := range reader.File {
		normalized := strings.ReplaceAll(file.Name, "\\", "/")
		if file.FileInfo().IsDir() || !strings.Contains(normalized, "/bin/") {
			continue
		}
		base := filepath.Base(file.Name)
		if base == "." || base == "" {
			continue
		}
		if strings.EqualFold(base, "ffmpeg.exe") {
			foundFFmpeg = true
		}
		if err := extractZipFile(file, filepath.Join(destination, base)); err != nil {
			return err
		}
	}
	if !foundFFmpeg {
		return errors.New("FFmpeg executable was not found in the package")
	}
	return nil
}

func extractZipFile(file *zip.File, destination string) error {
	input, err := file.Open()
	if err != nil {
		return err
	}
	defer input.Close()
	temporary := destination + ".tmp"
	output, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	_ = os.Remove(destination)
	return os.Rename(temporary, destination)
}

func (a *application) download(payload map[string]any) (map[string]any, error) {
	url := stringValue(payload, "url", "")
	if !strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "http://") {
		return nil, errors.New("enter a valid video URL")
	}
	ytdlp, err := a.findExecutable("yt-dlp")
	if err != nil {
		return nil, errors.New("yt-dlp is not installed; use Setup / Update first")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	outputDir := filepath.Join(home, "Downloads")
	if err := os.MkdirAll(outputDir, 0o755); err != nil {
		return nil, err
	}
	baseArgs := []string{"--no-playlist", "--newline", "--retries", "5", "--fragment-retries", "5", "--progress-template", "download:RS_PROGRESS:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s", "-o", filepath.Join(outputDir, "%(title)s.%(ext)s")}
	if deno, findErr := a.findExecutable("deno"); findErr == nil {
		baseArgs = append(baseArgs, "--js-runtimes", "deno:"+deno)
	}
	mediaType := stringValue(payload, "mediaType", "video")
	quality := stringValue(payload, "quality", "1080")
	if mediaType == "audio" {
		audioQuality := "0"
		if quality == "128" {
			audioQuality = "128K"
		} else if quality == "256" {
			audioQuality = "256K"
		}
		baseArgs = append(baseArgs, "-x", "--audio-format", "mp3", "--audio-quality", audioQuality)
	} else {
		if !contains([]string{"1080", "720", "480"}, quality) {
			quality = "1080"
		}
		baseArgs = append(baseArgs, "-f", "bestvideo[height<="+quality+"]+bestaudio/best[height<="+quality+"]/best", "--merge-output-format", "mp4")
	}
	type authAttempt struct {
		label string
		args  []string
	}
	attempts := []authAttempt{{label: "public access"}}
	cookies := stringValue(payload, "cookies", "auto")
	cookieFile := stringValue(payload, "cookieFile", "")
	if contains([]string{"chrome", "edge", "firefox"}, cookies) {
		attempts = append(attempts, authAttempt{label: strings.Title(cookies) + " cookies", args: []string{"--cookies-from-browser", cookies}})
	} else if cookies == "safari" {
		return nil, errors.New("Safari Cookies are only available on macOS; choose AUTO RETRY, Chrome, Edge, Firefox, or cookies.txt")
	} else if cookies == "cookiefile" {
		if info, statErr := os.Stat(cookieFile); statErr != nil || info.IsDir() {
			return nil, errors.New("choose a valid cookies.txt file first")
		}
		attempts = append(attempts, authAttempt{label: "cookies.txt", args: []string{"--cookies", cookieFile}})
	} else if cookies == "auto" {
		attempts = append(attempts,
			authAttempt{label: "Chrome cookies", args: []string{"--cookies-from-browser", "chrome"}},
			authAttempt{label: "Edge cookies", args: []string{"--cookies-from-browser", "edge"}},
			authAttempt{label: "Firefox cookies", args: []string{"--cookies-from-browser", "firefox"}},
		)
	}
	a.beginJob()
	defer a.finishJob()
	a.emit("yt-dlp connected — reading media info…", numberPointer(1))
	lastOutput := ""
	for index, attempt := range attempts {
		if index > 0 {
			a.emit("Retrying with "+attempt.label+"…", numberPointer(1))
		}
		output, runErr := a.runStreaming(ytdlp, append(append(append([]string{}, baseArgs...), attempt.args...), url), "download", 0, 100, 0)
		lastOutput = output
		if a.wasCancelled() {
			return nil, errors.New("operation cancelled")
		}
		if runErr == nil {
			a.emit("Media saved directly to Downloads", numberPointer(100))
			return map[string]any{"message": "Download complete", "folder": outputDir}, nil
		}
		if index == 0 && !needsCookieRetry(output) {
			break
		}
	}
	return nil, friendlyDownloadError(lastOutput)
}

func needsCookieRetry(output string) bool {
	lower := strings.ToLower(output)
	for _, phrase := range []string{"cookies", "login", "sign in", "confirm you’re not a bot", "confirm you're not a bot", "po token", "http error 403"} {
		if strings.Contains(lower, phrase) {
			return true
		}
	}
	return false
}

func friendlyDownloadError(output string) error {
	lower := strings.ToLower(output)
	if needsCookieRetry(lower) {
		return errors.New("YouTube still needs valid login cookies. Try AUTO RETRY first, then choose Chrome, Edge, Firefox, or a Netscape cookies.txt file")
	}
	if len(output) > 900 {
		output = output[len(output)-900:]
	}
	if strings.TrimSpace(output) == "" {
		output = "download failed; use Setup / Update and try again"
	}
	return errors.New(strings.TrimSpace(output))
}

func (a *application) compress(payload map[string]any) (map[string]any, error) {
	sourcePath := stringValue(payload, "source", stringValue(payload, "folder", ""))
	info, err := os.Stat(sourcePath)
	if err != nil {
		return nil, errors.New("choose a valid source file or folder")
	}
	ffmpeg, err := a.findExecutable("ffmpeg")
	if err != nil {
		return nil, errors.New("FFmpeg is not installed; use Setup / Update first")
	}
	inputType := stringValue(payload, "inputType", "all")
	allowed := []string{"mp4", "mov", "mkv", "avi", "m4v", "webm"}
	if inputType != "all" {
		allowed = []string{inputType}
	}
	var files []string
	baseFolder := sourcePath
	if info.IsDir() {
		entries, readErr := os.ReadDir(sourcePath)
		if readErr != nil {
			return nil, readErr
		}
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(entry.Name())), ".")
			if contains(allowed, ext) {
				files = append(files, filepath.Join(sourcePath, entry.Name()))
			}
		}
	} else {
		baseFolder = filepath.Dir(sourcePath)
		ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(sourcePath)), ".")
		if !contains([]string{"mp4", "mov", "mkv", "avi", "m4v", "webm"}, ext) {
			return nil, errors.New("choose a supported video file")
		}
		files = []string{sourcePath}
	}
	if len(files) == 0 {
		return nil, errors.New("no matching video files were found")
	}
	quality := stringValue(payload, "quality", "balanced")
	crf, audio := "26", "128k"
	if quality == "high" {
		crf, audio = "21", "192k"
	} else if quality == "tiny" {
		crf, audio = "31", "96k"
	}
	editReady := stringValue(payload, "processMode", "compress") == "decompress"
	outputName := "Ramin Station HEVC"
	if editReady {
		outputName = "Ramin Station Edit"
	}
	outputDir := filepath.Join(baseFolder, outputName)
	if err := os.MkdirAll(outputDir, 0o755); err != nil {
		return nil, err
	}
	a.beginJob()
	defer a.finishJob()
	a.emit(fmt.Sprintf("Found %d matching video file(s).", len(files)), numberPointer(0))
	for index, source := range files {
		if a.wasCancelled() {
			return nil, errors.New("operation cancelled")
		}
		base := float64(index) / float64(len(files)) * 100
		span := 100 / float64(len(files))
		duration := a.probeDuration(source)
		suffix, extension := "_HEVC", ".mp4"
		codecArgs := []string{"-c:v", "libx265", "-preset", "slow", "-crf", crf, "-tag:v", "hvc1", "-c:a", "aac", "-b:a", audio}
		message := "Compressing " + filepath.Base(source) + "…"
		if editReady {
			suffix, extension = "_EDIT", ".mov"
			codecArgs = []string{"-c:v", "prores_ks", "-profile:v", "0", "-pix_fmt", "yuv422p10le", "-c:a", "pcm_s16le"}
			message = "Creating edit-ready copy of " + filepath.Base(source) + "…"
		}
		destination := filepath.Join(outputDir, strings.TrimSuffix(filepath.Base(source), filepath.Ext(source))+suffix+extension)
		a.emit(message, numberPointer(base))
		args := append([]string{"-hide_banner", "-loglevel", "warning", "-y", "-i", source}, codecArgs...)
		args = append(args, "-progress", "pipe:1", "-nostats", destination)
		output, runErr := a.runStreaming(ffmpeg, args, "transcode", base, span, duration)
		if a.wasCancelled() {
			_ = os.Remove(destination)
			return nil, errors.New("operation cancelled")
		}
		if runErr != nil {
			if len(output) > 900 {
				output = output[len(output)-900:]
			}
			return nil, errors.New(strings.TrimSpace(output))
		}
		a.emit("Finished "+filepath.Base(source), numberPointer(base+span))
	}
	message := fmt.Sprintf("%d file(s) compressed", len(files))
	if editReady {
		message = fmt.Sprintf("%d edit-ready file(s) created", len(files))
	}
	return map[string]any{"message": message, "folder": outputDir}, nil
}

func (a *application) probeDuration(source string) float64 {
	ffprobe, err := a.findExecutable("ffprobe")
	if err != nil {
		return 0
	}
	command := exec.Command(ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", source)
	command.Env = a.environment()
	output, err := command.Output()
	if err != nil {
		return 0
	}
	duration, _ := strconv.ParseFloat(strings.TrimSpace(string(output)), 64)
	return duration
}

func (a *application) beginJob() {
	a.jobMu.Lock()
	a.cancelled = false
	a.jobCancel = nil
	a.jobProcess = nil
	a.jobMu.Unlock()
}

func (a *application) finishJob() {
	a.jobMu.Lock()
	a.jobCancel = nil
	a.jobProcess = nil
	a.jobMu.Unlock()
}

func (a *application) cancelCurrentJob() {
	a.jobMu.Lock()
	a.cancelled = true
	cancel := a.jobCancel
	process := a.jobProcess
	a.jobMu.Unlock()
	if cancel != nil {
		cancel()
	}
	if process != nil && process.Process != nil {
		_ = exec.Command("taskkill.exe", "/PID", strconv.Itoa(process.Process.Pid), "/T", "/F").Run()
	}
	a.emit("Process cancelled by user.", nil)
}

func (a *application) wasCancelled() bool {
	a.jobMu.Lock()
	defer a.jobMu.Unlock()
	return a.cancelled
}

func (a *application) runStreaming(executable string, args []string, kind string, progressBase, progressSpan, duration float64) (string, error) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	command := exec.CommandContext(ctx, executable, args...)
	command.Env = a.environment()
	reader, writer := io.Pipe()
	command.Stdout = writer
	command.Stderr = writer
	a.jobMu.Lock()
	a.jobCancel = cancel
	a.jobProcess = command
	a.jobMu.Unlock()
	if err := command.Start(); err != nil {
		_ = writer.Close()
		return "", err
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait(); _ = writer.Close() }()
	var output strings.Builder
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		output.WriteString(line + "\n")
		if output.Len() > 200000 {
			trimmed := output.String()
			output.Reset()
			output.WriteString(trimmed[len(trimmed)-100000:])
		}
		a.handleStreamLine(line, kind, progressBase, progressSpan, duration)
	}
	err := <-done
	return output.String(), err
}

func (a *application) handleStreamLine(line, kind string, progressBase, progressSpan, duration float64) {
	line = strings.TrimSpace(line)
	if index := strings.Index(line, "RS_PROGRESS:"); index >= 0 {
		values := strings.Split(line[index+len("RS_PROGRESS:"):], "|")
		percent, _ := strconv.ParseFloat(strings.TrimSpace(strings.TrimSuffix(values[0], "%")), 64)
		speed, eta := "", ""
		if len(values) > 1 {
			speed = strings.TrimSpace(values[1])
		}
		if len(values) > 2 {
			eta = strings.TrimSpace(values[2])
		}
		a.emit(fmt.Sprintf("Downloading %d%%  •  %s  •  ETA %s", int(percent), speed, eta), numberPointer(percent))
	} else if kind != "download" && duration > 0 && strings.HasPrefix(line, "out_time_us=") {
		microseconds, _ := strconv.ParseFloat(strings.TrimPrefix(line, "out_time_us="), 64)
		fraction := microseconds / 1_000_000 / duration
		if fraction < 0 {
			fraction = 0
		} else if fraction > 1 {
			fraction = 1
		}
		a.emit(fmt.Sprintf("Encoding %d%% of current file", int(fraction*100)), numberPointer(progressBase+progressSpan*fraction))
	} else if kind == "download" && (strings.HasPrefix(line, "[download]") || strings.HasPrefix(line, "[ExtractAudio]") || strings.HasPrefix(line, "[Merger]")) {
		a.emit(truncate(line, 150), nil)
	} else if kind != "download" && line != "" && !strings.Contains(line, "=") {
		a.emit(truncate(line, 150), nil)
	}
}

func (a *application) emit(message string, progress *float64) {
	event := map[string]any{"message": message}
	if progress != nil {
		event["progress"] = *progress
	}
	data, _ := json.Marshal(event)
	a.view.Dispatch(func() { a.view.Eval("window.raminNativeEvent && window.raminNativeEvent(" + string(data) + ");") })
}

func stringValue(payload map[string]any, key, fallback string) string {
	if value, ok := payload[key].(string); ok && value != "" {
		return value
	}
	return fallback
}

func stringList(value any) []string {
	items, _ := value.([]any)
	result := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok {
			result = append(result, text)
		}
	}
	return result
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if strings.EqualFold(candidate, value) {
			return true
		}
	}
	return false
}

func truncate(value string, max int) string {
	if len(value) <= max {
		return value
	}
	return value[:max]
}

func numberPointer(value float64) *float64 { return &value }
