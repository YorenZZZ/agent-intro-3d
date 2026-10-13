#!/usr/bin/env bash
# Builds every pet clip tools/pet-clips.json lists into Resources/web/pet/clips/
# (HEVC+alpha, 512 px wide, 60 fps) with tools/build-clip.py --align-to the
# plate (so every pose lines up on it; no --core, --shadow or --extend: the
# pet is her plain clip, matted, nothing drawn around her), a
# per-clip metadata file under build/pet/<name>.json (--meta) and a preview
# under build/pet/<name>.preview.mp4. idle's own build also writes the poster
# every clip shares (--poster): her neutral pose, shown before any clip has
# loaded. A clip whose source .mp4 is missing (sit/feet/snap/click may not be
# recorded yet) is skipped with a message; the runtime only needs idle.
# Finally tools/pet-manifest.py merges the per-clip metas into clips/clips.json
# (the contract schema Resources/web/pet/index.html's runtime reads).
#
# She sits on Codex's light sidebar, where any of the dark blue backdrop
# left in her shows as a black smudge, so the matte is cleaner than the
# intro's (which sits on a dark band):
#   --hair-zone auto     the backdrop between her hair strands is taken out
#                        in each frame's own head zone (she sits down, so no
#                        one fixed zone fits), never down at her belt or gloves
#   --hair-dark 45,100   and darker, greyer blue than the intro takes
#   --hair-blue 4,12     (--hair-blue): strands mixed with the backdrop are
#                        greyer than it and go partly see-through, so her hair
#                        reads strand by strand instead of over black
#   --hair-strands 400   gaps smaller than this (clip px) are thin gaps between
#                        strands and go by colour alone (a glove or the
#                        wrench's dark metal is bigger and keeps its test)
#   --edge-fit           her soft outline's alpha comes from its colour, so no
#                        dark blue rim frays her outline on the light window
#
# usage: tools/build-pet.sh [CONFIG.json]   (default tools/pet-clips.json)
# needs: the venv at build/venv (numpy/opencv-python-headless/scipy), or a
#        system python3 with them; ffmpeg with hevc_videotoolbox; swiftc
#        (tools/matte.swift, built by build-clip.py)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
config="${1:-$root/tools/pet-clips.json}"
python_bin="$root/build/venv/bin/python"
[[ -x "$python_bin" ]] || python_bin="python3"

out_dir="$root/Resources/web/pet/clips"
meta_dir="$root/build/pet"
mkdir -p "$out_dir" "$meta_dir"

plate_rel="$("$python_bin" -c "import json; print(json.load(open('$config'))['plate'])")"
plate="$root/$plate_rel"
[[ -f "$plate" ]] || { echo "plate not found: $plate_rel" >&2; exit 1; }

# name, kind, source, trim, drop, seconds (tab-separated; the last three are
# empty when a clip does not set them).
rows="$("$python_bin" - "$config" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
for c in cfg['clips']:
    print('\t'.join([c['name'], c['kind'], c['source'], str(c.get('trim', '')), str(c.get('drop', '')), str(c.get('seconds', ''))]))
PY
)"

built=()
while IFS=$'\t' read -r name kind source trim drop seconds; do
  [[ -z "$name" ]] && continue
  src="$root/$source"
  if [[ ! -f "$src" ]]; then
    echo "$name: source missing ($source), skipped"
    continue
  fi
  args=(--align-to "$plate" --width 512 --fps 60 --quality 50
        --hair-zone auto --hair-dark 45,100 --hair-blue 4,12 --hair-strands 400 --edge-fit
        --out "$out_dir/$name.mov" --meta "$meta_dir/$name.json" --preview "$meta_dir/$name.preview.mp4")
  [[ -n "$trim" ]] && args+=(--trim "$trim")
  [[ -n "$drop" ]] && args+=(--drop "$drop")
  [[ -n "$seconds" ]] && args+=(--seconds "$seconds")
  [[ "$name" == "idle" ]] && args+=(--poster "$out_dir/poster.png")
  echo "== $name ($kind) =="
  # </dev/null: build-clip.py shells out to swiftc, the matte tool and ffmpeg
  # without redirecting their stdin; left connected to this loop's input (the
  # here-string below), one of them can steal a byte from the next line and
  # corrupt the next clip's name (seen once: "feet" read back as "eet").
  nice -n 20 "$python_bin" "$root/tools/build-clip.py" "$src" "$plate" "${args[@]}" </dev/null
  built+=("$name")
done <<<"$rows"

if [[ ${#built[@]} -eq 0 ]]; then
  echo "no pet clip source found; clips.json not written" >&2
  exit 1
fi

nice -n 20 "$python_bin" "$root/tools/pet-manifest.py" --config "$config" --meta-dir "$meta_dir" --clips-dir "$out_dir" --out "$out_dir/clips.json"
