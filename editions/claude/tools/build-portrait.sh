#!/usr/bin/env bash
# Rebuilds art/character.webp (and art/drone.webp) from her plate and the
# drone render: lifts the subjects out with macOS Vision and saves them as
# WebP with alpha, then bakes the still layers (build-layers.sh). Her alpha
# is made solid a few pixels inside her outline, so nothing behind her shows
# through her body (Vision leaves dark clothing partly transparent).
#
# usage: tools/build-portrait.sh <plate> [drone render]
#   plate: the first frame of her clip, the whole wrench inside it (3:4, or
#          taller with her painted hips and thighs: tools/extend-plate.py);
#          stored whole, 624 px wide, so it lines up with the clip
#          (Resources/web/intro.js places both in CHAR_BOX)
#   drone: an image of the drone alone, trimmed to it with a 5% margin and
#          stored at 300x300
# needs: macOS 14+, swiftc (Xcode Command Line Tools), ImageMagick, cwebp
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
source_image="${1:?usage: tools/build-portrait.sh <plate> [drone render]}"
drone_image="${2:-}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/character" "$work/drone"

swiftc -O -o "$work/cutout" "$root/tools/cutout.swift"
"$work/cutout" "$source_image" "$work/character" >/dev/null
# Solid inside: close small holes, keep 3 px of Vision's soft edge.
magick "$work/character/all.png" -alpha extract -threshold 40% -morphology Close Disk:4 \
  -morphology Erode Disk:3 -blur 0x1 "$work/inner.png"
magick "$work/character/all.png" \( +clone -alpha extract "$work/inner.png" -compose Lighten -composite \) \
  -alpha off -compose CopyOpacity -composite -resize '624x' "$work/character.png"
cwebp -quiet -q 82 -alpha_q 85 -m 6 -sharp_yuv "$work/character.png" -o "$root/art/character.webp"

if [[ -n "$drone_image" ]]; then
  "$work/cutout" "$drone_image" "$work/drone" >/dev/null
  magick "$work/drone/all.png" -trim +repage -background none -gravity center \
    -extent "%[fx:max(w,h)*1.1]x%[fx:max(w,h)*1.1]" -resize '300x300!' "$work/drone.png"
  cwebp -quiet -q 82 -alpha_q 85 -m 6 "$work/drone.png" -o "$root/art/drone.webp"
fi

bash "$root/tools/build-layers.sh"
