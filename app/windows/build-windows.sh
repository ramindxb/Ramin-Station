#!/bin/zsh
set -euo pipefail

root_dir="${0:A:h:h:h}"
app_source="$root_dir/app"
windows_source="$app_source/windows"
web_target="$windows_source/web"
version="$(node -p 'require(process.argv[1]).version' "$app_source/update-config.json")"
dist_dir="$root_dir/dist"
if [[ "${1:-}" == "--preview" ]]; then
  dist_dir="$root_dir/work/update-preview"
elif [[ -n "${1:-}" ]]; then
  echo "Usage: build-windows.sh [--preview]" >&2
  exit 1
fi
app_exe="$dist_dir/Ramin Station.exe"
setup_exe="$dist_dir/Ramin-Station-$version-Windows-Setup.exe"
portable_zip="$dist_dir/Ramin-Station-$version-Windows-Portable.zip"

build_scratch="$(mktemp -d)"
portable_stage=""
cleanup() {
  rm -rf "$build_scratch"
  if [[ -n "$portable_stage" ]]; then
    rm -rf "$portable_stage"
  fi
}
trap cleanup EXIT
export GOCACHE="$build_scratch/go-build"
mkdir -p "$GOCACHE"

mkdir -p "$web_target/assets" "$dist_dir" "$windows_source/installer/payload/licenses" "$windows_source/updater-payload"
cp "$app_source/index.html" "$app_source/download.html" "$app_source/compress.html" "$app_source/visual-brain.html" "$web_target/"
cp "$app_source/styles.css" "$app_source/tool.css" "$app_source/visual-brain.css" "$app_source/app.js" "$app_source/tool.js" "$app_source/visual-brain.js" "$web_target/"
cp "$app_source/updates.js" "$app_source/updates.css" "$web_target/"
cp "$app_source/update-config.json" "$windows_source/update-config.json"
cp -R "$app_source/assets/." "$web_target/assets/"

(cd "$app_source/updater" && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags='-H windowsgui -s -w' -o "$windows_source/updater-payload/StationUpdater.exe" ./cmd/station-updater)

cd "$windows_source"
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -mod=readonly -trimpath -ldflags="-H windowsgui -s -w" -o "$app_exe" .

portable_stage="$(mktemp -d)"
cp "$app_exe" "$portable_stage/Ramin Station.exe"
cp "$windows_source/README-Windows.txt" "$portable_stage/README.txt"
cp -R "$app_source/licenses" "$portable_stage/licenses"
rm -f "$portable_zip"
(cd "$portable_stage" && COPYFILE_DISABLE=1 /usr/bin/zip -q -r "$portable_zip" .)

cp "$app_exe" "$windows_source/installer/payload/Ramin Station.exe"
cp -Rf "$app_source/licenses/." "$windows_source/installer/payload/licenses/"
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -mod=readonly -trimpath -ldflags="-H windowsgui -s -w -X main.version=$version" -o "$setup_exe" ./installer

echo "$app_exe"
echo "$portable_zip"
echo "$setup_exe"
