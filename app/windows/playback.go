package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type mediaStream struct {
	CodecType   string `json:"codec_type"`
	CodecName   string `json:"codec_name"`
	Pixel       string `json:"pix_fmt"`
	Transfer    string `json:"color_transfer"`
	Primaries   string `json:"color_primaries"`
	Disposition struct {
		Attached int `json:"attached_pic"`
	} `json:"disposition"`
}
type mediaProbe struct {
	Streams []mediaStream `json:"streams"`
	Format  struct {
		Duration string `json:"duration"`
	} `json:"format"`
}
type playbackResult struct{ File, Original, Mode, Warning string }

func (r playbackResult) result() map[string]any {
	return map[string]any{"path": r.File, "name": filepath.Base(r.File), "originalName": filepath.Base(r.Original), "compatibility": r.Mode, "warning": r.Warning}
}

var playbackProbeArgs = []string{"-v", "error", "-show_streams", "-show_format", "-of", "json"}

// All conversions create a second file. The source is never removed or replaced.
func preparePlayable(source string, enabled bool, find func(string) (string, error), run func(string, []string, float64) (string, error), cancelled func() bool, event func(string, *float64)) playbackResult {
	unchanged := func(mode, warning string) playbackResult {
		if warning != "" {
			event(warning, nil)
		}
		return playbackResult{source, source, mode, warning}
	}
	if !enabled {
		return unchanged("disabled", "")
	}
	event("Checking playback compatibility…", numberPointer(90))
	probe, e1 := find("ffprobe")
	ffmpeg, e2 := find("ffmpeg")
	if e1 != nil || e2 != nil {
		return unchanged("unavailable", "Original saved. Playback check needs FFmpeg + ffprobe; run Setup / Update.")
	}
	readProbe := func(file string) (mediaProbe, error) {
		output, err := run(probe, append(append([]string{}, playbackProbeArgs...), file), 0)
		var info mediaProbe
		if err == nil {
			err = json.Unmarshal([]byte(output), &info)
		}
		return info, err
	}
	info, err := readProbe(source)
	if err != nil {
		return unchanged("failed", "Original saved, but its media format could not be checked.")
	}
	if cancelled() {
		return unchanged("cancelled", "Playable copy cancelled. Original kept.")
	}
	var video *mediaStream
	audio := []mediaStream{}
	for i, s := range info.Streams {
		if s.CodecType == "video" && s.Disposition.Attached == 0 && video == nil {
			video = &info.Streams[i]
		}
		if s.CodecType == "audio" {
			audio = append(audio, s)
		}
	}
	if video == nil && len(audio) == 0 {
		return unchanged("original", "")
	}
	copyVideo := video == nil || video.CodecName == "h264" && (video.Pixel == "yuv420p" || video.Pixel == "yuvj420p")
	copyAudio := true
	for _, s := range audio {
		if s.CodecName != "aac" && s.CodecName != "mp3" {
			copyAudio = false
		}
	}
	ext := strings.ToLower(filepath.Ext(source))
	containerOK := contains([]string{".mp4", ".m4v", ".mov"}, ext)
	if video == nil {
		containerOK = contains([]string{".mp3", ".m4a", ".mp4"}, ext)
	}
	if copyVideo && copyAudio && containerOK {
		event("Already playable — original picture and sound unchanged.", numberPointer(99))
		return unchanged("original", "")
	}
	if !copyVideo && (video.Transfer == "smpte2084" || video.Transfer == "arib-std-b67" || video.Primaries == "bt2020") {
		return unchanged("needs-hdr", "HDR original kept. Automatic SDR conversion is skipped to protect its colors.")
	}
	duration, _ := strconv.ParseFloat(info.Format.Duration, 64)
	outputExt := ".mp4"
	if video == nil {
		outputExt = ".m4a"
	}
	stem := strings.TrimSuffix(filepath.Base(source), filepath.Ext(source))
	chars := []rune(stem)
	if len(chars) > 150 {
		stem = string(chars[:150])
	}
	destination := filepath.Join(filepath.Dir(source), stem+" - Playable"+outputExt)
	for i := 2; ; i++ {
		if _, err := os.Stat(destination); os.IsNotExist(err) {
			break
		}
		destination = filepath.Join(filepath.Dir(source), fmt.Sprintf("%s - Playable %d%s", stem, i, outputExt))
	}
	temporary, err := os.CreateTemp(filepath.Dir(source), ".station-*"+outputExt)
	if err != nil {
		return unchanged("failed", "Original saved. No space or permission to create a playable copy.")
	}
	temp := temporary.Name()
	_ = temporary.Close()
	_ = os.Remove(temp)
	defer os.Remove(temp)
	args := []string{"-nostdin", "-v", "error", "-n", "-i", source, "-map", "0:V:0?", "-map", "0:a?", "-map_metadata", "0", "-map_chapters", "0", "-c:v", "copy", "-c:a", "copy"}
	if !copyVideo {
		args = append(args, "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-pix_fmt", "yuv420p", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-fps_mode", "passthrough", "-tag:v", "avc1")
	}
	for i, s := range audio {
		if s.CodecName != "aac" && s.CodecName != "mp3" {
			args = append(args, fmt.Sprintf("-c:a:%d", i), "aac", fmt.Sprintf("-b:a:%d", i), "320k")
		}
	}
	mode := "transcode"
	if copyVideo && copyAudio {
		mode = "remux"
	}
	event("Making a high-quality playable copy — original kept…", numberPointer(90))
	args = append(args, "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", temp)
	_, err = run(ffmpeg, args, duration)
	if cancelled() {
		return unchanged("cancelled", "Playable copy cancelled. Original kept.")
	}
	if err != nil {
		return unchanged("failed", "Original saved. Playable-copy conversion failed; the incomplete copy was discarded.")
	}
	check, err := readProbe(temp)
	outAudio := 0
	outVideo := 0
	for _, s := range check.Streams {
		if s.CodecType == "audio" {
			outAudio++
		}
		if s.CodecType == "video" {
			outVideo++
		}
	}
	outDuration, _ := strconv.ParseFloat(check.Format.Duration, 64)
	delta := outDuration - duration
	if delta < 0 {
		delta = -delta
	}
	tolerance := duration * 0.01
	if tolerance < 1 {
		tolerance = 1
	}
	if err != nil || outAudio != len(audio) || video != nil && outVideo != 1 || delta >= tolerance {
		return unchanged("failed", "Original saved. Playable-copy validation failed; the incomplete copy was discarded.")
	}
	// Link is exclusive: never overwrite another file, even if it appeared mid-job.
	if err = os.Link(temp, destination); err != nil {
		return unchanged("failed", "Original saved. The playable copy could not be finalized safely.")
	}
	note := "Playable copy ready — high-quality H.264/AAC. Original picture and sound kept in the source file."
	if copyAudio {
		note = "Playable copy ready — high-quality picture, original audio unchanged. Original kept."
	}
	if mode == "remux" {
		note = "Playable copy ready — picture and sound copied losslessly."
	}
	event(note, numberPointer(99))
	return playbackResult{destination, source, mode, ""}
}
