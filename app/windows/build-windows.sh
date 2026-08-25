#!/bin/zsh
set -euo pipefail

root_dir="${0:A:h:h:h}"
app_source="$root_dir/app"
windows_source="$app_source/windows"
web_target="$windows_source/web"
dist_dir="$root_dir/dist"
app_exe="$dist_dir/Ramin Station.exe"
setup_exe="$dist_dir/Ramin-Station-1.0-Windows-Setup.exe"
portable_zip="$dist_dir/Ramin-Station-1.0-Windows-Portable.zip"

mkdir -p "$web_target/assets" "$dist_dir" "$windows_source/installer/payload/licenses"
cp "$app_source/index.html" "$app_source/download.html" "$app_source/compress.html" "$web_target/"
cp "$app_source/styles.css" "$app_source/tool.css" "$app_source/app.js" "$app_source/tool.js" "$web_target/"
cp -R "$app_source/assets/." "$web_target/assets/"

cd "$windows_source"
gofmt -w main.go installer/main.go
go mod tidy
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-H windowsgui -s -w" -o "$app_exe" .

portable_stage="$(mktemp -d)"
trap 'rm -rf "$portable_stage"' EXIT
cp "$app_exe" "$portable_stage/Ramin Station.exe"
cp "$windows_source/README-Windows.txt" "$portable_stage/README.txt"
cp -R "$app_source/licenses" "$portable_stage/licenses"
rm -f "$portable_zip"
(cd "$portable_stage" && COPYFILE_DISABLE=1 /usr/bin/zip -q -r "$portable_zip" .)

cp "$app_exe" "$windows_source/installer/payload/Ramin Station.exe"
cp -R "$app_source/licenses/." "$windows_source/installer/payload/licenses/"
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-H windowsgui -s -w" -o "$setup_exe" ./installer

echo "$app_exe"
echo "$portable_zip"
echo "$setup_exe"
