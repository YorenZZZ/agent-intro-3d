#!/usr/bin/env bash
# Records the intro as it plays in build/Claude Intro 3D.app (run ./build.sh
# first) into an MP4 (30 fps unless FPS is given): the app plays over a
# 1280x800 stand-in window and renders it frame by frame (every animation
# frozen at each moment) once per output frame, so the video has the real
# timing however slow the snapshots are.
#
# Snapshots do not composite her clip's alpha the way live playback does (an
# alpha-mode mismatch in awakening.mov looked clean here but left a bright,
# speckled fringe on screen), so check her edges on a screen capture of a
# live `--play` too.
#
# The page is transparent where the app shows through (the corners, and the
# whole window as it fades out at the end), so each snapshot is laid over a
# plain colour standing in for the app's window (BG, Claude's dark
# background unless given). Encoded as is, those see-through pixels came out
# black, with the fading backdrop's colours at full strength (a red and
# purple ring at the end).
#
# SIZE=WxH records over a stand-in of that size instead of 1280x800 (the
# Claude window's own size, from ~/Library/Application Support/Claude/
# window-state.json, shows what is really seen).
#
# usage: [BG=#rrggbb] [SIZE=WxH] tools/record.sh OUT.mp4 [FPS]
# needs: ffmpeg
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:?usage: tools/record.sh OUT.mp4 [FPS]}"
fps="${2:-30}"
frames="$(mktemp -d)"
trap 'rm -rf "$frames"' EXIT

# -g: started in the background, so it never takes focus; the app renders
# off screen and ignores the mouse.
open -g -n -W "$root/build/Claude Intro 3D.app" --args --snapshot "$frames" "$(awk "BEGIN { printf \"%.4f\", 1 / $fps }")" \
  ${SIZE:+--size "$SIZE"}

list="$frames/list.txt"
previous=""
for frame in $(ls "$frames"/frame-*.png | sort); do
  ms="${frame##*/frame-}"
  ms="$((10#${ms%.png}))"
  if [[ -n "$previous" ]]; then
    printf "file '%s'\nduration %s\n" "$previous" "$(awk "BEGIN { printf \"%.3f\", ($ms - $previous_ms) / 1000 }")" >> "$list"
  fi
  previous="$frame"
  previous_ms="$ms"
done
printf "file '%s'\nduration 0.1\nfile '%s'\n" "$previous" "$previous" >> "$list"

size="$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$previous")"
ffmpeg -v error -y -f concat -safe 0 -i "$list" -f lavfi -i "color=c=${BG:-#262624}:s=$size:r=$fps" \
  -filter_complex "[0:v]fps=$fps[intro];[1:v][intro]overlay=shortest=1:format=auto" \
  -c:v libx264 -crf 18 -pix_fmt yuv420p "$out"
echo "wrote $out ($(ls "$frames"/frame-*.png | wc -l | tr -d ' ') snapshots)"
