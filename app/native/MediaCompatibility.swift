import Foundation
import AVFoundation

struct PlayableCopy {
    let file: URL
    let original: URL
    let mode: String
    let warning: String

    var result: [String: Any] {
        ["name": file.lastPathComponent, "path": file.path,
         "originalName": original.lastPathComponent, "compatibility": mode, "warning": warning]
    }
}

enum MediaCompatibility {
    typealias Runner = (String, [String], Double) throws -> (status: Int32, output: String)
    static let probeArguments = ["-v", "error", "-show_streams", "-show_format", "-of", "json"]

    // The original is never overwritten, including on failure or cancellation.
    static func prepare(_ source: URL, enabled: Bool, find: (String) -> String?,
                        run: Runner, cancelled: () -> Bool,
                        event: (String, Double?) -> Void) throws -> PlayableCopy {
        func unchanged(_ mode: String, _ warning: String = "") -> PlayableCopy {
            if !warning.isEmpty { event(warning, nil) }
            return PlayableCopy(file: source, original: source, mode: mode, warning: warning)
        }
        guard enabled else { return unchanged("disabled") }
        event("Checking playback compatibility…", 90)
        guard let ffprobe = find("ffprobe"), let ffmpeg = find("ffmpeg") else {
            return unchanged("unavailable", "Original saved. Playback check needs FFmpeg + ffprobe; run Setup / Update.")
        }
        let probe = try run(ffprobe, probeArguments + [source.path], 0)
        guard probe.status == 0, let data = probe.output.data(using: .utf8),
              let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let streams = info["streams"] as? [[String: Any]] else {
            return unchanged("failed", "Original saved, but its media format could not be checked.")
        }
        if cancelled() { throw NSError(domain: "Station", code: 1, userInfo: [NSLocalizedDescriptionKey: "Operation cancelled. Original kept."]) }
        let video = streams.first { $0["codec_type"] as? String == "video" && (($0["disposition"] as? [String: Any])?["attached_pic"] as? Int ?? 0) == 0 }
        let audio = streams.filter { $0["codec_type"] as? String == "audio" }
        guard video != nil || !audio.isEmpty else { return unchanged("original") }
        let codec = video?["codec_name"] as? String ?? ""
        let pixel = video?["pix_fmt"] as? String ?? ""
        let copyVideo = video == nil || (codec == "h264" && ["yuv420p", "yuvj420p"].contains(pixel)) || (codec == "hevc" && AVURLAsset(url: source).isPlayable)
        let copyAudio = audio.allSatisfy { ["aac", "mp3"].contains($0["codec_name"] as? String ?? "") }
        let containerOK = (video != nil ? ["mp4", "m4v", "mov"] : ["mp3", "m4a", "mp4"]).contains(source.pathExtension.lowercased())
        if copyVideo && copyAudio && containerOK && AVURLAsset(url: source).isPlayable {
            event("Already playable — original picture and sound unchanged.", 99)
            return unchanged("original")
        }
        // Do not silently flatten HDR, Dolby Vision, or wide-gamut video into SDR.
        if !copyVideo && (["smpte2084", "arib-std-b67"].contains(video?["color_transfer"] as? String ?? "") || (video?["color_primaries"] as? String ?? "") == "bt2020") {
            return unchanged("needs-hdr", "HDR original kept. Automatic SDR conversion is skipped to protect its colors.")
        }
        let duration = Double((info["format"] as? [String: Any])?["duration"] as? String ?? "0") ?? 0
        let ext = video == nil ? "m4a" : "mp4"
        let stem = String(source.deletingPathExtension().lastPathComponent.prefix(150))
        var destination = source.deletingLastPathComponent().appendingPathComponent("\(stem) - Playable.\(ext)")
        var index = 2
        while FileManager.default.fileExists(atPath: destination.path) {
            destination = source.deletingLastPathComponent().appendingPathComponent("\(stem) - Playable \(index).\(ext)")
            index += 1
        }
        let temporary = source.deletingLastPathComponent().appendingPathComponent(".station-\(UUID().uuidString).\(ext)")
        defer { try? FileManager.default.removeItem(at: temporary) }
        var args = ["-nostdin", "-v", "error", "-n", "-i", source.path, "-map", "0:V:0?", "-map", "0:a?", "-map_metadata", "0", "-map_chapters", "0", "-c:v", "copy", "-c:a", "copy"]
        if !copyVideo {
            args += ["-c:v", "libx264", "-preset", "slow", "-crf", "14", "-pix_fmt", "yuv420p", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-fps_mode", "passthrough", "-tag:v", "avc1"]
        } else if codec == "hevc" { args += ["-tag:v", "hvc1"] }
        for (index, stream) in audio.enumerated() where !["aac", "mp3"].contains(stream["codec_name"] as? String ?? "") {
            args += ["-c:a:\(index)", "aac", "-b:a:\(index)", "320k"]
        }
        let mode = copyVideo && copyAudio ? "remux" : "transcode"
        event(mode == "remux" ? "Making a playable MP4 — copying picture and sound without re-encoding…" : "Making a high-quality playable copy — original kept…", 90)
        args += ["-movflags", "+faststart", "-progress", "pipe:1", "-nostats", temporary.path]
        let encoded = try run(ffmpeg, args, duration)
        if cancelled() { throw NSError(domain: "Station", code: 1, userInfo: [NSLocalizedDescriptionKey: "Operation cancelled. Original kept."]) }
        guard encoded.status == 0, AVURLAsset(url: temporary).isPlayable else {
            return unchanged("failed", "Original saved. A playable copy could not be verified; no original was changed.")
        }
        let check = try run(ffprobe, probeArguments + [temporary.path], 0)
        guard check.status == 0, let bytes = check.output.data(using: .utf8),
              let verified = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let outStreams = verified["streams"] as? [[String: Any]],
              outStreams.filter({ $0["codec_type"] as? String == "audio" }).count == audio.count,
              abs((Double((verified["format"] as? [String: Any])?["duration"] as? String ?? "0") ?? 0) - duration) < max(1, duration * 0.01) else {
            return unchanged("failed", "Original saved. Playable-copy validation failed; the incomplete copy was discarded.")
        }
        try FileManager.default.moveItem(at: temporary, to: destination)
        let note = mode == "remux" ? "Playable copy ready — picture and sound copied losslessly." : (copyAudio ? "Playable copy ready — high-quality picture, original audio unchanged. Original kept." : "Playable copy ready — high-quality H.264/AAC. Original picture and sound kept in the source file.")
        event(note, 99)
        return PlayableCopy(file: destination, original: source, mode: mode, warning: "")
    }
}
