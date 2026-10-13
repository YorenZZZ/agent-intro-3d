#!/usr/bin/env bash
# Bakes the cut-in's effects into still layers, so the animation itself only
# moves and fades images (which the GPU composites) and never re-runs a
# filter per frame. Reads art/character.webp and art/drone.webp, writes
# Resources/web/layers/*.webp:
#   body    the character as she is, nothing drawn around her (the still
#           that stands in when her clip cannot play)
#   drone   the drone as it is
# art/character.webp is the whole plate (with her painted hips and thighs)
# 624 px wide, so every character layer fills the same box as her clip. needs: ImageMagick, cwebp
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/Resources/web/layers"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$out"

webp() { cwebp -quiet -q "${3:-82}" -alpha_q 85 -m 6 -sharp_yuv "$1" -o "$out/$2.webp"; }

magick "$root/art/character.webp" "$work/char.png"
webp "$work/char.png" body

webp "$root/art/drone.webp" drone

# No silhouette layers: a still outline cannot follow her clip.
rm -f "$out/hair.webp" "$out/shadow.webp" "$out/ghost.webp" "$out/white.webp"
ls -l "$out"
