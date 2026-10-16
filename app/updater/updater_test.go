package updater

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

type transport func(*http.Request) (*http.Response, error)

func (f transport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type setup struct {
	m        *Manager
	private  ed25519.PrivateKey
	manifest Manifest
	envelope []byte
	archive  []byte
	target   string
	media    string
}

func sign(t *testing.T, private ed25519.PrivateKey, manifest Manifest) []byte {
	t.Helper()
	payload, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(Envelope{base64.StdEncoding.EncodeToString(payload), base64.StdEncoding.EncodeToString(ed25519.Sign(private, payload))})
	return data
}
func zipBytes(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	writer := zip.NewWriter(&buf)
	for name, value := range files {
		file, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(file, value)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
func fixture(t *testing.T) *setup {
	t.Helper()
	directory := t.TempDir()
	directory, _ = filepath.EvalSymlinks(directory)
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	archive := zipBytes(t, map[string]string{"Ramin Station.exe": "MZnew executable", "licenses/license.txt": "license"})
	digest := sha256.Sum256(archive)
	now := time.Now().UTC().Truncate(time.Second)
	config := Config{Product: "RaminStation", Version: "2.1.0", Build: 210, Channel: "stable", PublicKey: base64.StdEncoding.EncodeToString(public), BundleID: "com.raminpiri.raminstation", Feeds: []string{"https://updates.example/stable.json"}, Hosts: []string{"updates.example"}}
	manifest := Manifest{Schema: 1, Product: config.Product, Channel: "stable", Version: "2.1.1", Build: 211, Notes: "Test update", Published: now.Format(time.RFC3339), Expires: now.Add(time.Hour).Format(time.RFC3339), Packages: map[string]Package{"windows": {URL: "https://updates.example/update.zip", Size: int64(len(archive)), SHA256: hex.EncodeToString(digest[:])}}}
	m := &Manager{Config: config, Platform: "windows", DataRoot: filepath.Join(directory, "Data"), Now: func() time.Time { return now }}
	target := filepath.Join(directory, "Ramin Station.exe")
	if err = os.WriteFile(target, []byte("MZold executable"), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Join(m.DataRoot, "Visual Brain Files"), 0700); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(m.DataRoot, "visual-brain.json"), []byte(`{"version":2,"items":[{"id":"existing","note":"keep me"}]}`), 0600)
	media := filepath.Join(m.DataRoot, "Visual Brain Files", "clip.mp4")
	_ = os.WriteFile(media, []byte("original media"), 0600)
	s := &setup{m, private, manifest, nil, archive, target, media}
	s.envelope = sign(t, private, manifest)
	m.Client = &http.Client{Transport: transport(func(req *http.Request) (*http.Response, error) {
		body := s.envelope
		if strings.HasSuffix(req.URL.Path, ".zip") {
			body = s.archive
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(body)), ContentLength: int64(len(body)), Request: req}, nil
	})}
	return s
}
func check(t *testing.T, s *setup) {
	t.Helper()
	status, err := s.m.Check(context.Background(), true)
	if err != nil || !status.Available {
		t.Fatalf("check: %+v %v", status, err)
	}
}
func assertOriginal(t *testing.T, s *setup) {
	t.Helper()
	data, _ := os.ReadFile(s.target)
	if string(data) != "MZold executable" {
		t.Fatalf("original changed: %q", data)
	}
	media, _ := os.ReadFile(s.media)
	if string(media) != "original media" {
		t.Fatal("library media changed")
	}
}

func TestVerifiedCheckAndBadgeDisappearsAfterUpdate(t *testing.T) {
	s := fixture(t)
	check(t, s)
	if !s.m.Status().Available {
		t.Fatal("missing update")
	}
	s.m.Config.Build = 211
	s.m.Config.Version = "2.1.1"
	if s.m.Status().Available {
		t.Fatal("update badge remained after installing same build")
	}
}
func TestRejectsModifiedSignatureWrongKeyAndExpiredFeed(t *testing.T) {
	for _, which := range []string{"modified", "wrong-key", "expired", "wrong-product", "wrong-channel", "http", "wrong-host"} {
		t.Run(which, func(t *testing.T) {
			s := fixture(t)
			switch which {
			case "modified":
				s.envelope[len(s.envelope)-3] ^= 1
			case "wrong-key":
				pub, _, _ := ed25519.GenerateKey(rand.Reader)
				s.m.Config.PublicKey = base64.StdEncoding.EncodeToString(pub)
			case "expired":
				s.manifest.Expires = s.m.now().Add(-time.Hour).Format(time.RFC3339)
				s.envelope = sign(t, s.private, s.manifest)
			case "wrong-product":
				s.manifest.Product = "OtherApp"
				s.envelope = sign(t, s.private, s.manifest)
			case "wrong-channel":
				s.manifest.Channel = "beta"
				s.envelope = sign(t, s.private, s.manifest)
			case "http":
				p := s.manifest.Packages["windows"]
				p.URL = "http://updates.example/update.zip"
				s.manifest.Packages["windows"] = p
				s.envelope = sign(t, s.private, s.manifest)
			case "wrong-host":
				p := s.manifest.Packages["windows"]
				p.URL = "https://untrusted.example/update.zip"
				s.manifest.Packages["windows"] = p
				s.envelope = sign(t, s.private, s.manifest)
			}
			if _, err := s.m.Verify(s.envelope); err == nil {
				t.Fatal("untrusted feed accepted")
			}
			assertOriginal(t, s)
		})
	}
}
func TestOlderSignedFeedCannotReplaceNewerVerifiedUpdate(t *testing.T) {
	s := fixture(t)
	check(t, s)
	s.manifest.Build = 209
	s.manifest.Version = "2.0.9"
	s.envelope = sign(t, s.private, s.manifest)
	status, err := s.m.Check(context.Background(), true)
	if err != nil || status.Build != 211 {
		t.Fatalf("cached newer update lost: %+v %v", status, err)
	}
}
func TestUnsignedExistingReleaseDoesNotCreateBadge(t *testing.T) {
	s := fixture(t)
	s.envelope = []byte(`{"tag_name":"v999","assets":[]}`)
	status, err := s.m.Check(context.Background(), true)
	if err == nil || status.Available {
		t.Fatal("unsigned release was trusted")
	}
}
func TestNotPublishedIsQuiet(t *testing.T) {
	s := fixture(t)
	s.m.Client = &http.Client{Transport: transport(func(req *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 404, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("not found")), Request: req}, nil
	})}
	status, err := s.m.Check(context.Background(), true)
	if err != nil || status.Available || !strings.Contains(status.Message, "not been published") {
		t.Fatalf("unexpected status: %+v %v", status, err)
	}
}
func TestRejectsHTTPSDowngradeRedirect(t *testing.T) {
	s := fixture(t)
	s.m.Client = &http.Client{Transport: transport(func(req *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{"http://updates.example/evil"}}, Body: io.NopCloser(strings.NewReader("")), Request: req}, nil
	})}
	if _, err := s.m.Check(context.Background(), true); err == nil {
		t.Fatal("HTTP downgrade accepted")
	}
}
func TestPrepareKeepsMediaAndCreatesIndexBackup(t *testing.T) {
	s := fixture(t)
	check(t, s)
	plan, err := s.m.Prepare(context.Background(), s.target, 99999, func(Event) {})
	if err != nil {
		t.Fatal(err)
	}
	assertOriginal(t, s)
	directory, _ := s.m.jobPath(plan.Job)
	backup, err := os.ReadFile(filepath.Join(directory, "visual-brain.before-update.json"))
	index, _ := os.ReadFile(filepath.Join(s.m.DataRoot, "visual-brain.json"))
	if err != nil || !bytes.Equal(backup, index) {
		t.Fatal("index backup missing")
	}
	staged, _ := os.ReadFile(plan.Staged)
	if string(staged) != "MZnew executable" {
		t.Fatal("bad staged update")
	}
}
func TestBadPackageHashDoesNotTouchApp(t *testing.T) {
	s := fixture(t)
	check(t, s)
	s.archive = append([]byte(nil), s.archive...)
	s.archive[len(s.archive)/2] ^= 1
	if _, err := s.m.Prepare(context.Background(), s.target, 99999, func(Event) {}); err == nil {
		t.Fatal("corrupt package accepted")
	}
	assertOriginal(t, s)
}
func TestArchiveRejectsTraversalAndSymlinks(t *testing.T) {
	for _, name := range []string{"../escape", "/absolute", "a/../../b", "a\\b", "C:escape", "a/./b"} {
		t.Run(name, func(t *testing.T) {
			directory := t.TempDir()
			archive := filepath.Join(directory, "update.zip")
			_ = os.WriteFile(archive, zipBytes(t, map[string]string{name: "bad"}), 0600)
			if err := extract(archive, filepath.Join(directory, "expanded")); err == nil {
				t.Fatal("unsafe zip accepted")
			}
		})
	}
	directory := t.TempDir()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	header := &zip.FileHeader{Name: "link"}
	header.SetMode(os.ModeSymlink | 0777)
	file, _ := writer.CreateHeader(header)
	_, _ = file.Write([]byte("../../outside"))
	_ = writer.Close()
	archive := filepath.Join(directory, "symlink.zip")
	_ = os.WriteFile(archive, buffer.Bytes(), 0600)
	if extract(archive, filepath.Join(directory, "out")) == nil {
		t.Fatal("symlink accepted")
	}
}
func TestSuccessfulInstallOnlyReplacesApp(t *testing.T) {
	s := fixture(t)
	check(t, s)
	plan, err := s.m.Prepare(context.Background(), s.target, 99999, func(Event) {})
	if err != nil {
		t.Fatal(err)
	}
	directory, _ := s.m.jobPath(plan.Job)
	launch := func(target, job string) error {
		if job != "" {
			return writeJSON(filepath.Join(directory, "healthy.json"), Receipt{plan.Nonce, plan.Build, 12345, target})
		}
		return nil
	}
	if err = s.m.Apply(plan, launch, func(int) bool { return false }, time.Second); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(s.target)
	if string(data) != "MZnew executable" {
		t.Fatal("update not installed")
	}
	media, _ := os.ReadFile(s.media)
	if string(media) != "original media" {
		t.Fatal("media changed")
	}
	if _, err = os.Stat(plan.Backup); !os.IsNotExist(err) {
		t.Fatal("old app should be removed only after a healthy launch")
	}
}
func TestFailedLaunchRollsBackWithoutChangingLibrary(t *testing.T) {
	s := fixture(t)
	check(t, s)
	plan, err := s.m.Prepare(context.Background(), s.target, 99999, func(Event) {})
	if err != nil {
		t.Fatal(err)
	}
	restored := false
	err = s.m.Apply(plan, func(_ string, job string) error {
		if job == "" {
			restored = true
			return nil
		}
		return errors.New("launch failed")
	}, func(int) bool { return false }, time.Millisecond)
	if err == nil || !restored {
		t.Fatal("failed update was not rolled back")
	}
	assertOriginal(t, s)
}
func TestMissingHealthReceiptRollsBack(t *testing.T) {
	s := fixture(t)
	check(t, s)
	plan, err := s.m.Prepare(context.Background(), s.target, 99999, func(Event) {})
	if err != nil {
		t.Fatal(err)
	}
	err = s.m.Apply(plan, func(string, string) error { return nil }, func(int) bool { return false }, time.Millisecond)
	if err == nil {
		t.Fatal("missing health acknowledgement accepted")
	}
	assertOriginal(t, s)
}
func TestReceiptRequiresMatchingVersionAndTarget(t *testing.T) {
	s := fixture(t)
	check(t, s)
	plan, err := s.m.Prepare(context.Background(), s.target, 99999, func(Event) {})
	if err != nil {
		t.Fatal(err)
	}
	if s.m.Receipt(plan.Job, s.target, true, os.Getpid()) == nil {
		t.Fatal("old app acknowledged new build")
	}
	s.m.Config.Build = plan.Build
	if s.m.Receipt(plan.Job, s.target+"wrong", true, os.Getpid()) == nil {
		t.Fatal("wrong target acknowledged")
	}
	if err = s.m.Receipt(plan.Job, s.target, true, os.Getpid()); err != nil {
		t.Fatal(err)
	}
}

