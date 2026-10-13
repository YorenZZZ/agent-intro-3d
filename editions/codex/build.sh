#!/usr/bin/env bash
# Builds "Codex Intro 3D.app" (universal, ad-hoc signed) into build/.
#
#   ./build.sh              build only
#   ./build.sh --install    build, put it in /Applications and start it
#   ./build.sh --uninstall  stop it, take it out of login items, move it to the Trash
#
# needs: macOS 14+, Xcode Command Line Tools (swiftc, codesign); sips and
# iconutil come with macOS
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
name="Codex Intro 3D"
bundle_id="io.github.yorenzzz.codex-intro-3d"
installed="/Applications/$name.app"

quit_running() {
  pkill -f "$name.app/Contents/MacOS/codex-intro-3d" 2>/dev/null || true
}

if [[ "${1:-}" == "--uninstall" ]]; then
  if [[ -d "$installed" ]]; then
    open -n -W "$installed" --args --uninstall
    quit_running
    trashed="$HOME/.Trash/$name $(date +%Y%m%d-%H%M%S).app"
    mv "$installed" "$trashed"
    echo "removed from login items; moved to the Trash as $(basename "$trashed")"

  else
    echo "$installed is not installed"
  fi
  exit 0
fi

build="$root/build"
app="$build/$name.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

for arch in arm64 x86_64; do
  swiftc -O -module-cache-path "$build/swift-module-cache" -target "$arch-apple-macosx14.0" \
    -framework AppKit -framework WebKit -framework ServiceManagement \
    -o "$build/codex-intro-3d-$arch" "$root"/Sources/*.swift
done
lipo -create -output "$app/Contents/MacOS/codex-intro-3d" "$build/codex-intro-3d-arm64" "$build/codex-intro-3d-x86_64"
rm -f "$build/codex-intro-3d-arm64" "$build/codex-intro-3d-x86_64"

cp "$root/Resources/Info.plist" "$app/Contents/Info.plist"
# The icon: every size iconutil wants, from the one 1024px source.
iconset="$build/AppIcon.iconset"
rm -rf "$iconset" && mkdir -p "$iconset"
sips -s format png "$root/Resources/AppIcon.webp" --out "$build/icon-1024.png" >/dev/null
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$build/icon-1024.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" "$build/icon-1024.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"
rm -rf "$iconset" "$build/icon-1024.png"
# Every video is kept as parts (tools/clip-parts.sh); a fresh clone has only
# those, so rebuild whichever are missing.
"$root/tools/clip-parts.sh" join
# Copies web/pet/ too (index.html, pet.js, clips/). If the pet's clips.json
# or *.mov haven't been built yet (tools/build-pet.sh), ditto just copies
# whatever is there; PetController logs a reason and stays hidden at runtime.
ditto "$root/Resources/web" "$app/Contents/Resources/web"
printf 'APPL????' > "$app/Contents/PkgInfo"

codesign --force --sign - --identifier "$bundle_id" --timestamp=none "$app"
codesign --verify "$app"
echo "built $app"

if [[ "${1:-}" == "--install" ]]; then
  quit_running
  if [[ -d "$installed" ]]; then
    [[ "$(defaults read "$installed/Contents/Info.plist" CFBundleIdentifier 2>/dev/null)" == "$bundle_id" ]] || {
      echo "$installed belongs to another app; not replacing it" >&2
      exit 1
    }
    rm -rf "$installed"
  fi
  ditto "$app" "$installed"
  touch "$installed"
  open "$installed"
  echo "installed $installed; it now opens at login and waits for Codex to start"
fi
