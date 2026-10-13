#!/usr/bin/env bash
# Every video the app ships (her intro clip, the jump out and the landing,
# and the sidebar pet's clips) is kept in the repository as ~700 KB parts
# under Resources/clip/, each with its SHA-256, so a push never carries one
# big file. Parts are named after the video: Resources/clip/sit.mov.aa, ...
#
#   tools/clip-parts.sh split [name ...]   refresh the parts of these videos
#                                          (all when none given) from the files
#   tools/clip-parts.sh join               rebuild every video that is missing
#                                          from its parts (build.sh does this)
#   tools/clip-parts.sh join --force       rebuild all of them
#   tools/clip-parts.sh list               the videos, relative to Resources/web
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
web="$root/Resources/web"
parts="$root/Resources/clip"
# Relative to Resources/web; basenames must stay unique (parts share one folder).
clips=(
  layers/awakening.mov
  layers/exit.mov
  layers/landing.mov
  pet/clips/idle.mov
  pet/clips/sit.mov
  pet/clips/feet.mov
  pet/clips/snap.mov
  pet/clips/click.mov
)

split_one() {
  local rel="$1" base
  base="$(basename "$rel")"
  [[ -f "$web/$rel" ]] || { echo "missing $web/$rel" >&2; exit 1; }
  rm -f "$parts/$base".?? "$parts/$base.sha256"
  split -b 700k -a 2 "$web/$rel" "$parts/$base."
  (cd "$web/$(dirname "$rel")" && shasum -a 256 "$base") > "$parts/$base.sha256"
  echo "$base: $(ls "$parts/$base".?? | wc -l | tr -d ' ') parts"
}

join_one() {
  local rel="$1" base
  base="$(basename "$rel")"
  cat "$parts/$base".?? > "$web/$rel.tmp"
  mv "$web/$rel.tmp" "$web/$rel"
  (cd "$web/$(dirname "$rel")" && shasum -a 256 -c "$parts/$base.sha256" >/dev/null) || {
    echo "$rel does not match Resources/clip/$base.sha256" >&2
    exit 1
  }
  echo "joined $rel"
}

case "${1:-}" in
  split)
    shift
    mkdir -p "$parts"
    for rel in "${clips[@]}"; do
      if [[ $# -eq 0 ]] || [[ " $* " == *" $(basename "$rel" .mov) "* ]]; then split_one "$rel"; fi
    done
    ;;
  join)
    for rel in "${clips[@]}"; do
      if [[ "${2:-}" == "--force" ]] || [[ ! -f "$web/$rel" ]]; then join_one "$rel"; fi
    done
    ;;
  list)
    printf '%s\n' "${clips[@]}"
    ;;
  *)
    echo "usage: tools/clip-parts.sh split [name ...] | join [--force] | list" >&2
    exit 2
    ;;
esac