func TestFailedUpdateRestoresIndexAndKeepsFailedIndexCopy(t *testing.T) {
	s := fixture(t)
	check(t, s)
	index := filepath.Join(s.m.DataRoot, "visual-brain.json")
	before, _ := os.ReadFile(index)
	plan, err := s.m.Prepare(context.Background(), s.target, 99999, func(Event) {})
	if err != nil {
		t.Fatal(err)
	}
	changed := []byte(`{"version":3,"items":[{"id":"migrated"}]}`)
	err = s.m.Apply(plan, func(_ string, job string) error {
		if job != "" {
			_ = os.WriteFile(index, changed, 0600)
			return errors.New("new app failed")
		}
		return nil
	}, func(int) bool { return false }, time.Millisecond)
	if err == nil {
		t.Fatal("expected rollback")
	}
	after, _ := os.ReadFile(index)
	if !bytes.Equal(before, after) {
		t.Fatal("previous library index was not restored")
	}
	directory, _ := s.m.jobPath(plan.Job)
	saved, _ := os.ReadFile(filepath.Join(directory, "visual-brain.after-failed-update.json"))
	if !bytes.Equal(saved, changed) {
		t.Fatal("failed-version index was lost")
	}
	assertOriginal(t, s)
}

func TestNodeReleaseSignerMatchesGoVerifier(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("Node.js not installed")
	}
	directory := t.TempDir()
	keys := filepath.Join(directory, "private")
	if output, err := exec.Command("node", "sign-update.js", "keygen", keys).CombinedOutput(); err != nil {
		t.Fatalf("key generator failed: %s", output)
	}
	raw, err := os.ReadFile(filepath.Join(keys, "station-update-public.txt"))
	if err != nil {
		t.Fatal(err)
	}
	s := fixture(t)
	config := s.m.Config
	config.PublicKey = strings.TrimSpace(string(raw))
	config.Hosts = []string{"github.com"}
	configPath := filepath.Join(directory, "config.json")
	data, _ := json.Marshal(config)
	_ = os.WriteFile(configPath, data, 0600)
	notes := filepath.Join(directory, "notes.md")
	_ = os.WriteFile(notes, []byte("Test signing interoperability."), 0600)
	for _, suffix := range []string{"macOS.zip", "Windows-Portable.zip"} {
		_ = os.WriteFile(filepath.Join(directory, "Ramin-Station-"+config.Version+"-"+suffix), s.archive, 0600)
	}
	if output, err := exec.Command("node", "sign-update.js", "sign", configPath, directory, notes, filepath.Join(keys, "station-update-private.pem")).CombinedOutput(); err != nil {
		t.Fatalf("signing failed: %s", output)
	}
	envelope, err := os.ReadFile(filepath.Join(directory, "updates-stable.json"))
	if err != nil {
		t.Fatal(err)
	}
	s.m.Config = config
	if _, err = s.m.Verify(envelope); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command("node", "sign-update.js", "keygen", keys).CombinedOutput(); err == nil {
		t.Fatalf("key generator overwrote an existing key: %s", output)
	}
}

func TestMacPackageSignatureSurvivesSafeExtraction(t *testing.T) {
	archive := os.Getenv("STATION_MAC_ARCHIVE")
	if archive == "" || runtime.GOOS != "darwin" {
		t.Skip("set STATION_MAC_ARCHIVE for native archive integration test")
	}
	directory := t.TempDir()
	if err := extract(archive, directory); err != nil {
		t.Fatal(err)
	}
	bundle := filepath.Join(directory, "Ramin Station.app")
	config, err := ReadConfig(filepath.Join(bundle, "Contents", "Resources", "app", "update-config.json"))
	if err != nil {
		t.Fatal(err)
	}
	identifier, err := exec.Command("/usr/libexec/PlistBuddy", "-c", "Print :CFBundleIdentifier", filepath.Join(bundle, "Contents", "Info.plist")).Output()
	if err != nil {
		t.Fatal(err)
	}
	config.BundleID = strings.TrimSpace(string(identifier))
	m := &Manager{Config: config, Platform: "macos"}
	if err = m.validateMac(bundle, Manifest{Build: config.Build, Version: config.Version}); err != nil {
		t.Fatal(err)
	}
}
