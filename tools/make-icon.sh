#!/usr/bin/env bash
# Builds Resources/AppIcon.webp (1024px) from the character layer: her face
# on the band's navy, inside the macOS icon shape, with an orange rim.
# build.sh turns it into AppIcon.icns. needs: ImageMagick, cwebp
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# 1024 canvas, content in a 824 rounded square at 100,100 (radius 184).
magick -size 1024x1024 xc:none -fill white -draw 'roundrectangle 100,100 923,923 184,184' "$work/shape.png"
magick -size 824x824 gradient:'#1a2444'-'#07070f' -rotate 315 -gravity center -extent 824x824 \
  \( -size 824x824 radial-gradient:'rgba(255,138,42,0.45)'-'rgba(255,138,42,0)' \) -compose screen -composite \
  "$work/back.png"
magick "$root/art/character.webp" -crop 560x560+250+170 +repage -resize 900x900 "$work/face.png"
magick -size 1024x1024 xc:none "$work/back.png" -geometry +100+100 -composite \
  "$work/face.png" -geometry +80+120 -composite \
  "$work/shape.png" -compose DstIn -composite \
  \( "$work/shape.png" -alpha extract -morphology EdgeIn Disk:7 -background '#ff8a2a' -alpha shape \) -compose over -composite \
  "$work/icon.png"

cwebp -quiet -q 88 -alpha_q 90 -m 6 "$work/icon.png" -o "$root/Resources/AppIcon.webp"
cp "$work/icon.png" "${1:-/dev/null}" 2>/dev/null || true
echo "wrote $root/Resources/AppIcon.webp"
