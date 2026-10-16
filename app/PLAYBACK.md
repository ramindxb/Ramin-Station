# Automatic playable copies

Download and Visual Brain both have an **Auto playable copy** checkbox (on by default).
The saved preference is shared between the pages. Downloads stay in Downloads;
Visual Brain downloads stay in the app's managed library folder.

After yt-dlp reports the final filename, FFprobe inspects the actual streams, not
just the extension. Compatible files stay unchanged. Container-only fixes copy
the streams to MP4/M4A without re-encoding. Unsupported SDR video gets a separate
H.264 CRF 14 / slow / 8-bit 4:2:0 copy, keeping the frame rate and resolution
(odd dimensions are padded by at most one pixel). Compatible AAC/MP3 tracks are
copied unchanged; unsupported audio tracks become 320 kb/s AAC. All audio tracks
are retained. The original is never overwritten, including after cancellation,
missing tools, validation errors, or an encoder failure.

Re-encoding is **not mathematically lossless**. The original remains the lossless
source of truth. Original filenames are tracked separately in the library state.
HDR/wide-gamut video that would need SDR conversion is intentionally left alone
with a warning: silently flattening its colors would violate this policy.

On macOS the source and resulting copy are also checked with AVFoundation.
Windows uses a conservative H.264/AAC/MP3 compatibility policy (does not assume
optional HEVC extensions are installed). Output stream counts and duration are
validated before the temporary copy is finalized. Cancel/failure removes only
the temporary output, not the original.

Existing Visual Brain media: right-click a card → **Make playable copy**, or use
the card's preview button with Auto playable copy enabled. Managed files stream
locally with byte-range support; no remote media server or upload is involved.
Finder/Explorer reveals the selected playable file beside its original.

## Local verification

- `zsh app/native/build-macos.sh --preview` builds a separate local app and ZIP
  under `work/playback-preview`, without replacing published v2 packages.
- Normal release builds still use `zsh app/native/build-macos.sh` and
  `zsh app/windows/build-windows.sh`. Review and version a release before publishing.
- Browser preview: `node app/server.js` on 127.0.0.1:3186.
- Test isolation overrides: `RAMIN_STATION_MEDIA_ROOT`, `RAMIN_STATION_DOWNLOADS`,
  and (macOS) `RAMIN_STATION_STATE`. Do not set them for a normal release.

The browser prototype shares the policy, progress stream and secure managed-file
range serving, but does not run the AVFoundation-specific check.
