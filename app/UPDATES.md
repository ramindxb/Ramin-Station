# Ramin Station v2.1 updates

## User experience

- macOS: **File → Check for Updates…** in the native menu bar. No permanent update button on the main screens.
- Windows: a subtle `···` menu in the lower-left corner contains **Check for Updates…**.
- The app checks quietly at startup (successful checks are cached for 12 hours).
- Only a verified newer build shows the small **Update … available** notice in the lower-right corner. It never opens a dialog automatically.
- The notice disappears once the installed build matches or exceeds that release.
- **Update & Restart** is always an explicit user choice. Updates do not start while a media job is running.
- The browser prototype cannot install an app update; use a desktop build.

## Storage and trust

The helper is built from `app/updater` for macOS and Windows using Go's standard
library. macOS embeds a universal helper; Windows embeds its helper inside the
main EXE and reuses a versioned copy under the user's app data folder.

`update-config.json` is the single version/build/public-key/channel source.
The app tries the site's signed feed, then a GitHub Release fallback:

- `https://raminpiri.ir/station/updates/stable.json`
- `https://github.com/ramindxb/Ramin-Station/releases/latest/download/updates-stable.json`

The signed stable feed is published alongside approved release packages. Existing v2.0 clients
need one manual installation of v2.1 to get the updater. Do not treat a GitHub
release title or an unsigned checksum file as permission to execute an update.

The envelope contains base64-encoded manifest bytes plus an Ed25519 signature.
The manifest binds the product, channel, build, dates, package URL, exact size and
SHA-256 digest. The public key is pinned inside the app. HTTPS, approved download
hosts and redirect checks are mandatory. Invalid, expired, downgraded or unsigned
metadata cannot install anything. Cached newer verified metadata cannot be
replaced by an older signed feed. This is separate from Apple/Microsoft publisher
signing/notarization; it does not remove OS trust warnings.

## Installation and rollback

The helper downloads while the app remains open, validates the archive, rejects
unsafe archive paths/symlinks, stages beside the target, and backs up
`visual-brain.json` under `Ramin Station/Updates/jobs/<id>/`. It does not move,
replace or delete `Visual Brain Files`, Downloads, or the media-tool binaries.

After the app exits, the helper renames the old app as a temporary rollback copy,
installs the staged version, then waits for a matching healthy-start receipt from
the new app. A successful startup removes the old application backup. Failed
launch/startup restores the previous app and the backed-up library index; any
post-failure index is also retained beside the backup. If an OS lock/permission
prevents rollback, the previous app is retained and its location is recorded.
Read-only/translocated app locations are rejected before downloading; no elevated
installer or security bypass is attempted.

## Publishing (only after approval)

1. Increment `version` **and** numeric `build` in `app/update-config.json`.
   v2.1 uses semantic version `2.1.0`, build `210`; the UI displays `V2.1`.
2. Build/test both platforms. Run `go test ./...` in `app/updater` and
   `node --test app/tests/*.test.js` at the repository root.
3. Build the distributable archives. Sign only the final, unmodified artifacts:

   ```sh
   node app/updater/sign-update.js sign app/update-config.json dist release-notes/v2.1.0.md /absolute/private/path/station-update-private.pem
   ```

4. Upload the packages and `updates-stable.json` to the matching GitHub Release.
   Copy that **same signed envelope** to the site's `station/updates/stable.json`.
   Publish the feed only after both platform assets are uploaded and verified.
5. Test an actual previous-to-next-version update on macOS **and Windows** with
   populated Visual Brain libraries before enabling a stable public feed.

The local signing key is deliberately outside the repository, in the workspace's
`.station-update-secrets/` directory. The generator creates private files with
0600 permissions and will not replace an existing key. Back it up securely;
losing it requires a manually installed trust-key migration. Never upload the
private key to the website, include it in app packages, commit it, or paste it
into release notes/logs. GitHub Actions signing requires a separately configured
`STATION_UPDATE_PRIVATE_KEY` Actions secret; no secret was uploaded during this task.

Preview builds stay in `work/update-preview/`; they do not replace the published
v2 packages or change the website. A preview bundle has a separate macOS identity.
