package updater

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const MaxArchive = 512 << 20

type Config struct {
	Product   string   `json:"product"`
	Version   string   `json:"version"`
	Build     int      `json:"build"`
	Channel   string   `json:"channel"`
	BundleID  string   `json:"bundleID"`
	PublicKey string   `json:"publicKey"`
	Feeds     []string `json:"feeds"`
	Hosts     []string `json:"hosts"`
}
type Package struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}
type Manifest struct {
	Schema    int                `json:"schema"`
	Product   string             `json:"product"`
	Channel   string             `json:"channel"`
	Version   string             `json:"version"`
	Build     int                `json:"build"`
	Notes     string             `json:"notes"`
	Published string             `json:"published"`
	Expires   string             `json:"expires"`
	Packages  map[string]Package `json:"packages"`
}
type Envelope struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}
type Status struct {
	Available      bool   `json:"available"`
	Version        string `json:"version"`
	CurrentVersion string `json:"currentVersion"`
	Build          int    `json:"build"`
	Notes          string `json:"notes"`
	Message        string `json:"message"`
	Platform       string `json:"platform"`
}
type Event struct {
	Phase    string `json:"phase"`
	Progress int    `json:"progress"`
	Message  string `json:"message"`
	Job      string `json:"job,omitempty"`
}
type Manager struct {
	Config   Config
	DataRoot string
	Platform string
	Client   *http.Client
	Now      func() time.Time
}

