package main

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func managedMediaFile(directory, name string) (string, error) {
	if name == "" {
		file, err := visualBrainStoredFile(directory)
		if err != nil {
			return "", err
		}
		name = filepath.Base(file)
	}
	if filepath.Base(name) != name || strings.HasPrefix(name, ".") || strings.ContainsAny(name, `/\`) {
		return "", errors.New("invalid media filename")
	}
	file := filepath.Join(directory, name)
	resolved, err := filepath.EvalSymlinks(file)
	if err != nil || !strings.EqualFold(filepath.Clean(file), filepath.Clean(resolved)) {
		return "", errors.New("managed media file is missing or unsafe")
	}
	info, err := os.Stat(file)
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("managed media file is missing")
	}
	return file, nil
}

func serveManagedMedia(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/managed-media/"), "/")
	if len(parts) != 3 || parts[0] != managedMediaToken || !validVisualBrainStorageID(parts[1]) || (r.Method != "GET" && r.Method != "HEAD") {
		http.NotFound(w, r)
		return
	}
	bin, err := managedBinDirectory()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	file, err := managedMediaFile(filepath.Join(filepath.Dir(bin), "Visual Brain Files", parts[1]), parts[2])
	if err != nil {
		http.NotFound(w, r)
		return
	}
	handle, err := os.Open(file)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer handle.Close()
	info, err := handle.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, info.Name(), info.ModTime(), handle)
}

func (a *application) playableCopy(source string, enabled bool) playbackResult {
	return preparePlayable(source, enabled, a.findExecutable, func(executable string, args []string, duration float64) (string, error) {
		kind := "playable"
		if strings.EqualFold(filepath.Base(executable), "ffprobe.exe") {
			kind = "probe"
		}
		return a.runStreaming(executable, args, kind, 90, 9, duration)
	}, a.wasCancelled, a.emit)
}
