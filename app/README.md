# Ramin Station 2.1

This desktop release uses the supplied layered PSD as the exact visual source. The original PSD is preserved unchanged.

## Layer mapping

- `Download Clicked` + `Download Distance` → initial selected/pressed key
- `Compress Not Clicked` + `Compress` → initial raised key
- `Ramin Logo` and `Layer 2` → static chassis/background artwork

## Release packages

- macOS installer image: `dist/Ramin-Station-2.1.0-macOS.dmg`
- macOS archive: `dist/Ramin-Station-2.1.0-macOS.zip`
- Windows installer: `dist/Ramin-Station-2.1.0-Windows-Setup.exe`
- Windows portable archive: `dist/Ramin-Station-2.1.0-Windows-Portable.zip`

The release is friends-only and unsigned. macOS may require Control-click → Open on first launch; Windows SmartScreen may show Unknown Publisher.

## Development preview

Double-click `start.command` to run the browser prototype at `http://127.0.0.1:3186`. The native macOS and Windows packages above are the V2 release and include the independent tool manager.

## Features

- Checks FFmpeg, yt-dlp and Deno, and installs verified app-managed copies when needed. Homebrew is not required by the native app.
- Downloads video as MP4 at 1080p, 720p, or 480p.
- Extracts audio as MP3 at source, 256K, or 128K quality.
- Compresses one selected video or a full folder to HEVC/H.265 with High, Balanced, and Tiny presets.
- Creates large, edit-friendly ProRes Proxy MOV files through the Decompress / Faster Edit mode.
- Saves media directly in `Downloads`; compressed and edit-ready outputs use separate folders beside the originals.
- Shows live download/compression logs and progress inside the retro terminal.
- Allows an active yt-dlp or FFmpeg job to be cancelled.
- The three colored controls close, minimize, and toggle full screen/maximize in both desktop apps.
- The Ramin logo opens the Support page at `https://raminpiri.ir/station`.
- YouTube access first tries the public link, then retries with browser cookies. A Netscape `cookies.txt` file can be selected when macOS privacy blocks Safari cookie access.
- Standard Ctrl+V and Command+V paste are supported through the native clipboard bridge.
- The application icon uses the supplied Ramin Station artwork.
- Visual Brain organizes local media and saved links by category, with five pinned Motivation items, editable notes, and searchable client hashtags.
- New Visual Brain file imports are copied to the app's managed `Visual Brain Files` folder, with a reveal action for Finder or Explorer.
- Saved Visual Brain links include an inline background Download control that becomes a local-file card on completion.
- Optional automatic playable copies preserve originals; see `PLAYBACK.md` for codec/quality details.
- Discreet, signed in-app updates with library-index backup and failed-start rollback; see `UPDATES.md` for release setup.

Third-party license texts for the Windows runtime dependencies are included in `licenses/` and are copied into every Windows package. FFmpeg, yt-dlp, and Deno are downloaded on demand from their upstream release pages and are not bundled in this repository or its application packages.