func ReadConfig(file string) (Config, error) {
	var config Config
	data, err := os.ReadFile(file)
	if err == nil {
		err = json.Unmarshal(data, &config)
	}
	key, keyErr := base64.StdEncoding.DecodeString(config.PublicKey)
	if err == nil && (keyErr != nil || len(key) != ed25519.PublicKeySize || config.Product != "RaminStation" || config.Build <= 0 || config.Version == "" || config.Channel != "stable" || config.BundleID == "") {
		err = errors.New("invalid updater configuration")
	}
	return config, err
}
func (m *Manager) now() time.Time {
	if m.Now != nil {
		return m.Now()
	}
	return time.Now()
}
func (m *Manager) safeURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" || (u.Port() != "" && u.Port() != "443") {
		return errors.New("updates require an approved HTTPS URL")
	}
	for _, host := range m.Config.Hosts {
		if strings.EqualFold(host, u.Hostname()) {
			return nil
		}
	}
	return errors.New("update host is not approved")
}
func (m *Manager) client() *http.Client {
	var client http.Client
	if m.Client != nil {
		client = *m.Client
	} else {
		client = http.Client{Timeout: 20 * time.Second}
	}
	previous := client.CheckRedirect
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 8 {
			return errors.New("too many update redirects")
		}
		if err := m.safeURL(req.URL.String()); err != nil {
			return err
		}
		if previous != nil {
			return previous(req, via)
		}
		return nil
	}
	return &client
}
func (m *Manager) Verify(data []byte) (Manifest, error) {
	var manifest Manifest
	var envelope Envelope
	if len(data) > 128<<10 || json.Unmarshal(data, &envelope) != nil {
		return manifest, errors.New("invalid update envelope")
	}
	payload, e1 := base64.StdEncoding.DecodeString(envelope.Payload)
	signature, e2 := base64.StdEncoding.DecodeString(envelope.Signature)
	key, e3 := base64.StdEncoding.DecodeString(m.Config.PublicKey)
	if e1 != nil || e2 != nil || e3 != nil || len(key) != ed25519.PublicKeySize || !ed25519.Verify(key, payload, signature) {
		return manifest, errors.New("update signature is not valid")
	}
	if json.Unmarshal(payload, &manifest) != nil || manifest.Schema != 1 || manifest.Product != m.Config.Product || manifest.Channel != m.Config.Channel || manifest.Build <= 0 || len(manifest.Version) > 40 || manifest.Version == "" || len(manifest.Notes) > 12000 {
		return manifest, errors.New("invalid signed update information")
	}
	published, e1 := time.Parse(time.RFC3339, manifest.Published)
	expires, e2 := time.Parse(time.RFC3339, manifest.Expires)
	if e1 != nil || e2 != nil || published.After(m.now().Add(24*time.Hour)) || !expires.After(m.now()) || !expires.After(published) {
		return manifest, errors.New("update information has expired or has an invalid date")
	}
	p, ok := manifest.Packages[m.Platform]
	digest, err := hex.DecodeString(p.SHA256)
	if !ok || err != nil || len(digest) != sha256.Size || p.Size < 1 || p.Size > MaxArchive {
		return manifest, errors.New("no valid update package for this system")
	}
	if err = m.safeURL(p.URL); err != nil {
		return manifest, err
	}
	return manifest, nil
}
func (m *Manager) root() (string, error) {
	if !filepath.IsAbs(m.DataRoot) {
		return "", errors.New("update data location must be absolute")
	}
	if err := os.MkdirAll(m.DataRoot, 0700); err != nil {
		return "", err
	}
	root, err := filepath.EvalSymlinks(m.DataRoot)
	if err != nil {
		return "", err
	}
	root = filepath.Join(root, "Updates")
	if info, err := os.Lstat(root); err == nil && (info.Mode()&os.ModeSymlink != 0 || !info.IsDir()) {
		return "", errors.New("unsafe update directory")
	}
	if err = os.MkdirAll(root, 0700); err != nil {
		return "", err
	}
	return root, os.Chmod(root, 0700)
}
func atomicWrite(file string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(file), ".update-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return replaceFile(name, file)
}
func (m *Manager) cached() ([]byte, Manifest, error) {
	root, err := m.root()
	if err != nil {
		return nil, Manifest{}, err
	}
	data, err := os.ReadFile(filepath.Join(root, "available.json"))
	if err != nil {
		return nil, Manifest{}, err
	}
	manifest, err := m.Verify(data)
	return data, manifest, err
}
func (m *Manager) status(manifest Manifest, message string) Status {
	available := manifest.Build > m.Config.Build
	s := Status{Available: available, CurrentVersion: m.Config.Version, Platform: m.Platform, Message: message}
	if available {
		s.Version = manifest.Version
		s.Build = manifest.Build
		s.Notes = manifest.Notes
		s.Message = "Update available"
	}
	return s
}
func (m *Manager) Status() Status {
	_, manifest, err := m.cached()
	if err != nil {
		return m.status(Manifest{}, "No verified update is cached")
	}
	return m.status(manifest, "You are up to date")
}
func (m *Manager) Check(ctx context.Context, force bool) (Status, error) {
	root, err := m.root()
	if err != nil {
		return Status{}, err
	}
	stamp, stampErr := os.ReadFile(filepath.Join(root, "last-check.json"))
	var last time.Time
	_ = json.Unmarshal(stamp, &last)
	if !force && stampErr == nil && m.now().Sub(last) >= 0 && m.now().Sub(last) < 12*time.Hour {
		return m.Status(), nil
	}
	bestData, best, bestErr := m.cached()
	valid := false
	notPublished := true
	for _, feed := range m.Config.Feeds {
		if err = m.safeURL(feed); err != nil {
			continue
		}
		req, _ := http.NewRequestWithContext(ctx, "GET", feed, nil)
		req.Header.Set("User-Agent", "Ramin-Station-Updater/"+m.Config.Version)
		response, requestErr := m.client().Do(req)
		if requestErr != nil {
			notPublished = false
			continue
		}
		data, readErr := io.ReadAll(io.LimitReader(response.Body, (128<<10)+1))
		_ = response.Body.Close()
		if response.StatusCode == 404 {
			continue
		}
		notPublished = false
		if readErr != nil || response.StatusCode != 200 {
			continue
		}
		manifest, verifyErr := m.Verify(data)
		if verifyErr != nil {
			continue
		}
		valid = true
		if bestErr != nil || manifest.Build > best.Build {
			bestData = data
			best = manifest
			bestErr = nil
		}
	}
	if !valid {
		if bestErr == nil && best.Build > m.Config.Build {
			return m.status(best, "Using a previously verified update"), nil
		}
		if notPublished {
			return m.status(Manifest{}, "The update channel has not been published yet"), nil
		}
		return m.status(Manifest{}, "Updates could not be verified. Try again later."), errors.New("updates could not be verified; nothing was downloaded or installed")
	}
	if err = atomicWrite(filepath.Join(root, "available.json"), bestData); err != nil {
		return Status{}, err
	}
	stamp, _ = json.Marshal(m.now())
	_ = atomicWrite(filepath.Join(root, "last-check.json"), stamp)
	return m.status(best, "You are up to date"), nil
}
func (m *Manager) download(ctx context.Context, p Package, file string, event func(Event)) error {
	if err := m.safeURL(p.URL); err != nil {
		return err
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", p.URL, nil)
	req.Header.Set("User-Agent", "Ramin-Station-Updater/"+m.Config.Version)
	client := m.client()
	client.Timeout = 20 * time.Minute
	response, err := client.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return fmt.Errorf("update download failed (%d)", response.StatusCode)
	}
	if response.ContentLength > 0 && response.ContentLength != p.Size {
		return errors.New("update download size does not match the signed size")
	}
	output, err := os.OpenFile(file, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer output.Close()
	digest := sha256.New()
	reader := io.LimitReader(response.Body, p.Size+1)
	buffer := make([]byte, 128<<10)
	var total int64
	last := -1
	for {
		n, readErr := reader.Read(buffer)
		if n > 0 {
			total += int64(n)
			if total > p.Size {
				return errors.New("update download exceeds the signed size")
			}
			if _, err = output.Write(buffer[:n]); err != nil {
				return err
			}
			_, _ = digest.Write(buffer[:n])
			percent := int(total * 85 / p.Size)
			if percent != last {
				event(Event{"download", percent, "Downloading update…", ""})
				last = percent
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
	if total != p.Size || !strings.EqualFold(hex.EncodeToString(digest.Sum(nil)), p.SHA256) {
		return errors.New("update integrity check failed; original application was not changed")
	}
	return output.Sync()
}
