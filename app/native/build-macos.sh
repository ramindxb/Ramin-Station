#!/bin/zsh
set -euo pipefail

root_dir="${0:A:h:h:h}"
app_source="$root_dir/app"
native_source="$app_source/native"
bundle="$root_dir/dist/Ramin Station.app"
contents="$bundle/Contents"
zip_path="$root_dir/dist/Ramin-Station-1.0-macOS.zip"
dmg_path="$root_dir/dist/Ramin-Station-1.0-macOS.dmg"

rm -rf "$bundle" "$zip_path" "$dmg_path"
mkdir -p "$contents/MacOS" "$contents/Resources/app/assets"

swiftc -parse-as-library -swift-version 5 -O -target arm64-apple-macosx13.0 \
  -framework AppKit -framework WebKit \
  "$native_source/RaminStation.swift" \
  -o "$contents/MacOS/RaminStation-arm64"

if swiftc -parse-as-library -swift-version 5 -O -target x86_64-apple-macosx13.0 \
  -framework AppKit -framework WebKit \
  "$native_source/RaminStation.swift" \
  -o "$contents/MacOS/RaminStation-x86_64"; then
  lipo -create "$contents/MacOS/RaminStation-arm64" "$contents/MacOS/RaminStation-x86_64" -output "$contents/MacOS/RaminStation"
  rm "$contents/MacOS/RaminStation-arm64" "$contents/MacOS/RaminStation-x86_64"
else
  mv "$contents/MacOS/RaminStation-arm64" "$contents/MacOS/RaminStation"
fi

cp "$native_source/Info.plist" "$contents/Info.plist"
cp "$native_source/AppIcon.icns" "$contents/Resources/AppIcon.icns"
cp -R "$app_source/licenses" "$contents/Resources/licenses"
cp "$app_source/index.html" "$app_source/download.html" "$app_source/compress.html" "$contents/Resources/app/"
cp "$app_source/styles.css" "$app_source/tool.css" "$app_source/app.js" "$app_source/tool.js" "$contents/Resources/app/"
cp -R "$app_source/assets/." "$contents/Resources/app/assets/"

codesign --force --deep --sign - "$bundle"
codesign --verify --deep --strict "$bundle"
ditto -c -k --sequesterRsrc --keepParent "$bundle" "$zip_path"

dmg_stage="$(mktemp -d)"
trap 'rm -rf "$dmg_stage"' EXIT
ditto "$bundle" "$dmg_stage/Ramin Station.app"
ln -s /Applications "$dmg_stage/Applications"
hdiutil create -quiet -volname "Ramin Station 1.0" -srcfolder "$dmg_stage" -ov -format UDZO "$dmg_path"

echo "$bundle"
echo "$zip_path"
echo "$dmg_path"
