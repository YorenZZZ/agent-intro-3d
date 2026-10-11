#!/usr/bin/env bash
# Builds the intro's pet-ending transition clips into Resources/web/layers/:
#   exit.mov     she leaps out through the top of the window, continuing
#                exactly from layers/awakening.mov's own last frame
#   landing.mov  she drops into the pet's spot and settles into its neutral
#                pose (Resources/web/pet/clips/poster.png)
# Both are HEVC+alpha, matted the same way as awakening.mov (tools/build-clip.py).
#
# exit.mov: build/source/pet/transition/exit.mp4 starts on idle-W3's own raw
# frame 140 (exit-first.png), the exact frame awakening.mov's last output
# frame is made from, so --align-to lines exit's first frame up on it
# geometrically. Her colour (--fit) and her chest star's brightness
# (--core/--core-start) are NOT recomputed from exit's own first frame --
# that would recalibrate her colour back toward the plate and restart the
# star from an ember, both visibly different from where awakening.mov's own
# chain (action-W3 --then idle-W3) actually left off. --fit's numbers are
# colour_fit's own output from that chain's frame 0 (build-clip.py prints
# them as "colour fit (a, b): ..." when run without --fit; action-W3's frame
# 0 is the plate image itself, so this never needs to change unless the
# plate or action clip changes); --core-start 12.0 sits well past
# core_level's 3.6s ember-to-lit rise, so the star is already lit throughout
# (awakening.mov is itself about 12s long by the time it hands over).
# No --shadow, same as awakening.mov: a shadow baked into her clip shows as a
# dark cast on her suit (between her arm and waist), and the sidebar pet she
# lands as has none either. --core and --width match awakening.mov's own
# (re-derived from the plate and checked against awakening.mov's actual last
# frame by pixel diff).
#
# exit.mp4's last ~23 raw frames (frame 74 on, after ~3.0s) are empty
# background: Vision (matte.swift) hallucinates a large phantom "person" blob
# on a frame with no real subject (confirmed directly: matte.swift run on
# frames 74, 76, 87 each produced a tall blob covering roughly a third of the
# frame, nowhere near her actual last position), so they are cut with --trim
# before matting ever sees them, not after. --trim 1:73 (not 1:72) keeps one
# frame past her last visible trace on purpose: frame 72 is her foot, still
# clearly present; frame 73 is visually all but empty (a sliver smaller than
# Vision's detector responds to) and its own matte comes back solid black --
# confirmed empty, not a guess -- so the clip ends on a frame that is already
# fully transparent instead of cutting while she is still mid-exit. Frame 74
# is the first frame to hallucinate, so the trim stops one frame short of it.
# Frames 45-66 are a near-static hold (she drifts/grows slowly
# but never truly stops) the brief described as unwanted; --squeeze (not
# --cut) speeds through it instead of ripple-deleting it, because a hard cut
# has to optical-flow-blend two frames far enough apart (she has visibly
# grown over 22 frames of "hold") to show as a brief double exposure, while
# --squeeze keeps every frame so each output frame still blends two genuinely
# adjacent source frames.
#
# Her leap (frames 38-43, ~1.54-1.75s) and her exit through the window's top
# edge (frames 69-72, ~2.83-2.96s) are both too fast for DIS flow to blend at
# all: per-frame motion (DIS flow magnitude and her silhouette's own
# displacement, both measured directly on exit.mp4) sits at 1-5 px through
# the clip's calm stretches and spikes past 100-170 px across exactly these
# frames (e.g. frame 41: 134 px flow / 138 px silhouette move; frame 71: 166
# px silhouette move) -- a pose change too large for optical flow to
# correspond, which blended as the reported double exposure (output frames
# ~94-99: a crouched and a rising pose overlaid, part see-through, with dark
# fragments of the shadow it was then built with riding the ghosted alpha).
# --snap holds the nearer
# source frame across both ranges instead of blending. The range includes 72
# (not just 69-71): frame 72 is still real content (her foot, shrinking fast
# as she clears the edge) and the 71-to-72 step is itself one of the huge
# ones above, so 72 needs the same no-neighbour-smoothing matte as 69-71 or
# matte_all would blend it 25% toward frame 71's much bigger, differently
# placed silhouette -- the same double exposure one layer down, in alpha.
# Because --snap flags intervals by either endpoint, including 72 also pulls
# the last interval (72 to 73, already-confirmed-empty, see above) into
# "hold the nearer frame" rather than optical flow: that interval was never a
# double-exposure risk (73 has no second pose to overlay), so on its own it
# would have faded smoothly, but 72's matte safety takes priority and the
# result -- her last trailing sliver (a few percent of the frame) holding for
# 2-3 output frames then cutting to fully transparent -- is not worth a
# second flag just to soften.
#
# landing.mov: build/source/pet/transition/landing.mp4 runs the other way
# (she falls in from empty canvas and lands on the pet's neutral pose), but
# build-clip.py's --align-to always registers a clip's own FIRST frame onto
# the plate. The clip is reversed (ffmpeg -vf reverse) before matting --
# putting her settled landing pose first, where --align-to can register it
# against landing-last.png -- and reversed back after. Its OWN leading ~8
# raw frames (empty canvas, before she enters) are the same Vision-hallucination
# hazard as exit.mp4's tail and are --trim'd the same way (post-reversal,
# so chronologically they are landing's last frames once reversed back).
# landing-last.png (not build/source/pet/A2-clean.png, the plate the other
# pet clips use) is passed as the plate argument too: A2-clean.png is a tight
# crop of her alone, and build-clip.py resizes the plate it is given to the
# clip's own frame size -- against a full 1080x1920 scene where she only
# fills the bottom-left corner, that stretches her illustration across the
# whole canvas and colour_fit calibrates against the wrong pixels entirely
# (confirmed: it printed a near-zero gain). landing-last.png is already a
# 1080x1920 composite with her at the right place and scale, so colour_fit
# calibrates against the real thing. No --shadow: the ground shadow is drawn
# by intro.js itself (a CSS ellipse matching the pet page's own), not baked
# into the clip, so it can fade in independently as she touches down.
#
# Her fast fall is the same too-fast-for-flow problem as exit.mp4's leap, but
# landing.mp4's background is busy enough that full-frame DIS flow magnitude
# is noisy throughout the whole clip (camera/background texture dominates the
# mean, not her); her silhouette's own frame-to-frame displacement (simple
# luma threshold, tracked directly, same method cross-checked against
# exit.mp4's own flow spikes there) is the reliable signal instead. In
# landing.mp4's own (forward, pre-reverse) time she is essentially still once
# landed (displacement under ~1 px for its first ~43 frames, already reversed
# here) through a brief settle (frames ~44-71, under ~17 px), then the fall
# itself: frames ~94-111 (reversed-clip numbering, since build-clip.py always
# sees the reversed source -- see above) spike to 46-197 px, framed on both
# sides by a ~20-43 px transition (90-93) and a ~48-76 px tail (112-113) right
# at the --trim 1:113 boundary. --snap 90:113 covers the spike plus both
# margins, so the whole fast segment holds the nearer source frame instead of
# blending.
#
# --islands 160: flow-blending two settle frames smears a stray dot of matte
# into a faint grey smudge beside her (alpha 52-104 of 255, measured on the
# built clip), which shows on Claude's light window; a real part of her is
# opaque, so 160 keeps every part of her and clears every smudge.
#
# --open-on the pet's poster: landing.mp4's last frame is a softer render of
# the same pose than the pet clips (Seedance renders each clip anew; aligned
# to 0 px, but the poster is crisper and the colour differs pixel by pixel,
# not by a cast a --fit could take out), and Swift swaps the pet in the
# instant 'landed' posts. So the clip's last 0.5 s, where she stands still
# (alpha within 0.03 of her last frame for its last second), dissolves into
# the poster itself, laid at intro.js's LANDING_BOX (--open-rect; a test
# keeps the two the same), and its last frame is the poster: the swap shows
# no seam. tools/build-pet.sh builds the poster, so it runs first.
#
# needs: the same as build-clip.py (macOS 14+, swiftc, ffmpeg with
# hevc_videotoolbox, numpy, opencv-python-headless, scipy); nice -n 20 and
# ffmpeg -threads 2 throughout, matting is CPU-heavy.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
python_bin="$root/build/venv/bin/python"
[[ -x "$python_bin" ]] || python_bin="python3"
src="$root/build/source/pet/transition"
out="$root/Resources/web/layers"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# awakening.mov's own colour_fit, from action-W3's frame 0 (== the plate, so
# this is stable): printed by `tools/build-clip.py build/source/whole/action-W3-9e6830df.mp4
# build/source/whole/W2-whole.png --trim 1:1` as "colour fit (a, b): ...".
FIT="0.862,16.315,0.836,17.694,0.824,20.976"
# The chest star's centre in clip px (1248x1664), found directly on a frame
# (track_core() re-finds it every frame within reach, so this only needs to
# be close): see the session's report for how it was located.
CORE="603,1148"

