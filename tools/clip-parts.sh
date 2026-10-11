#!/usr/bin/env bash
# Her clip (Resources/web/layers/awakening.mov, about 15 MB) is kept in the
# repository as ~700 KB parts under Resources/clip/, with its SHA-256, so a
# push never carries one big file.
#
#   tools/clip-parts.sh split   after tools/build-clip.py: refresh the parts from the clip
#   tools/clip-parts.sh join    rebuild the clip from the parts (build.sh does this when it is missing)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
clip="$root/Resources/web/layers/awakening.mov"
parts="$root/Resources/clip"

case "${1:-}" in
  split)
    rm -rf "$parts" && mkdir -p "$parts"
    split -b 700k -a 2 "$clip" "$parts/awakening.mov."
    (cd "$root/Resources/web/layers" && shasum -a 256 awakening.mov) > "$parts/awakening.mov.sha256"
    echo "split into $(ls "$parts"/awakening.mov.?? | wc -l | tr -d ' ') parts"
    ;;
  join)
    cat "$parts"/awakening.mov.?? > "$clip.tmp"
    mv "$clip.tmp" "$clip"
    (cd "$root/Resources/web/layers" && shasum -a 256 -c "$parts/awakening.mov.sha256" >/dev/null) || {
      echo "awakening.mov does not match Resources/clip/awakening.mov.sha256" >&2
      exit 1
    }
    echo "joined $clip"
    ;;
  *)
    echo "usage: tools/clip-parts.sh split|join" >&2
    exit 2
    ;;
esac