echo "== exit.mov =="
nice -n 20 "$python_bin" "$root/tools/build-clip.py" \
  "$src/exit.mp4" "$root/build/source/whole/W2-whole.png" \
  --trim 1:73 \
  --align-to "$src/exit-first.png" \
  --fit "$FIT" \
  --core "$CORE" --core-start 12.0 \
  --squeeze 45:66:3 \
  --snap 38:43,69:72 \
  --width 1248 --fps 60 --quality 50 \
  --out "$out/exit.mov" </dev/null

echo "== landing.mov =="
nice -n 20 ffmpeg -v error -y -i "$src/landing.mp4" -threads 2 -vf reverse \
  -c:v libx264 -crf 10 -pix_fmt yuv420p "$work/landing-reversed.mp4"
nice -n 20 "$python_bin" "$root/tools/build-clip.py" \
  "$work/landing-reversed.mp4" "$src/landing-last.png" \
  --trim 1:113 \
  --align-to "$src/landing-last.png" \
  --snap 90:113 \
  --islands 160 \
  --open-on "$root/Resources/web/pet/clips/poster.png" \
  --open-rect 0,0.7198,0.3741,0.2802 --open-seconds 0.5 \
  --width 1080 --fps 60 --quality 80 \
  --out "$work/landing-reversed-out.mov" </dev/null
# --quality 80 above is only this intermediate file's, encoded again just
# below; that last pass is -q:v 65, not exit.mov's 50: at 50 her last frame
# came out visibly softer than the poster it hands over to (Laplacian
# variance 189 vs the poster's 302; 253 at 65, for about 0.3 MB more).
nice -n 20 ffmpeg -v error -y -i "$work/landing-reversed-out.mov" -threads 2 -vf reverse \
  -c:v hevc_videotoolbox -alpha_quality 0.9 -q:v 65 -tag:v hvc1 -movflags +faststart \
  "$out/landing.mov"

ls -l "$out/exit.mov" "$out/landing.mov"
