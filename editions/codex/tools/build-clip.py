#!/usr/bin/env python3
"""Turns a Seedance clip of the character into Resources/web/layers/awakening.mov,
the moving character the band plays: HEVC with an alpha channel, 60 fps,
nothing drawn around her (no rim light or glow), so she stands in the band
as a model, not a cut-out; --shadow adds only a faint, soft shadow of her
under her.

The clip is made from the full-body plate (its first frame), the same
1248x1664 image tools/build-portrait.sh cuts the still layers from. For
each source frame:
  - her matte comes from macOS Vision (tools/matte.swift); small holes
    where her black gloves meet the dark plate are closed, and the matte is
    smoothed over three frames so the edges of her hair do not flicker;
  - colours are pulled back to the plate with a per-channel gain and offset
    fitted on her pixels in the first frame, so the clip starts on the
    illustration itself;
  - the plate's colour is taken out of her soft edges (the background is
    estimated around her), so no dark fringe shows against the band;
  - the blue cast the plate's backdrop leaves on her is taken out (deblue).
Frames Seedance repeated to fill 24 fps are dropped and the rest retimed
(unrepeat); frames given with --drop (Seedance sometimes cross-fades two
poses into one frame: a see-through, doubled arm) are left out without
retiming, so the clip flows over the gap. Her matte is smoothed over three
frames only at her edges: inside her she is opaque in every frame, so a hand
that moves fast does not turn see-through. The source is then interpolated to
60 fps along DIS optical flow in both directions (premultiplied, so edges
blend correctly), and the frames are piped, still premultiplied (the alpha
mode VideoToolbox tags the clip with), to its HEVC encoder with alpha.

--core re-lights the star on her chest frame by frame (tracked from X,Y in
the first frame): it starts as a dim ember and smoothly comes to life
(core_level), without flicker. --core-start adds seconds to its clock, so a
clip built standalone (--align-to) can pick up already lit, matching the clip
it continues from instead of re-running the rise from an ember.

--fit a0,b0,a1,b1,a2,b2 supplies colour_fit's per-channel (gain, offset)
directly (as its own "colour fit" line prints them) instead of computing them
from this clip's own frame 0: for a clip built standalone that must carry
another clip's colour correction, whose frame 0 (what colour_fit would
otherwise calibrate against) this run never decodes.

Seedance often holds still for its last few frames; --trim A:B keeps source
frames A..B (numbered from 1) and --seconds S retimes what is left. --then
appends a second clip made from the first one's last frame (her idle after
the action), with its own --then-trim, --then-drop, --then-cut and
--then-seconds. Seedance redraws that frame a little larger or shifted, so
the second clip is first laid onto the first one's last frame (align), or she
would jump there.

--cut A:B (and --then-cut) ripple-deletes source frames A..B (numbered from
1, inclusive, same numbering as --trim): unlike --drop, which leaves every
kept frame at its original time (right for one bad frame among many, such as
a cross-fade, where the pacing either side should not shift), --cut closes
the gap by moving every later frame's time back by the cut range's width, so
a held pose can be cut out of the middle of a clip without slowing it down.
Good for a true hold (consecutive frames barely differ); if she keeps
drifting through the range (growing or turning a little every frame, never
quite still), the frames either side of the cut can still differ enough that
optical flow blends them as a brief double exposure, since interpolation
always runs between the two now-adjacent kept frames regardless of how
different they are. --squeeze A:B:R (and --then-squeeze) speeds up frames
A..B by R times instead: every frame is kept, so every output frame still
blends between two genuinely adjacent source frames, and the hold just plays
back faster, which avoids that blend for a drifting hold.

--snap A:B[,C:D,..] (and --then-snap) marks source frames too fast for
optical flow to bridge at all: real motion that crosses much of the frame in
one 24 fps step (a leap, a fall), where DIS flow between the two frames
either side finds no real correspondence and the blend shows as a double
exposure -- two poses overlaid, part of her see-through, with dark fragments
where the blend pulled in --shadow's black -- rather than motion. Any output
frame that would blend between two kept source frames, where either one's
raw number falls in A..B (numbered from 1, inclusive, same numbering as
--trim/--cut/--squeeze), instead just holds whichever of the two is nearer
in time, unblended (animation on twos: each kept source frame covers 2-3
output frames at 60 fps from 24), the same as a frame already falls back to
right at the end of the clip (t < 1e-4, see the main loop). Her matte for
these frames also skips matte_all's usual 3-frame smoothing (the same
double-exposure problem one layer down, in alpha); each frame's own matte is
still hole-filled and solidified on its own (solid()) exactly as usual, only
the cross-frame averaging is skipped. Order of operations in load(): trim,
then unrepeat (drops judder frames), then drop, then cut (both ripple-delete,
changing which raw numbers survive into `keep`), then squeeze (retimes but
never removes a frame), then snap -- resolved last so it only asks, of the
raw numbers still present after drop/cut, which fall in A..B; squeeze's
retiming does not change which pairs of kept frames are adjacent, so its
order relative to snap does not matter. A number cut or dropped away is
simply absent from `keep` and never matches a --snap range, same as it would
no longer match a --squeeze range.

--extend paints her below her waist (the clip's bottom edge): REST is the
plate redrawn taller with her hips and thighs (her right hand hanging by her
thigh), --extend-free the same picture without that forearm and hand; see
extend(). The clip gets --extend-px plate px taller.

--fps sets the output rate (default 60; every use of the old fixed constant
follows it). --align-to PLATE.png lines the clip up on a plate with align()
(the same registration --then uses to lay a second clip onto the first) before
anything else runs, for a clip generated straight from the plate with no
--then chain; the plate is resized to the clip's own frame size first (it may
be a different resolution), and the estimated transform is logged like
--then's.

--meta OUT.json writes per-clip playback metadata for the desktop pet (frames,
seconds, fps, size, box, from, to, safe, mask; see Resources/web/pet's
contract): her alpha bbox in output frame 0 (box); where playback can start,
skipping a leading hold on the neutral pose (from), and where it ends, handing
over at a trailing hold instead of a frozen tail (to); frames close enough to
frame 0 to hand over to another clip (safe, --safe-threshold; the per-frame
distance from frame 0 is printed to stderr so the threshold can be tuned); and
a coarse per-frame hit-test silhouette, unioned and dilated by one cell over
short windows (mask). --poster OUT.png writes output frame 0 as a plain,
straight-alpha PNG (un-premultiplied), her neutral pose shown before any clip
loads.

--islands A clears faint specks floating free of her in every output frame
(see islands()): optical flow between two source frames can smear a stray dot
of matte into a grey smudge beside her, which shows on a light window. A part
apart from her whose alpha never reaches A (0-255) goes; a real part of her
that comes loose is opaque and stays. --open-on IMAGE.png --open-rect X,Y,W,H
starts the clip on that straight-alpha image laid at the rect (fractions of
the output frame) and dissolves it into the clip over --open-seconds: a clip
built backwards (tools/build-transition.sh's landing.mov) then ends on exactly
that image, so whatever is shown in its place afterwards shows no seam.

usage: python tools/build-clip.py CLIP.mp4 PLATE.png [--trim A:B] [--drop N,..] [--cut A:B] [--squeeze A:B:R] [--snap A:B,..] [--seconds S]
           [--then CLIP2.mp4 [--then-trim A:B] [--then-drop N,..] [--then-cut A:B] [--then-squeeze A:B:R] [--then-snap A:B,..] [--then-seconds S]]
           [--align-to PLATE.png] [--extend REST.png --extend-free FREE.png [--extend-px PX]]
           [--core X,Y [--core-min PX] [--core-start S]] [--fit a0,b0,a1,b1,a2,b2] [--quality Q] [--fps N] [--width PX] [--preview OUT.mp4]
           [--meta OUT.json [--safe-threshold D]] [--poster OUT.png]
           [--islands A] [--open-on IMAGE.png --open-rect X,Y,W,H [--open-seconds S]]
needs: macOS 14+, swiftc, ffmpeg with hevc_videotoolbox, numpy, opencv-python-headless, scipy
--preview also writes the clip over the band's colours as plain H.264, for review.
"""
import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np
from scipy.ndimage import binary_fill_holes, gaussian_filter1d, label

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'Resources' / 'web' / 'layers' / 'awakening.mov'
OUT_FPS = 60
# 1056 px across, the still's pixel density (her crop is 1056 px wide there).
OUT_W = 1056  # her height follows the frames' (1408 for the 3:4 plate)
HOLE_AREA = 0.004  # holes smaller than this share of the frame are filled
PLATE_HOLE = 150  # px; holes in her matte smaller than this are filled; in bigger ones each pixel is her or the backdrop
HOLE_KEY = (10, 24)  # blue over red and green: a pixel in such a hole turns from her to the backdrop between these
HOLE_DARK = (100, 140)  # grey level: ... while darker than the first, not at all once lighter than the second
EDGE = 3  # px of her outline that keep Vision's soft ramp; inside it she is opaque
KEY_NEAR, KEY_FAR = 10.0, 34.0  # edge pixels this close to the plate (RGB distance) are plate, this far are her
EXT_BAND = 28  # clip px above her waist edge where the clip hands over to a painted extension
# Her gauntlet just above the edge (clip px above it; across, inside where her
# hand crosses the edge): what track_hand() follows to keep the painted hand
# on her forearm.
GAUNTLET_ROWS = (150, 22)
GAUNTLET_INSET = (8, 16)
GAUNTLET_FIT = 0.65  # a match of the first frame's gauntlet at least this good: it is at the edge, her hand below it
GAUNTLET_SNAP = 0.85  # ... this good: taken as it is, so following it frame to frame does not drift
GAUNTLET_FIND = 0.8  # ... this good, searched for widely: her hand has come back down to hang
CHAIN_FIT = 0.88  # a match of the frame before's gauntlet at least this good: still following it (between frames it is 0.9-1)
HAND_RISE = 90  # px; her gauntlet risen this far above where it hangs: her own hand shows in the clip
ARM_OPEN = 57  # px; slivers of the painted hand's mask thinner than this are left off where it follows her gauntlet
ARM_DIFF = 120  # rest and free differ at least this much (summed RGB) on her painted forearm and hand
THIGH_TOL = 5  # grey levels; her thigh in rest is grown from points on it up to steps steeper than this (her thumb's outline)
ARM_SETTLE = 24  # px; her painted hand this far from where it hangs in rest leaves her thigh there behind
# Her waist edge (see seam_motion): optical flow from the first frame in the
# SEAM_ROWS above the edge; the rows SEAM_FIT above it set where the edge went
# (the last few rows are left out: a clip laid onto another one repeats its
# border there). Her torso, from SEAM_TORSO of the width to her hanging arm,
# sets her pelvis's turn and shift; how each column moves besides that is
# followed by the painted extension down to SEAM_FADE (plate px below the
# edge), so her belt, which the edge cuts across, stays in one piece.
SEAM_ROWS = 320
SEAM_FIT = (8, 56)
SEAM_TORSO = 0.345
SEAM_FADE = (40, 160)
# Her painted lower body as three parts (plate px; depth below the plate's
# bottom edge, her waist): the pelvis with the crotch, rigid with her waist,
# handing over to the legs between PELVIS_TO_LEGS; the legs split at LEG_SPLIT_X
# (the crotch). Each thigh is a bone from its knee (planted, off the picture)
# to its hip joint, which rides on the pelvis.
LEG_SPLIT_X = 1004
PELVIS_TO_LEGS = (170, 290)
HIP_JOINTS = ((840, 190), (1120, 190))
KNEES = ((850, 820), (1110, 820))
LEG_HZ = 3.0  # how quickly a thigh follows its hip (critically damped spring)
DEBLUE = (8.0, 40.0)  # blue over red and green where deblue starts, and where it takes all of it out
GREEN_SURE = (8.0, 0.8)  # --key green: greenness (G over max(R,B)) at or below which a pixel is all her, and the share of the backdrop's own greenness at or above which it is all backdrop
GREEN_CORE = 5  # --key green: px Vision's solid matte is pulled in by before it vouches for her against spill
GREEN_FLOOR = (12, 4.0, 12.0)  # --floor: px Vision's matte is grown by before a floor pixel counts as off her, and the greenness (G over max(R,B)) from which a pixel there starts to be, and fully is, shadowed backdrop
GREEN_FLOOR_RATIO = (1.2, 1.45)  # --floor: G / max(R,B) from which a floor pixel starts to be, and fully is, shadowed backdrop even on Vision's matte (the contact shadow under her boots; her suit, straps and soles stay below it)
# Backdrop between her hair strands (see hair_gaps): blue over red and green
# from the first to the second is the backdrop's; darker than the first grey
# level, not lighter than the second; smoother inside than the first
# (median luma gradient), not as textured as the second.
HAIR_BLUE = (10.0, 20.0)
HAIR_DARK = (58.0, 78.0)
HAIR_SMOOTH = (10.0, 16.0)
EDGE_SIGMA = 4.0  # --edge-fit: px (clip) over which her opaque colour is spread out into her soft edge
EDGE_SURE = (30.0, 70.0)  # --edge-fit: her colour's distance from the backdrop where the fitted alpha starts to count, and where it counts fully
GAP_NEAR, GAP_FAR = 14.0, 30.0  # --body-gaps: RGB distance from the backdrop behind her within which a pixel is all backdrop, and past which none of it is
# A frame is a repeat of the one before it when it moves less than this share
# of its neighbours' steps, and both move more than REPEAT_MOVING (mean grey
# level change at quarter size): see unrepeat().
REPEAT_RATIO = 0.4
REPEAT_MOVING = 0.8
# --meta (pet clips): thresholds on the low-res (MASK_LOW_RES px wide),
# premultiplied RGBA mean absolute difference, 0-255 scale. Calibrated against
# a real 60 fps idle clip's printed curves (--meta prints both, so a
# differently paced clip can be checked against these): frame-to-frame motion
# sat at 0.01-0.03 while she was still and climbed to 0.08-0.19 once she
# moved, and distance from frame 0 rose to a 5.2 peak at her furthest pose.
FREEZE_MOTION = 0.1  # between consecutive frames: below this, nothing visibly moved (a leading or trailing hold)
FREEZE_SECONDS = 0.25  # a trailing hold at least this long hands playback back to the plate pose instead of riding out a frozen tail (`to`)
SAFE_THRESHOLD = 4.0  # default `safe` cutoff: frames close enough to frame 0 to hand over to another clip; calibrate from the printed curve
MASK_LOW_RES = 48  # px wide, for --meta's low-res frame comparisons (safe, the leading/trailing freeze)
HEAD_SAFE = 3.0  # --meta: her head's mean abs diff from frame 0 (full output res, 0-255) below which her face sits where frame 0's does
HANDOFF_SECONDS = 0.4  # --meta: the pet page's cross-fade (index.html: .2s fade plus .2s delay); a hand-over frame must stay neutral this long
MASK_COLS, MASK_ROWS = 24, 32  # --meta's hit-test grid (contract: clips.json mask.cols/rows)


def decode(path):
    probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate',
                            '-of', 'json', str(path)], capture_output=True, text=True, check=True)
    stream = json.loads(probe.stdout)['streams'][0]
    w, h = stream['width'], stream['height']
    num, den = (int(v) for v in stream['r_frame_rate'].split('/'))
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3), num / den


def unrepeat(clip):
    """Seedance sometimes renders a move at 18 fps and repeats every fourth
    frame to fill 24: in a quick turn of her head she stops for a frame, then
    jumps, a judder the 60 fps interpolation would keep. A frame that barely
    differs from the one before it while the frames on both sides of it move
    (REPEAT_MOVING, REPEAT_RATIO) is such a repeat. It is dropped, the frame it
    repeats is timed at the middle of the two slots it held, and the steps are
    evened out over three frames, so her move flows at its own pace. Returns
    the indices kept and their times in source frames."""
    small = [cv2.cvtColor(cv2.resize(f, None, fx=0.25, fy=0.25, interpolation=cv2.INTER_AREA), cv2.COLOR_RGB2GRAY).astype(np.int16)
             for f in clip]
    step = np.array([np.abs(b - a).mean() for a, b in zip(small, small[1:])])  # step[i]: frame i to i + 1
    repeats = {i for i in range(2, len(clip) - 1)
               if min(step[i - 2], step[i]) > REPEAT_MOVING and step[i - 1] < REPEAT_RATIO * min(step[i - 2], step[i])}
    keep = [i for i in range(len(clip)) if i not in repeats]
    slots = np.array([i + 0.5 if i + 1 in repeats and i > 0 else float(i) for i in keep])
    if repeats:
        steps = np.diff(slots)
        padded = np.concatenate([steps[:1], steps, steps[-1:]])
        even = np.convolve(padded, np.ones(3) / 3, 'valid')
        slots = np.concatenate([[0.0], np.cumsum(even * (slots[-1] / even.sum()))])
    return keep, slots


def mattes(frames, work):
    tool = work / 'matte'
    subprocess.run(['swiftc', '-O', '-o', str(tool), str(ROOT / 'tools' / 'matte.swift')], check=True)
    names = []
    for i, frame in enumerate(frames):
        name = work / f'{i:04d}.png'
        cv2.imwrite(str(name), cv2.cvtColor(frame, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_PNG_COMPRESSION, 1])
        names.append(name)
    out = work / 'mattes'
    out.mkdir()
    for start in range(0, len(names), 40):
        subprocess.run([str(tool), str(out)] + [str(n) for n in names[start:start + 40]], check=True, capture_output=True)
    return np.stack([solid(cv2.imread(str(out / n.name), cv2.IMREAD_GRAYSCALE), frames[i]) for i, n in enumerate(names)])


def solid(matte, frame=None):
    """Makes her fully opaque: fills the small soft holes Vision leaves inside
    her (where her black gloves meet the dark plate), then sets everything
    more than a few pixels inside her outline to full alpha, so nothing behind
    her shows through her body; only her outermost edge keeps Vision's soft
    ramp. In the bigger gaps she encloses (between the wrench, her hair and
    shoulder; between her arms and her waist) each pixel is taken as it looks:
    the dark blue backdrop is left open (filled, it sat on the band as a dark
    patch, like a shadow left by the cut-out), her coat's tail hanging behind
    her arm is kept. Taking or leaving such a gap whole, by its size or its
    average colour, made the gap beside her belt flip between a dark patch
    with her coat and nothing at all as she turned, as if her coat passed
    through her."""
    core = (matte > 100)
    holes = binary_fill_holes(core) & ~core
    labels, count = label(holes)
    body, kept = core, None
    if count:
        sizes = np.bincount(labels.ravel())
        small = sizes < (PLATE_HOLE if frame is not None else HOLE_AREA * matte.size)
        small[0] = False
        body = core | small[labels]
        if frame is not None:
            seen = holes & ~small[labels]
            f = frame.astype(np.float32)
            ramp = lambda v, a, b: (lambda k: k * k * (3 - 2 * k))(np.clip((v - a) / (b - a), 0, 1))
            backdrop = (ramp(f[..., 2] - f[..., :2].max(2), *HOLE_KEY)
                        * (1 - ramp(f @ np.array([0.299, 0.587, 0.114], np.float32), *HOLE_DARK)))
            kept = cv2.GaussianBlur(np.where(seen, 1 - backdrop, 1).astype(np.float32), (0, 0), 1.0) * seen * 255
            # What is kept joins her, so no see-through seam rings it.
            body |= seen & (backdrop < 0.5)
    inner = cv2.erode(body.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * EDGE + 1, 2 * EDGE + 1)))
    inner = cv2.GaussianBlur(inner.astype(np.float32) * 255, (0, 0), 1.0)
    out = np.maximum(matte.astype(np.float32), inner)
    return (out if kept is None else np.maximum(out, kept)).astype(np.uint8)


def colour_fit(frame, plate, matte):
    sel = matte > 200
    return np.array([np.polyfit(frame[..., c][sel].astype(np.float64), plate[..., c][sel].astype(np.float64), 1) for c in range(3)])


def background(frame, matte):
    """The plate behind her: a normalised blur of the pixels well outside her."""
    small = 8
    h, w = matte.shape
    f = cv2.resize(frame, (w // small, h // small), interpolation=cv2.INTER_AREA).astype(np.float32)
    m = cv2.resize(matte, (w // small, h // small), interpolation=cv2.INTER_AREA)
    keep = (cv2.dilate((m > 8).astype(np.uint8), np.ones((5, 5), np.uint8)) == 0).astype(np.float32)
    num = cv2.GaussianBlur(f * keep[..., None], (0, 0), 12)
    den = cv2.GaussianBlur(keep, (0, 0), 12)[..., None]
    bg = num / np.maximum(den, 1e-3)
    return cv2.resize(bg, (w, h), interpolation=cv2.INTER_LINEAR)


def hair_gaps(frame, matte, zone, dark=HAIR_DARK, strands=0, blue=HAIR_BLUE):
    """How much of each pixel is backdrop showing between her hair strands,
    0-1. Vision takes her hair as one solid mass, so the dark blue backdrop
    between loose strands and between her hair and the wrench stayed in her,
    dark patches like shadows on the band. In the zone (X0, Y0, X1, Y1, clip
    px, feathered: wherever her head goes), dark blue pixels are the backdrop
    when the patch they form is smooth inside: her black gloves and gauntlets,
    the same colour, have highlights and seams."""
    c = frame.astype(np.float32)
    ramp = lambda v, a, b: (lambda k: k * k * (3 - 2 * k))(np.clip((v - a) / (b - a), 0, 1))
    luma = c @ np.array([0.299, 0.587, 0.114], np.float32)
    x0, y0, x1, y1 = zone
    inside = np.zeros(matte.shape, np.float32)
    inside[y0:y1, x0:x1] = 1
    inside = cv2.GaussianBlur(inside, (0, 0), 15)
    k = ramp(c[..., 2] - c[..., :2].max(axis=2), *blue) * (1 - ramp(luma, *dark)) * inside
    patches = ((k > 0.3) & (matte > 128)).astype(np.uint8)
    count, labels = cv2.connectedComponents(patches)
    if count > 1:
        grad = np.hypot(cv2.Sobel(luma, cv2.CV_32F, 1, 0, ksize=3), cv2.Sobel(luma, cv2.CV_32F, 0, 1, ksize=3))
        core = cv2.erode(patches, np.ones((3, 3), np.uint8)) > 0
        smooth = np.ones(count, np.float32)
        sizes = np.bincount(labels.ravel(), minlength=count)
        for j in range(1, count):
            # A gap between strands is thin and edged with strands, so it
            # never reads as smooth; strands (px) lets every patch smaller
            # than that go by its colour alone. A glove or the wrench's dark
            # metal is one bigger patch, still judged by its highlights.
            if sizes[j] < strands:
                continue
            g = grad[(labels == j) & core]
            smooth[j] = 1 - ramp(float(np.median(g)), *HAIR_SMOOTH) if g.size > 5 else 1.0
        smooth[0] = 1.0
        k = k * smooth[labels]
    return cv2.GaussianBlur(k, (0, 0), 0.7)


def body_gaps(c, bg, matte, least):
    """--body-gaps: how much of each pixel is backdrop seen through a gap she
    encloses that Vision took as part of her (between her arm and her waist
    as she stands, between her legs as she crouches), 0-1; on a window it
    shows as a dark smudge on her. hair_gaps' dark-and-blue test would eat
    the shaded underside of her white suit here, so a pixel only counts when
    it is nearly the backdrop's own colour behind her (bg), in one smooth
    patch of at least `least` px: her black gloves and belt, close to it,
    have highlights and seams, and dark pixels in her suit's seams are
    smaller."""
    ramp = lambda v, a, b: (lambda k: k * k * (3 - 2 * k))(np.clip((v - a) / (b - a), 0, 1))
    k = 1 - ramp(np.sqrt(((c - bg) ** 2).sum(axis=2)), GAP_NEAR, GAP_FAR)
    patches = ((k > 0.5) & (matte > 128)).astype(np.uint8)
    count, labels = cv2.connectedComponents(patches)
    if count < 2:
        return np.zeros(matte.shape, np.float32)
    luma = c @ np.array([0.299, 0.587, 0.114], np.float32)
    grad = np.hypot(cv2.Sobel(luma, cv2.CV_32F, 1, 0, ksize=3), cv2.Sobel(luma, cv2.CV_32F, 0, 1, ksize=3))
    core = cv2.erode(patches, np.ones((3, 3), np.uint8)) > 0
    sizes = np.bincount(labels.ravel(), minlength=count)
    taken = np.zeros(count, np.float32)
    for j in range(1, count):
        g = grad[(labels == j) & core]
        if sizes[j] >= least and g.size > 5:
            taken[j] = 1 - ramp(float(np.median(g)), *HAIR_SMOOTH)
    return cv2.GaussianBlur(k * taken[labels], (0, 0), 0.7)


def head_zone(matte, share=0.3):
    """--hair-zone auto: this frame's own head zone (X0, Y0, X1, Y1), the top
    share of her matte's bbox, for a clip whose head moves too far for one
    fixed zone (the pet sits down). Her hair, the wrench's head and the
    backdrop between them sit there; her belt and gloves, black leather that
    the blue backdrop lights nearly its own colour, sit below it."""
    ys, xs = np.nonzero(matte > 128)
    if len(xs) == 0:
        return None
    y0, y1 = ys.min(), ys.max()
    return int(xs.min()), int(y0), int(xs.max()) + 1, int(y0 + share * (y1 - y0))


def edge_alpha(c, bg, a):
    """--edge-fit: her soft edge's alpha taken from its colour. Vision's ramp
    runs wider than she covers, most at her white hair and suit: an edge pixel
    that is 40% her and 60% backdrop can carry 80% alpha, so 40% of dark blue
    stays in it, unseen on the dark band but a grey, frayed fringe on a light
    window. The backdrop behind each pixel is known (bg) and her own colour
    there is her nearest opaque colour spread outward (fg), so the share of
    her in it is where the pixel sits between the two. Only lowered, never
    raised, and only where fg is far enough from the backdrop to tell (her
    black gloves are nearly its colour: Vision's ramp stays there)."""
    ramp = lambda v, lo, hi: (lambda k: k * k * (3 - 2 * k))(np.clip((v - lo) / (hi - lo), 0, 1))
    core = (a >= 0.995).astype(np.float32)
    num = cv2.GaussianBlur(c * core[..., None], (0, 0), EDGE_SIGMA)
    den = cv2.GaussianBlur(core, (0, 0), EDGE_SIGMA)
    fg = num / np.maximum(den, 1e-3)[..., None]
    span = fg - bg
    reach = (span ** 2).sum(axis=2)
    share = np.clip(((c - bg) * span).sum(axis=2) / np.maximum(reach, 1e-3), 0, 1)
    sure = ramp(np.sqrt(reach), *EDGE_SURE) * ramp(den, 0.02, 0.1)
    edge = (a > 0) & (a < 0.995)
    return np.where(edge, np.minimum(a, sure * share + (1 - sure) * a), a)


def premultiplied(frame, matte, hair_zone=None, hair_dark=HAIR_DARK, edge_fit=False, hair_strands=0, hair_blue=HAIR_BLUE, gaps=0):
    """Her colour times her alpha, with the plate taken out of soft edges.
    Vision's soft ramp reaches a little past her into plain plate; where an
    edge pixel is barely different from the plate behind it, its alpha is
    brought down to match, or that ring of plate would show as a pale outline
    on the dark band (and as dark patches between her loose hair strands).
    Her opaque inside is left alone, but for the backdrop between her hair
    strands (hair_gaps, with hair_zone). Returns (premultiplied colour, alpha)."""
    a = matte.astype(np.float32) / 255
    c = frame.astype(np.float32)
    bg = background(frame, matte)
    d = np.sqrt(((c - bg) ** 2).sum(axis=2))
    key = np.clip((d - KEY_NEAR) / (KEY_FAR - KEY_NEAR), 0, 1)
    key = key * key * (3 - 2 * key)
    a = np.where(a < 0.995, np.minimum(a, key), a)
    if edge_fit:
        a = edge_alpha(c, bg, a)
    if hair_zone == 'auto':
        hair_zone = head_zone(matte)
    if hair_zone:
        a = np.minimum(a, 1 - hair_gaps(frame, matte, hair_zone, hair_dark, hair_strands, hair_blue))
    if gaps:
        a = np.minimum(a, 1 - body_gaps(c, bg, matte, gaps))
    a = a[..., None]
    return np.clip(c - (1 - a) * bg, 0, 255 * a), a[..., 0]


def premultiplied_green(frame, matte, floor=None):
    """--key green: her colour times her alpha off a chroma-green backdrop.
    She wears no green, so a pixel's alpha comes from how green it is (G
    over max(R, B)) between her own colours (GREEN_SURE[0] or less) and the
    backdrop behind it (GREEN_SURE[1] of background()'s own greenness or
    more). Green light spilled onto her white suit is only a little green,
    so inside Vision's solid matte (pulled in GREEN_CORE px) she stays
    opaque, except where a pixel is nearly as green as the backdrop (the
    gaps between her hair strands, which Vision's blob covers). The backdrop
    is taken out of her soft edges, and the green spill left on her is
    clamped down to max(R, B). With floor (a fraction of the frame height),
    the shadow Seedance lays on the green floor under her, a darker and greyer
    green than the backdrop that the greenness test only half takes out, goes
    too: below that line (feathered), any greenish pixel well off Vision's
    matte is backdrop, and so is any pixel there clearly greener than red and
    blue (GREEN_FLOOR_RATIO), even on the matte: the contact shadow at her
    boots that Vision takes as her. Her hair and the wrench never reach the
    floor; her white suit, orange straps and black soles stay below that
    ratio, and only the black core of the contact shadow, the soles' own
    colour, is left. Returns
    (premultiplied colour, alpha)."""
    c = frame.astype(np.float32)
    bg = background(frame, matte)
    g = c[..., 1] - np.maximum(c[..., 0], c[..., 2])
    g_bg = np.maximum(bg[..., 1] - np.maximum(bg[..., 0], bg[..., 2]), 1.0)
    lo, share = GREEN_SURE
    a = 1 - np.clip((g - lo) / np.maximum(g_bg * share - lo, 1.0), 0, 1)
    core = cv2.erode((matte >= 250).astype(np.uint8), np.ones((2 * GREEN_CORE + 1,) * 2, np.uint8)).astype(np.float32)
    a = np.maximum(a, core * np.clip((0.55 * g_bg - g) / (0.2 * g_bg), 0, 1))
    if floor is not None:
        h = a.shape[0]
        reach, g0, g1 = GREEN_FLOOR
        band = np.clip((np.arange(h, dtype=np.float32) / h - floor) / 0.03, 0, 1)[:, None]
        grown = cv2.dilate(matte, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * reach + 1,) * 2))
        off = 1 - np.clip(cv2.GaussianBlur(grown.astype(np.float32), (0, 0), 3) / 64, 0, 1)
        r0, r1 = GREEN_FLOOR_RATIO
        greenish = np.clip((g - g0) / (g1 - g0), 0, 1)
        ratio = c[..., 1] / np.maximum(np.maximum(c[..., 0], c[..., 2]), 4.0)
        a = a * (1 - band * greenish * np.maximum(off, np.clip((ratio - r0) / (r1 - r0), 0, 1)))
    a3 = a[..., None]
    pre = np.clip(c - (1 - a3) * bg, 0, 255 * a3)
    straight = pre / np.maximum(a3, 1e-3)
    straight[..., 1] = np.minimum(straight[..., 1], np.maximum(straight[..., 0], straight[..., 2]))
    return straight * a3, a


def rest_share(k, count, frames):
    """--rest: how much of output frame k is the rest image: all of it on the
    first and last frame, easing out over `frames` frames from each end, so
    every clip starts and ends on the very same picture."""
    if frames <= 0:
        return 1.0 if k in (0, count - 1) else 0.0
    u = max(0.0, 1 - min(k, count - 1 - k) / frames)
    return u * u * (3 - 2 * u)


def deblue(rgb):
    """Takes the blue cast out of her colour (straight RGB, float): the
    plate's blue backdrop lights her white suit, hair, thighs and the metal
    from the left, and on the dark band that reads as blue shadow. Where blue
    exceeds both red and green by more than DEBLUE[0], the pixel is turned
    towards the grey of its own brightness (all the way past DEBLUE[1]), so
    the shading stays and no other tint (teal) is left in its place. Her
    orange and skin, where red leads, are untouched."""
    excess = rgb[..., 2] - np.maximum(rgb[..., 0], rgb[..., 1])
    k = np.clip((excess - DEBLUE[0]) / (DEBLUE[1] - DEBLUE[0]), 0, 1)
    k = (k * k * (3 - 2 * k))[..., None]
    luma = (rgb @ np.array([0.299, 0.587, 0.114], np.float32))[..., None]
    return rgb + k * (luma - rgb)


def core_level(t):
    """How bright the star on her chest should be at t seconds into the clip
    (mean of its brightest channel, 0-255): a dim ember as she comes in, then
    over a couple of seconds it smoothly comes to life and settles into a
    soft, steady warm glow, about as bright as in her plate. It never
    flickers, pulses or bursts."""
    ember, lit = 95.0, 150.0
    rise = np.clip((t - 1.2) / 2.4, 0, 1)
    rise = rise * rise * (3 - 2 * rise)
    return ember + (lit - ember) * rise


def track_core(frame, centre, min_area=4000, reach=(280, 260), max_area=None):
    """The star and the warm light it casts on her armour: the biggest warm
    patch near where it was in the last frame (within reach, X and Y px).
    When she is small in the frame the star is too, and her orange armour
    plates lie close to it: a small reach and a max_area keep them out.
    Returns (mask, centre)."""
    f = frame.astype(np.int16)
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    warm = (r - b > 40) & (r > 130) & (g > 80)
    cx, cy = centre
    window = np.zeros(warm.shape, bool)
    rx, ry = reach
    window[max(cy - ry, 0):cy + ry, max(cx - rx, 0):cx + rx] = True
    closed = cv2.morphologyEx((warm & window).astype(np.uint8), cv2.MORPH_CLOSE,
                              cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))
    labels, count = label(closed)
    if not count:
        return None, centre
    sizes = np.bincount(labels.ravel())
    sizes[0] = 0
    best = None
    taken = 0
    for k in np.argsort(sizes)[::-1]:
        if sizes[k] < min_area or taken == 4:
            break
        if max_area and sizes[k] > max_area:
            continue
        taken += 1
        ys, xs = np.nonzero(labels == k)
        c = (int(xs.mean()), int(ys.mean()))
        d = np.hypot(c[0] - cx, c[1] - cy)
        if best is None or d < best[0]:
            best = (d, k, c)
    if best is None:
        return None, centre
    return binary_fill_holes(labels == best[1]), best[2]


def relight_core(frames, times, centre, min_area=4000, reach=(280, 260), max_area=None):
    """Re-lights the star frame by frame along core_level (in place)."""
    mask = None
    for i in range(len(frames)):
        found, centre = track_core(frames[i], centre, min_area, reach, max_area)
        mask = found if found is not None else mask
        if mask is None:
            continue
        f = frames[i].astype(np.float32)
        # Only warm pixels carry its light; the white armour around it stays.
        warmth = cv2.GaussianBlur(np.clip((f[..., 0] - f[..., 2] - 25) / 70, 0, 1), (0, 0), 2)
        weight = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), 6) * warmth
        now = float((f.max(axis=2) * weight).sum() / max(weight.sum(), 1))
        k = core_level(times[i]) / max(now, 1)
        # Dimmer is redder, like an ember; brighter turns orange-gold.
        gain = np.array([k ** 0.7, k, k ** 1.3], np.float32)
        lit = np.clip(f * gain, 0, 255)
        frames[i] = (f * (1 - weight[..., None]) + lit * weight[..., None] + 0.5).astype(np.uint8)


def flow(dis, a, b, scale=0.5):
    ga = cv2.cvtColor(cv2.resize(a, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA), cv2.COLOR_RGB2GRAY)
    gb = cv2.cvtColor(cv2.resize(b, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA), cv2.COLOR_RGB2GRAY)
    f = dis.calc(ga, gb, None)
    h, w = a.shape[:2]
    return cv2.resize(f, (w, h), interpolation=cv2.INTER_LINEAR) / scale


def silhouette(pre, a):
    """--key green flow input: her, lit, over flat black. The green backdrop
    and its floor shading are bright and textured, so DIS on the raw frames
    finds motion in the empty floor below her soles and the blend drags her
    boots onto it, a grey ghost every other frame. Here the backdrop is zero
    and she always stands out from it (64 plus three quarters of her
    luminance, scaled by alpha), so the flow follows only her."""
    lum = cv2.cvtColor(np.clip(pre / np.maximum(a, 1e-3)[..., None], 0, 255).astype(np.float32), cv2.COLOR_RGB2GRAY)
    g = np.clip(a * (64 + 0.75 * lum) + 0.5, 0, 255).astype(np.uint8)
    return np.dstack([g, g, g])


def splat_flow(fl, a, s, sharp=10.0):
    """Flow from time s (0..1 of the way along fl) back to the frame fl
    starts on, built by carrying every pixel p forward to p + s*fl(p) rather
    than reading fl where the target pixel is. A fast limb's own motion then
    lands where the limb is at s, instead of the backdrop's (zero) motion
    there that thins its leading edge to half alpha. Where several pixels
    land on one, her (alpha) wins, weight exp(sharp * alpha); holes are
    filled from a Gaussian of their neighbours and, failing that, read fl
    in place as before."""
    h, w = fl.shape[:2]
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float64)
    qx, qy = xs + s * fl[..., 0], ys + s * fl[..., 1]
    weight = np.exp(sharp * a.astype(np.float64))
    x0, y0 = np.floor(qx).astype(np.int64), np.floor(qy).astype(np.int64)
    fx, fy = qx - x0, qy - y0
    num = np.zeros((2, h * w)); den = np.zeros(h * w); cover = np.zeros(h * w)
    for dx, dy, share in ((0, 0, (1 - fx) * (1 - fy)), (1, 0, fx * (1 - fy)), (0, 1, (1 - fx) * fy), (1, 1, fx * fy)):
        x, y = x0 + dx, y0 + dy
        inside = (x >= 0) & (x < w) & (y >= 0) & (y < h)
        at = (y * w + x)[inside]
        wt = (share * weight)[inside]
        den += np.bincount(at, wt, h * w)
        cover += np.bincount(at, share[inside], h * w)
        for c in range(2):
            num[c] += np.bincount(at, wt * (-s * fl[..., c][inside]), h * w)
    num, den, cover = num.reshape(2, h, w), den.reshape(h, w), cover.reshape(h, w)
    blur = lambda m: cv2.GaussianBlur(m, (0, 0), 2)
    near = blur(den)
    back = np.empty((h, w, 2), np.float32)
    for c in range(2):
        landed = np.where(cover > 0.25, num[c] / np.maximum(den, 1e-300), blur(num[c]) / np.maximum(near, 1e-300))
        back[..., c] = np.where((cover > 0.25) | (near > 1e-6), landed, -s * fl[..., c])
    return back


def register(gen, plate):
    """The partial affine (rotation, uniform scale, shift) that lays a
    generated extension over the plate. The generator redraws the plate at a
    scale of its own, so SIFT matches on the plate's lower part (her torso)
    find where it put her."""
    sift = cv2.SIFT_create(6000)
    mask = np.zeros(plate.shape[:2], np.uint8)
    mask[plate.shape[0] * 5 // 8:] = 255
    k1, d1 = sift.detectAndCompute(cv2.cvtColor(plate, cv2.COLOR_RGB2GRAY), mask)
    k2, d2 = sift.detectAndCompute(cv2.cvtColor(gen, cv2.COLOR_RGB2GRAY), None)
    good = [m for m, n in cv2.BFMatcher().knnMatch(d1, d2, k=2) if m.distance < 0.75 * n.distance]
    src = np.float32([k2[m.trainIdx].pt for m in good])
    dst = np.float32([k1[m.queryIdx].pt for m in good])
    M, inliers = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=6)
    if M is None or inliers.sum() < 60:
        sys.exit('could not place the extension on the plate')
    print(f'extension placed on the plate: scale {np.hypot(M[0, 0], M[1, 0]):.3f}, {int(inliers.sum())} matches', file=sys.stderr)
    return M


def align(clip, onto):
    """Lays a clip made from another one's last frame (onto) over it: Seedance
    redraws that frame a little larger or shifted (the idle after her action
    came out 0.7 % larger and 4-6 px lower), and she would jump where the two
    meet. The similarity (turn, uniform scale, shift) that SIFT matches find
    between the clip's first frame and onto is applied to all its frames.
    Returns (clip, ok); ok is false (clip unchanged) when too few matches were
    found to trust a transform (--align-to's --meta takes this as its sign
    that frame 0 truly is the pose it was aligned onto)."""
    sift = cv2.SIFT_create(8000)
    grey = lambda f: cv2.cvtColor(f, cv2.COLOR_RGB2GRAY)
    k1, d1 = sift.detectAndCompute(grey(clip[0]), None)
    k2, d2 = sift.detectAndCompute(grey(onto), None)
    good = [m for m, n in cv2.BFMatcher().knnMatch(d1, d2, k=2) if m.distance < 0.75 * n.distance]
    src = np.float32([k1[m.queryIdx].pt for m in good])
    dst = np.float32([k2[m.trainIdx].pt for m in good])
    M, inliers = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=2)
    if M is None or inliers.sum() < 60:
        print('the second clip could not be laid onto the first; left as it is', file=sys.stderr)
        return clip, False
    moved = np.linalg.norm(src @ M[:, :2].T + M[:, 2] - src, axis=1)[inliers.ravel() == 1]
    print(f'second clip laid onto the first: scale {np.hypot(M[0, 0], M[1, 0]):.4f}, '
          f'turn {np.degrees(np.arctan2(M[1, 0], M[0, 0])):+.2f} deg, her points moved {np.median(moved):.1f} px '
          f'(median of {int(inliers.sum())} matches)', file=sys.stderr)
    h, w = clip.shape[1:3]
    warped = np.stack([cv2.warpAffine(f, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE) for f in clip])
    return warped, True


def smooth_steps(values, ok, radius=2):
    """Per-frame estimates with the unreliable ones (ok false) bridged from
    their neighbours, then a centred moving average, so nothing jitters."""
    values = np.asarray(values, np.float64)
    idx = np.arange(len(values))
    good = np.nonzero(ok)[0]
    if len(good) == 0:
        return values
    bridged = np.stack([np.interp(idx, good, values[good, k]) for k in range(values.shape[1])], 1)
    padded = np.concatenate([bridged[:1].repeat(radius, 0), bridged, bridged[-1:].repeat(radius, 0)])
    kernel = np.ones(2 * radius + 1) / (2 * radius + 1)
    return np.stack([np.convolve(padded[:, k], kernel, 'valid') for k in range(values.shape[1])], 1)


def follow(targets, times, hz):
    """A critically damped spring chasing each frame's target (frames at
    `times` seconds), so a thigh trails its hip a little, like a body with
    weight, and never jitters."""
    targets = np.asarray(targets, np.float64)
    omega, steps = 2 * np.pi * hz, 16
    x, v = targets[0].copy(), np.zeros_like(targets[0])
    out = []
    for target, step in zip(targets, np.diff(times, prepend=times[0])):
        dt = step / steps
        for _ in range(steps):
            v += (omega * omega * (target - x) - 2 * omega * v) * dt
            x += v * dt
        out.append(x.copy())
    return np.array(out)


def smooth_track(values, radius=2):
    """Per-frame estimates in whole px and degrees, evened out: each is
    replaced by a straight line fitted through it and its neighbours (radius
    each side, fewer at the ends), so the matcher's one-step jitter goes but a
    steady move, even a quick one at the end of the run, is kept as it is."""
    values = np.asarray(values, np.float64)
    out = np.empty_like(values)
    for i in range(len(values)):
        a, b = max(0, i - radius), min(len(values), i + radius + 1)
        t = np.arange(a, b) - i
        if b - a < 3:
            out[i] = values[i]
            continue
        A = np.stack([np.ones(len(t)), t], 1)
        out[i] = np.linalg.lstsq(A, values[a:b], rcond=None)[0][0]
    return out


def track_hand(frames, hx0, hx1):
    """Where her hanging hand is in each frame: her gauntlet just above the
    edge (GAUNTLET_ROWS, inside where her hand crosses it, hx0..hx1) is
    followed frame by frame, turned by up to 4 degrees and shifted by up to
    20 px from the frame before, against the frame before's own gauntlet, so it
    keeps up as her forearm turns and starts to lift, and whenever that
    matches well (GAUNTLET_SNAP), against the first frame's, so it does not
    drift. It is lost when neither matches (CHAIN_FIT, GAUNTLET_FIT): her arm
    swinging up. A wide search for the first frame's gauntlet (GAUNTLET_FIND)
    finds it again once her hand hangs again, and it is followed back from
    there for as long as it matches, to the frame her hand came down past the
    edge. The painted hand is on her forearm, fully, in every frame it is
    followed (fading it in and out by how well it matched left a grey,
    see-through hand, and turned it off while her forearm still hung, cut at
    the edge), unless her gauntlet has risen so far (HAND_RISE) that her own
    hand shows in the clip. Returns moves (2x3, clip px, from the first
    frame's) and whether the painted hand is shown, per frame."""
    n, h, w = frames.shape[:3]
    t0, t1 = h - GAUNTLET_ROWS[0], h - GAUNTLET_ROWS[1]
    x0, x1 = hx0 + GAUNTLET_INSET[0], hx1 - GAUNTLET_INSET[1]
    size = (x1 - x0, t1 - t0)
    middle = (size[0] / 2, size[1] / 2)
    whole = np.full((h, w), 255, np.uint8)

    def her(crop):
        r, g, b = (crop[..., k].astype(np.int32) for k in range(3))
        return (~((b > r + 20) & (b > g + 10) & (r + g + b < 330))).astype(np.uint8) * 255

    def matcher(ref, mask):
        turned = {}

        def template(angle):
            if angle not in turned:
                M = cv2.getRotationMatrix2D(middle, angle, 1.0)
                m = cv2.erode(cv2.warpAffine(mask, M, size, flags=cv2.INTER_NEAREST), np.ones((5, 5), np.uint8))
                turned[angle] = cv2.warpAffine(ref, M, size), (m > 0).astype(np.uint8)
            return turned[angle]

        def find(frame, angle, dx, dy, turn, reach):
            best = (-2.0, angle, dx, dy)
            for a in np.round(np.arange(angle - turn, angle + turn + 1e-6, 1.0), 1):
                t, m = template(float(a))
                ya, yb = max(0, t0 + dy - reach), min(h, t1 + dy + reach)
                xa, xb = max(0, x0 + dx - reach), min(w, x1 + dx + reach)
                if yb - ya < t.shape[0] or xb - xa < t.shape[1] or m.sum() < 100:
                    continue
                score = np.nan_to_num(cv2.matchTemplate(frame[ya:yb, xa:xb], t, cv2.TM_CCOEFF_NORMED, mask=m), nan=-1, posinf=-1, neginf=-1)
                _, value, _, at = cv2.minMaxLoc(score)
                if value > best[0]:
                    best = (value, float(a), int(xa + at[0] - x0), int(ya + at[1] - t0))
            return best
        return find

    first = matcher(frames[0][t0:t1, x0:x1], her(frames[0][t0:t1, x0:x1]))
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)

    def flowing(i, state, before):
        """Frame i's gauntlet from frame before's (state) by how her forearm
        moved where it crosses the edge (DIS optical flow, checked both ways):
        as she starts to lift her arm her forearm comes towards the camera and
        her cuff sinks past the edge, out of reach of the gauntlet's picture.
        None once her forearm leaves (the flow there no longer holds)."""
        angle, dx, dy = state
        ya, xa, xb = max(t0 - 40, 0), max(x0 + dx - 40, 0), min(x1 + dx + 40, w)
        a, b = (cv2.cvtColor(frames[k][ya:h, xa:xb], cv2.COLOR_RGB2GRAY) for k in (before, i))
        fwd, bwd = dis.calc(a, b, None), dis.calc(b, a, None)
        gy, gx = np.mgrid[0:h - ya, 0:xb - xa].astype(np.float32)
        back = cv2.remap(bwd, gx + fwd[..., 0], gy + fwd[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(1e3, 1e3))
        held = np.hypot(fwd[..., 0] + back[..., 0], fwd[..., 1] + back[..., 1]) < 3
        # Her forearm: on her, near the edge, within the gauntlet's columns.
        on = her(frames[before][ya:h, xa:xb]) > 0
        on[:max(h - ya - 70, 0)] = False
        on[:, :max(x0 + dx - xa, 0)] = False
        on[:, max(x1 + dx - xa, 0):] = False
        if on.sum() < 300 or (held & on).sum() < 0.6 * on.sum():
            return None
        mx, my = np.median(fwd[held & on], axis=0)
        if np.hypot(mx, my) > 30:
            return None
        return angle, int(round(dx + mx)), int(round(dy + my))

    def follow_from(i, state, before):
        """Frame i's gauntlet from frame before's (state): (angle, dx, dy), or None."""
        angle, dx, dy = state
        G = cv2.getRotationMatrix2D(middle, angle, 1.0)
        G[:, 2] += (x0 + dx, t0 + dy)
        ref = cv2.warpAffine(frames[before], G, size, flags=cv2.WARP_INVERSE_MAP | cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        inside = cv2.warpAffine(whole, G, size, flags=cv2.WARP_INVERSE_MAP | cv2.INTER_NEAREST)
        fit, *found = matcher(ref, her(ref) & inside)(frames[i], angle, dx, dy, 4, 20)
        snap, *at = first(frames[i], *found, 2, 6)
        if snap >= GAUNTLET_SNAP:
            return tuple(at)
        if fit >= CHAIN_FIT or snap >= GAUNTLET_FIT:
            return tuple(found)
        return flowing(i, state, before)

    states = [None] * n
    states[0] = (0.0, 0, 0)
    found_again = []
    for i in range(1, n):
        if states[i - 1] is not None:
            states[i] = follow_from(i, states[i - 1], i - 1)
            continue
        fit, *at = first(frames[i], 0.0, 0, 0, 12, 60)
        if fit >= GAUNTLET_FIND:
            states[i] = tuple(at)
            found_again.append(i)
    for start in found_again:
        i = start - 1
        while i >= 0 and states[i] is None:
            states[i] = follow_from(i, states[i + 1], i + 1)
            if states[i] is None or states[i][2] < -HAND_RISE:
                break
            i -= 1

    moves = [np.float32([[1, 0, 0], [0, 1, 0]])] * n
    shown = np.zeros(n)
    centre = (x0 + middle[0], t0 + middle[1])
    runs = []
    for i in range(n):
        if states[i] is not None:
            if runs and runs[-1][1] == i - 1:
                runs[-1][1] = i
            else:
                runs.append([i, i])
    for a, b in runs:
        track = smooth_track([states[i] for i in range(a, b + 1)])
        for i, (angle, dx, dy) in zip(range(a, b + 1), track):
            M = cv2.getRotationMatrix2D(centre, angle, 1.0)
            M[:, 2] += (dx, dy)
            moves[i] = M.astype(np.float32)
            shown[i] = float(dy >= -HAND_RISE)
    ranges = ', '.join(f'{a}-{b}' for a, b in runs)
    print(f'hand followed in frames {ranges}; shown in {int(shown.sum())}/{n}', file=sys.stderr)
    return moves, shown


def seam_motion(frames, hx0, hx1):
    """How her waist edge (the clip's bottom edge, where the painted extension
    takes over) moved in each frame since the first, from optical flow (DIS,
    checked forwards and backwards) in the SEAM_ROWS above it, on her and off
    her hanging forearm, weighted towards the edge (SEAM_FIT): her pelvis's
    turn and shift, fitted on her torso (SEAM_TORSO to her forearm), and how
    each column moved besides, faded out where there is nothing of her to
    follow. A single turn and shift tracked on her torso lost her whenever she
    turned her head and shoulders, and the painted half of her belt slid
    against the half in the clip, as if her clothes went through it. Returns
    (turn, shift x, shift y) about the edge's middle, and the columns' moves
    (n, width, 2), both evened out over time."""
    n, h, w = frames.shape[:3]
    top = h - SEAM_ROWS
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    grey = lambda f: cv2.cvtColor(f[top:], cv2.COLOR_RGB2GRAY)
    ref = frames[0][top:].astype(np.int32)
    r, g, b = ref[..., 0], ref[..., 1], ref[..., 2]
    her = ~((b > r + 20) & (b > g + 10) & (r + g + b < 330))
    her[:, max(hx0 - 10, 0):hx1 + 10] = False  # her hanging forearm moves on its own
    above = SEAM_ROWS - np.arange(SEAM_ROWS)
    rows = np.clip((SEAM_FIT[1] - above) / (SEAM_FIT[1] - SEAM_FIT[0]), 0, 1) * (above > SEAM_FIT[0])
    cols = np.arange(w)
    torso = (cols >= int(SEAM_TORSO * w)) & (cols <= hx0 - 8)
    xs, ys = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(SEAM_ROWS, dtype=np.float32))
    centre = float(cols[torso].mean())
    g0 = grey(frames[0])
    pelvis, columns, ok = [], [], []
    for f in frames:
        gi = grey(f)
        fwd, bwd = dis.calc(g0, gi, None), dis.calc(gi, g0, None)
        back = cv2.remap(bwd, xs + fwd[..., 0], ys + fwd[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(1e3, 1e3))
        weight = (her & (np.hypot(fwd[..., 0] + back[..., 0], fwd[..., 1] + back[..., 1]) < 1.5)) * rows[:, None]
        sw = gaussian_filter1d(weight.sum(0), 16)
        dx = gaussian_filter1d((weight * fwd[..., 0]).sum(0), 16) / np.maximum(sw, 1e-6)
        dy = gaussian_filter1d((weight * fwd[..., 1]).sum(0), 16) / np.maximum(sw, 1e-6)
        sel = torso & (sw > 0.5)
        ok.append(sel.sum() > 60)
        if not ok[-1]:
            pelvis.append((0.0, 0.0, 0.0))
            columns.append(np.zeros((w, 2)))
            continue
        # dy = shift + turn * (x - centre), robustly (a coat tail or her arm
        # passing over a few columns does not tilt her pelvis)
        c, cw = cols[sel], sw[sel]
        A = np.stack([np.ones(len(c)), c - centre], 1)
        k = cw.copy()
        for _ in range(5):
            shift_y, turn = np.linalg.lstsq(A * np.sqrt(k)[:, None], dy[sel] * np.sqrt(k), rcond=None)[0]
            k = cw * np.minimum(1, 1.5 / np.maximum(np.abs(dy[sel] - A @ (shift_y, turn)), 1e-3))
        shift_x = float((dx[sel] * k).sum() / k.sum())
        pelvis.append((np.arctan(turn), shift_x, shift_y))
        sure = np.clip(sw / 2, 0, 1)
        rest = np.stack([dx - shift_x, dy - shift_y - turn * (cols - centre)], 1) * sure[:, None]
        spread = gaussian_filter1d(sure, 30)
        columns.append(np.stack([gaussian_filter1d(rest[:, k], 30) for k in range(2)], 1)
                       / np.maximum(spread, 1e-3)[:, None] * np.clip(spread * 3, 0, 1)[:, None])
    ok = np.array(ok)
    pelvis = smooth_steps(pelvis, ok)
    columns = smooth_steps(np.array(columns).reshape(n, -1), ok).reshape(n, w, 2)
    print(f'waist edge followed in {int(ok.sum())}/{n} frames: pelvis turn {np.degrees(pelvis[:, 0]).min():+.1f} to '
          f'{np.degrees(pelvis[:, 0]).max():+.1f} deg, shift x {pelvis[:, 1].min():+.0f} to {pelvis[:, 1].max():+.0f}, '
          f'y {pelvis[:, 2].min():+.0f} to {pelvis[:, 2].max():+.0f} px; columns besides up to {np.abs(columns).max():.0f} px',
          file=sys.stderr)
    return pelvis, centre, columns


def extend(frames, times, plate, rest, free, below):
    """Paints her below her waist, the clip's bottom edge: `below` plate px of
    a generated extension laid under every frame (at `times` seconds),
    following her. rest is the
    plate redrawn taller (her hips and thighs) with her right hand hanging by
    her thigh; free is the same picture without that forearm and hand (it is
    up for the nose wipe and the thumbs-up). Per frame:
      - her pelvis turns and shifts with her waist edge (seam_motion), and
        just below the edge each column follows the edge's own move, so her
        belt, cut across by the edge, stays in one piece; each thigh turns
        about its knee so its hip joint stays on the pelvis, following it
        through a spring (LEG_HZ), so the legs move as two separate limbs,
        less towards the knees, and the crotch with the pelvis;
      - wherever her hanging hand is followed (track_hand), rest's forearm and
        hand are laid over the legs, turned and shifted with her gauntlet, so
        it is never cut at the edge;
      - in the last EXT_BAND rows of the clip, wherever the clip and the
        extension disagree (a hem swinging past, the hand going), the clip
        hands over to the extension gradually instead of being cut.
    frames are the clip in plate colours; returns them extended downwards."""
    n, h, w = frames.shape[:3]
    s = w / plate.shape[1]
    extra = int(round(below * s))
    size = (w, h + extra)
    scale = np.array([[s, 0, 0], [0, s, 0], [0, 0, 1]])

    def onto_clip(gen):
        M = scale @ np.vstack([register(gen, plate), [0, 0, 1]])
        if (M @ [0, gen.shape[0], 1])[1] < h + extra:
            sys.exit('the extension does not reach far enough below her waist')
        return cv2.warpAffine(gen, M[:2], size, flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE).astype(np.float32)

    rest, free = onto_clip(rest), onto_clip(free)
    # Her hand: the biggest patch where the two pictures differ, near the edge.
    diff = cv2.GaussianBlur(np.abs(rest - free).sum(2), (0, 0), 3)
    labels, count = label(diff > 60)
    sizes = np.bincount(labels[h - 120:].ravel(), minlength=count + 1)
    sizes[0] = 0
    hand = cv2.GaussianBlur((labels == sizes.argmax()).astype(np.float32), (0, 0), 3)
    hand = np.clip(cv2.dilate(hand, np.ones((9, 9), np.uint8)) * 1.5, 0, 1)
    # What is laid over the legs and follows her gauntlet: where the two
    # pictures differ plainly (ARM_DIFF), closed and without slivers. Where
    # they differ only a little, along her thigh and by her thumb, it is her
    # thigh drawn twice: carried along with her hand as it swings out, it was
    # a white shard of thigh beside her.
    hx = np.nonzero(hand[h - 40:h].max(0) > 0.5)[0]
    if len(hx) == 0:
        sys.exit('her hanging hand does not cross the edge in the extension')
    hx0, hx1 = max(hx[0] - 16, 0), min(hx[-1] + 16, w)
    print(f'hanging hand at x {hx0}-{hx1} (clip px)', file=sys.stderr)
    labels, count = label(diff > ARM_DIFF)
    sizes = np.bincount(labels[h - 120:].ravel(), minlength=count + 1)
    sizes[0] = 0
    arm = binary_fill_holes(cv2.morphologyEx((labels == sizes.argmax()).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8)))
    # rest and free draw her thigh beside her hand differently too, so that
    # takes in a band of rest's thigh; as her hand swings out from her thigh
    # (ARM_SETTLE) the band is left behind: her thigh in rest, grown from
    # points on it left of her hand up to the outline of her thumb and glove.
    smooth = cv2.bilateralFilter(np.clip(rest, 0, 255).astype(np.uint8), 9, 30, 9)
    grown = np.zeros((h + extra + 2, w + 2), np.uint8)
    for depth in range(60, extra - 10, 60):
        cv2.floodFill(smooth.copy(), grown, (int(hx0 - 40), int(h + depth)), (0, 0, 0), (THIGH_TOL,) * 3, (THIGH_TOL,) * 3,
                      4 | cv2.FLOODFILL_MASK_ONLY | (255 << 8))
    thigh = grown[1:-1, 1:-1] > 0
    soft = lambda m: np.clip(cv2.dilate(cv2.GaussianBlur(cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_OPEN, cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (ARM_OPEN, ARM_OPEN))).astype(np.float32), (0, 0), 3), np.ones((9, 9), np.uint8)) * 1.5, 0, 1)
    arm, off_thigh = soft(arm), soft(arm & ~thigh)
    ys, xs = np.nonzero(arm[h:] > 0.5)
    middle = np.array([xs.mean(), h + ys.mean(), 1.0])

    moves, shown = track_hand(frames, hx0, hx1)
    hips, centre, columns = seam_motion(frames, hx0, hx1)
    origin = np.array([centre, h - 1.0])

    def pelvis(i):
        """Frame i's pelvis as a 2x3 transform of clip px."""
        angle, tx, ty = hips[i]
        A = np.array([[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]])
        return np.hstack([A, (np.array([tx, ty]) - A @ origin + origin)[:, None]])

    at = lambda x, depth: np.array([x * s, h + depth * s])
    joints = [at(*j) for j in HIP_JOINTS]
    knees = [at(*k) for k in KNEES]

    def bone(i, joint, knee):
        """Turn and stretch about the knee that put the hip joint on the pelvis."""
        P = pelvis(i)
        moved = P[:, :2] @ joint + P[:, 2]
        a, b = joint - knee, moved - knee
        return np.arctan2(b[1], b[0]) - np.arctan2(a[1], a[0]), np.linalg.norm(b) / np.linalg.norm(a)

    legs_at = [follow([bone(i, j, k) for i in range(n)], times, LEG_HZ) for j, k in zip(joints, knees)]
    swing = np.degrees(np.ptp(legs_at[0][:, 0])), np.degrees(np.ptp(legs_at[1][:, 0]))
    print(f'thighs swing {swing[0]:.1f} and {swing[1]:.1f} degrees', file=sys.stderr)

    # Which part moves each pixel: pelvis above, the legs below, split at the
    # crotch; just below the edge, each column's own move besides.
    ys, xs = np.mgrid[0:h + extra, 0:w].astype(np.float32)
    depth = (ys - h) / s
    k = np.clip((depth - PELVIS_TO_LEGS[0]) / (PELVIS_TO_LEGS[1] - PELVIS_TO_LEGS[0]), 0, 1)
    on_pelvis = 1 - k * k * (3 - 2 * k)
    k = np.clip((xs / s - (LEG_SPLIT_X - 24)) / 48, 0, 1)
    on_right = k * k * (3 - 2 * k)
    weights = (on_pelvis, (1 - on_pelvis) * (1 - on_right), (1 - on_pelvis) * on_right)
    k = np.clip((depth - SEAM_FADE[0]) / (SEAM_FADE[1] - SEAM_FADE[0]), 0, 1)
    on_edge = 1 - k * k * (3 - 2 * k)

    def moved(i):
        """The free picture with her pelvis and each thigh moved for frame i."""
        P = pelvis(i)
        dx = weights[0] * (P[0, 0] * xs + P[0, 1] * ys + P[0, 2] - xs) + on_edge * columns[i][:, 0]
        dy = weights[0] * (P[1, 0] * xs + P[1, 1] * ys + P[1, 2] - ys) + on_edge * columns[i][:, 1]
        for (angle, stretch), knee, weight in zip((legs_at[0][i], legs_at[1][i]), knees, weights[1:]):
            c, sn = stretch * np.cos(angle), stretch * np.sin(angle)
            rx, ry = xs - knee[0], ys - knee[1]
            dx += weight * (knee[0] + c * rx - sn * ry - xs)
            dy += weight * (knee[1] + sn * rx + c * ry - ys)
        # Displacements are small and smooth, so q - D(q) inverts them closely.
        return cv2.remap(free, (xs - dx).astype(np.float32), (ys - dy).astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

    out = np.empty((n, h + extra, w, 3), np.uint8)
    rows = np.arange(EXT_BAND, dtype=np.float32)[:, None] / (EXT_BAND - 1)
    ramp = rows * rows * (3 - 2 * rows)
    for i in range(n):
        legs = moved(i)
        if shown[i]:
            k = min(np.hypot(*(moves[i] @ middle - middle[:2])) / ARM_SETTLE, 1.0)
            fade = cv2.warpAffine(arm * (1 - k) + off_thigh * k, moves[i], size)[..., None]
            legs = legs * (1 - fade) + cv2.warpAffine(rest, moves[i], size, borderMode=cv2.BORDER_REPLICATE) * fade
        clip = frames[i].astype(np.float32)
        top = h - EXT_BAND
        apart = cv2.GaussianBlur(np.abs(clip[top:] - legs[top:h]).mean(2), (0, 0), 4)
        apart = np.clip((apart - 10) / 25, 0, 1)
        weight = (ramp * (ramp + (1 - ramp) * apart))[..., None]
        out[i, :top] = frames[i][:top]
        out[i, top:h] = np.clip(clip[top:] * (1 - weight) + legs[top:h] * weight + 0.5, 0, 255).astype(np.uint8)
        out[i, h:] = np.clip(legs[h:] + 0.5, 0, 255).astype(np.uint8)
    return out


def output(pre, a, size, shadow=None):
    """Premultiplied RGBA at the output size (width, height). VideoToolbox tags the clip's
    alpha as premultiplied and WebKit composites it that way (colour plus
    band times one minus alpha), so straight colour here would add a bright,
    speckled fringe around her and stray dots where alpha is zero. Colour is
    kept at or below alpha, as premultiplied colour must be.

    shadow (DX, DY, BLUR, OPACITY; output px) lays a soft black copy of her
    under her, offset down and to the right, so she stands in front of the
    band instead of looking pasted onto it. Black adds no colour, so only the
    alpha around her grows."""
    pre = cv2.resize(pre, size, interpolation=cv2.INTER_AREA)
    a = cv2.resize(a, size, interpolation=cv2.INTER_AREA)
    if shadow:
        dx, dy, blur, opacity = shadow
        cast = cv2.warpAffine(a, np.float32([[1, 0, dx], [0, 1, dy]]), size)
        a = a + cv2.GaussianBlur(cast, (0, 0), blur) * opacity * (1 - a)
    a = np.clip(a * 255 + 0.5, 0, 255).astype(np.uint8)
    rgb = np.minimum(np.clip(pre + 0.5, 0, 255).astype(np.uint8), a[..., None])
    return np.dstack([rgb, a])


def islands(rgba, faint, reach=5):
    """--islands: clears, in place, the parts of output frame rgba
    (premultiplied, 0-255) that float apart from her and stay faint. Alpha
    above 0.1 is split into connected parts after growing it by reach px, so
    hair strands and wrench tips that touch her only through a soft edge
    still count as her; every part but the largest whose alpha never reaches
    faint is cleared, its soft rim within reach with it."""
    a = rgba[..., 3]
    solid = a > 25
    if not solid.any():
        return rgba
    grow = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * reach + 1, 2 * reach + 1))
    count, parts = cv2.connectedComponents(cv2.dilate(solid.astype(np.uint8), grow), connectivity=8)
    if count <= 2:
        return rgba
    sizes = np.bincount(parts[solid], minlength=count)
    sizes[0] = 0
    peak = np.zeros(count, np.uint8)
    np.maximum.at(peak, parts[solid], a[solid])
    drop = peak < faint
    drop[0] = False
    drop[sizes.argmax()] = False
    if drop.any():
        rgba[drop[parts]] = 0
    return rgba


def opening(image, rect, size):
    """--open-on: the straight-alpha RGBA image, premultiplied (as output()'s
    frames are) and resized into rect (x, y, w, h as fractions of size) of an
    otherwise empty output frame; float, 0-255."""
    width, height = size
    x, y, w, h = rect
    box = (int(round(w * width)), int(round(h * height)))
    pre = image.astype(np.float32)
    pre[..., :3] *= pre[..., 3:4] / 255
    pre = cv2.resize(pre, box, interpolation=cv2.INTER_AREA)
    frame = np.zeros((height, width, 4), np.float32)
    x0, y0 = int(round(x * width)), int(round(y * height))
    fx0, fy0 = max(0, x0), max(0, y0)
    fx1, fy1 = min(width, x0 + box[0]), min(height, y0 + box[1])
    frame[fy0:fy1, fx0:fx1] = pre[fy0 - y0:fy1 - y0, fx0 - x0:fx1 - x0]
    return frame


def head_region(alpha):
    """--meta: rows/cols (y0, y1, x0, x1) of her head in frame 0: the top
    third of her alpha bbox, padded a little, where a face that moved shows."""
    ys, xs = np.nonzero(alpha > 128)
    if len(xs) == 0:
        return 0, alpha.shape[0], 0, alpha.shape[1]
    y0, y1 = ys.min(), ys.min() + (ys.max() - ys.min()) // 3
    pad = max(4, (xs.max() - xs.min()) // 20)
    return max(0, y0 - pad), min(alpha.shape[0], y1 + pad), max(0, xs.min() - pad), min(alpha.shape[1], xs.max() + 1 + pad)


def head_gray(rgba):
    """Premultiplied RGBA laid over mid grey and made grey (float): colour and
    silhouette both count, so a face, hair or wrench that moved shows."""
    rgb = rgba[..., :3].astype(np.float32) + 128 * (1 - rgba[..., 3:4].astype(np.float32) / 255)
    return rgb @ np.array([0.299, 0.587, 0.114], np.float32)


def alpha_box(alpha, threshold=25.5):
    """Her alpha bbox (--meta's box): [x0, y0, x1, y1], 0-1 of the frame, x1/y1
    exclusive. alpha is 0-255; threshold is 0.1 of that, matching the mask's
    own alpha>0.1 cutoff. The whole frame if nothing is above it (should not
    happen on a real clip)."""
    h, w = alpha.shape
    ys, xs = np.nonzero(alpha > threshold)
    if len(xs) == 0:
        return [0.0, 0.0, 1.0, 1.0]
    return [float(xs.min()) / w, float(ys.min()) / h, float(xs.max() + 1) / w, float(ys.max() + 1) / h]


def encode_mask(grid):
    """grid (rows, cols bool, row 0 top) as the contract's hex string: bits
    row-major, each hex digit four consecutive cells, most significant bit
    first. Zero-padded if the cell count is not a multiple of four (it is,
    for MASK_COLS x MASK_ROWS, but this does not assume it)."""
    bits = grid.astype(np.uint8).ravel()
    pad = (-len(bits)) % 4
    if pad:
        bits = np.concatenate([bits, np.zeros(pad, np.uint8)])
    nibbles = bits.reshape(-1, 4)
    values = nibbles[:, 0] * 8 + nibbles[:, 1] * 4 + nibbles[:, 2] * 2 + nibbles[:, 3]
    return ''.join(f'{v:x}' for v in values)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('clip')
    parser.add_argument('plate')
    parser.add_argument('--trim')
    parser.add_argument('--drop', help='N,..: source frames (numbered from 1) left out without retiming, such as a cross-fade')
    parser.add_argument('--cut', help='A:B: source frames (numbered from 1, inclusive) ripple-deleted; later frames shift back to close the gap (a held pose, unlike --drop\'s single bad frame)')
    parser.add_argument('--squeeze', help='A:B:R: source frames (numbered from 1, inclusive) sped up R times instead of removed, so a slow hold can be sped through without an optical-flow jump between two now-distant frames')
    parser.add_argument('--snap', help='A:B[,C:D,..]: source frames (numbered from 1, inclusive, same numbering as --trim/--cut/--squeeze) too fast for DIS flow to blend without a double-exposure ghost; output frames land on the nearest kept source frame instead (animation on twos, no flow warp), and these frames\' matte is not smoothed across neighbours (still hole-filled/cleaned per frame as usual)')
    parser.add_argument('--seconds', type=float)
    parser.add_argument('--preview')
    parser.add_argument('--quality', type=int, default=60, help='VideoToolbox -q:v, 1-100')
    parser.add_argument('--fps', type=int, default=OUT_FPS, help=f'output frames per second (default {OUT_FPS})')
    parser.add_argument('--out', default=str(OUT), help='where the clip is written (default Resources/web/layers/awakening.mov)')
    parser.add_argument('--width', type=int, default=OUT_W, help='output px across; keep her pixel density when the plate is wider than 1728 px (1258 for a 2058 px 3:4 whole-body plate)')
    parser.add_argument('--align-to', help='PLATE.png: registers the clip onto this plate (align(), as --then does onto the first clip) before matting; resized to the clip\'s own frame size first')
    parser.add_argument('--core', help='X,Y: the chest star in the first frame (plate px); re-light it along core_level')
    parser.add_argument('--core-min', type=int, default=4000, help='smallest warm patch (px) taken for the emblem')
    parser.add_argument('--core-max', type=int, help='largest warm patch (px) taken for the emblem (keeps her orange armour out)')
    parser.add_argument('--core-reach', type=int, help='px around its last place searched for the emblem (default 280 across, 260 down)')
    parser.add_argument('--core-start', type=float, default=0.0, help='seconds added to every frame\'s time before core_level (default 0): lets a clip built standalone (--align-to, no --then chain) start already past the ember-to-lit rise, matching a clip it continues from instead of restarting it')
    parser.add_argument('--fit', help='a0,b0,a1,b1,a2,b2: skip colour_fit and use these per-channel (gain, offset) pairs instead, as printed by a previous run\'s "colour fit" line; for a clip built standalone that must carry the same colour correction as the clip it continues from (whose own frame 0 this clip never sees)')
    parser.add_argument('--hair-zone', help='X0,Y0,X1,Y1: clip px her head moves in, or auto (each frame: the top of her matte, see head_zone); the backdrop between her hair strands there is taken out (hair_gaps)')
    parser.add_argument('--edge-fit', action='store_true', help='take her soft edge\'s alpha from its colour between the backdrop and her own (see edge_alpha); for a clip shown on a light window')
    parser.add_argument('--hair-strands', type=int, default=0, help='PX (clip): dark blue patches in --hair-zone smaller than this are backdrop by colour alone, skipping the smoothness test (the gaps between her hair strands)')
    parser.add_argument('--hair-blue', help=f'LO,HI: blue over red and green where a dark pixel in --hair-zone starts to count as backdrop, and where it counts fully (default {HAIR_BLUE[0]:g},{HAIR_BLUE[1]:g}); lower it so strands mixed with the backdrop (greyer than it) go too')
    parser.add_argument('--body-gaps', type=int, default=0, help='PX: open up backdrop she encloses that Vision took as part of her (between her arm and waist, between her legs), in smooth patches of at least PX px nearly the backdrop\'s own colour (see body_gaps); for a clip shown on a window')
    parser.add_argument('--hair-dark', help=f'LO,HI: luma (0-255) below which a dark blue pixel in --hair-zone is all backdrop, and above which none of it is (default {HAIR_DARK[0]:g},{HAIR_DARK[1]:g}); lower it where the shaded side of her white suit is that blue')
    parser.add_argument('--shadow', help='DX,DY,BLUR,OPACITY: a soft shadow of her under her (clip px; see output)')
    parser.add_argument('--then', help='a second clip made from the first one\'s last frame, played after it')
    parser.add_argument('--then-trim')
    parser.add_argument('--then-drop')
    parser.add_argument('--then-cut')
    parser.add_argument('--then-squeeze')
    parser.add_argument('--then-snap')
    parser.add_argument('--then-seconds', type=float)
    parser.add_argument('--extend', help='REST.png: the plate redrawn taller, her hips and thighs below her waist, right hand hanging')
    parser.add_argument('--extend-free', help='FREE.png: the same picture without that forearm and hand')
    parser.add_argument('--extend-px', type=int, default=256, help='plate px of her painted below her waist')
    parser.add_argument('--meta', help='OUT.json: per-clip playback metadata for the desktop pet (frames, seconds, fps, size, box, from, to, safe, mask); see Resources/web/pet\'s clips.json contract')
    parser.add_argument('--safe-threshold', type=float, default=SAFE_THRESHOLD, help=f'--meta: low-res premultiplied RGBA mean abs diff from frame 0 below which a frame is "safe" to hand over to another clip (default {SAFE_THRESHOLD}; tune from the printed curve)')
    parser.add_argument('--islands', type=int, help='A (0-255): clear parts floating apart from her whose alpha never reaches A (see islands())')
    parser.add_argument('--open-on', help='IMAGE.png: straight-alpha image output frame 0 shows exactly, dissolving into the clip over --open-seconds')
    parser.add_argument('--open-rect', help='X,Y,W,H: where --open-on is laid, fractions of the output frame')
    parser.add_argument('--open-seconds', type=float, default=0.5, help='--open-on: seconds the image takes to dissolve into the clip (default 0.5)')
    parser.add_argument('--poster', help='OUT.png: output frame 0, straight alpha (un-premultiplied); her neutral pose, shown before any clip loads')
    parser.add_argument('--key', choices=['green'], help='green: the clip was generated on a chroma-green backdrop; her alpha comes from premultiplied_green (no hair-zone, edge-fit or deblue)')
    parser.add_argument('--floor', type=float, help='FRAC: --key green: below this fraction of the frame height, greenish pixels well off Vision\'s matte (the shadow Seedance lays under her) are backdrop')
    parser.add_argument('--rest', help='REST.png: straight-alpha image (the plate, matted) the clip\'s first and last frames become exactly, easing in and out over --rest-seconds; --meta then plays the whole clip (from 0, to the last frame)')
    parser.add_argument('--rest-seconds', type=float, default=0.25, help='--rest: seconds at each end over which the clip eases onto the rest image (default 0.25)')
    args = parser.parse_args()
    if bool(args.extend) != bool(args.extend_free):
        parser.error('--extend and --extend-free go together')
    if bool(args.open_on) != bool(args.open_rect):
        parser.error('--open-on and --open-rect go together')

    def load(path, trim, drop, cut, squeeze, snap, seconds):
        """The clip's frames, their times (seconds from its first), and which
        of them --snap flags (bool array, aligned with the returned frames)."""
        clip, fps = decode(path)
        first = 1
        if trim:
            first, last = (int(v) for v in trim.split(':'))
            clip = clip[first - 1:last]
        keep, slots = unrepeat(clip)
        print(f'{path}: {len(clip)} source frames at {fps:g} fps', file=sys.stderr)
        if len(keep) < len(clip):
            dropped = sorted(set(range(len(clip))) - set(keep))
            print(f'  {len(dropped)} repeated frames dropped and the rest retimed: {dropped}', file=sys.stderr)
        if drop:
            # Left out where they were: the frames on both sides keep their times.
            gone = {int(v) - first for v in drop.split(',')}
            kept = [k not in gone for k in keep]
            print(f'  frames {drop} left out', file=sys.stderr)
            keep, slots = [k for k, y in zip(keep, kept) if y], slots[kept]
        if cut:
            # Ripple-deleted: unlike drop, every frame after the range has its
            # slot pulled back by the range's width, so the gap it leaves in
            # the timeline closes instead of being flowed over.
            lo, hi = (int(v) - first for v in cut.split(':'))
            inside = [lo <= k <= hi for k in keep]
            width = hi - lo + 1
            keep = [k for k, y in zip(keep, inside) if not y]
            slots = np.array([s - width if s > hi else s for s, y in zip(slots, inside) if not y])
            print(f'  frames {cut} cut: {sum(inside)} frame(s), timeline shortened {width / fps:.3f}s', file=sys.stderr)
        if squeeze:
            # Sped up in place rather than removed: every output frame still
            # blends between two genuinely adjacent source frames (the flow a
            # cut would otherwise bridge across a far larger, visibly
            # different gap), so a long hold where she keeps drifting (never
            # truly still) can be sped through smoothly instead of jump-cut.
            lo, hi, factor = squeeze.split(':')
            lo, hi, factor = int(lo) - first, int(hi) - first, float(factor)
            deltas = np.diff(slots, prepend=slots[0])
            for idx in range(1, len(keep)):
                if lo <= keep[idx] <= hi:
                    deltas[idx] /= factor
            slots = slots[0] + np.cumsum(deltas)
            print(f'  frames {squeeze} sped up {factor:g}x', file=sys.stderr)
        if snap:
            # Resolved last: only asks, of the raw numbers still present after
            # drop/cut, which fall in a --snap range; squeeze only retimes, it
            # never changes which raw numbers are in `keep`, so doing this
            # before or after squeeze makes no difference.
            ranges = [tuple(int(v) - first for v in part.split(':')) for part in snap.split(',')]
            snapped = np.array([any(lo <= k <= hi for lo, hi in ranges) for k in keep], bool)
            print(f'  frames {snap} snapped to the nearest source frame (no flow blend, no matte smoothing)', file=sys.stderr)
        else:
            snapped = np.zeros(len(keep), bool)
        times = slots / fps
        return (clip[keep] if len(keep) < len(clip) else clip), times * (seconds / times[-1] if seconds else 1), snapped

    frames, times, snap = load(args.clip, args.trim, args.drop, args.cut, args.squeeze, args.snap, args.seconds)
    seconds = times[-1]
    if args.then:
        # Its first frame is the first clip's last one, so it is dropped.
        more, more_times, more_snap = load(args.then, args.then_trim, args.then_drop, args.then_cut, args.then_squeeze, args.then_snap, args.then_seconds)
        more, _ = align(more, frames[-1])
        times = np.concatenate([times, seconds + more_times[1:]])
        frames = np.concatenate([frames, more[1:]])
        snap = np.concatenate([snap, more_snap[1:]])
        seconds += more_times[-1]
    n = len(frames)
    h, w = frames.shape[1:3]

    aligned_to_plate = False
    if args.align_to:
        # The plate may not be at the clip's own resolution (resize first);
        # align() then applies the one transform it finds on frame 0 to every
        # frame, exactly as it lays a --then clip onto the one before it.
        ref = cv2.cvtColor(cv2.imread(args.align_to), cv2.COLOR_BGR2RGB)
        ref = cv2.resize(ref, (w, h), interpolation=cv2.INTER_AREA)
        frames, aligned_to_plate = align(frames, ref)

    def matte_all(clip, snap=None):
        work = Path(tempfile.mkdtemp())
        try:
            masks = mattes(clip, work)
        finally:
            shutil.rmtree(work)
        # Smoothed over three frames, so the edges of her hair do not flicker;
        # but where she is opaque in a frame she stays opaque in it, or a hand
        # moving fast would turn see-through where the frames beside have none.
        out = np.empty_like(masks)
        last = len(masks) - 1
        # Nor does a frame take on the frames beside it far from where she is
        # in it: a fast hand left a faint, speckled trail.
        near = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
        for i, m in enumerate(masks):
            if snap is not None and snap[i]:
                # --snap: motion here is too fast even for this 3-frame blend
                # to ride along with -- it would cross-fade her matte between
                # two distant poses, the same double exposure as the colour
                # blend it stands in for. Her own matte alone, no neighbours.
                out[i] = m
                continue
            smooth = np.minimum(masks[max(i - 1, 0)] * 0.25 + m * 0.5 + masks[min(i + 1, last)] * 0.25, cv2.dilate(m, near))
            inside = cv2.erode((m >= 250).astype(np.uint8), np.ones((5, 5), np.uint8)) * 255
            out[i] = np.clip(np.maximum(smooth, inside) + 0.5, 0, 255).astype(np.uint8)
        return out

    # With an extension her mattes are made after it is painted in, on the
    # extended frames; only the first frame's is needed before, for the colours.
    masks = matte_all(frames[:1] if args.extend else frames, snap[:1] if args.extend else snap)

    full_plate = cv2.cvtColor(cv2.imread(args.plate), cv2.COLOR_BGR2RGB)
    plate = cv2.resize(full_plate, (w, h), interpolation=cv2.INTER_AREA)
    if args.fit:
        fit = np.array([float(v) for v in args.fit.split(',')]).reshape(3, 2)
        print('colour fit (a, b): given', np.round(fit, 3).tolist(), file=sys.stderr)
    else:
        fit = colour_fit(frames[0], plate, masks[0])
        print('colour fit (a, b):', np.round(fit, 3).tolist(), file=sys.stderr)
    lut = np.clip(np.arange(256)[None, :] * fit[:, :1] + fit[:, 1:], 0, 255).astype(np.uint8)
    frames = np.stack([np.dstack([lut[c][f[..., c]] for c in range(3)]) for f in frames])
    count = int(round(seconds * args.fps)) + 1
    if args.core:
        reach = (args.core_reach, args.core_reach) if args.core_reach else (280, 260)
        relight_core(frames, times + args.core_start, tuple(int(v) for v in args.core.split(',')), args.core_min, reach, args.core_max)
    if args.extend:
        load_rgb = lambda path: cv2.cvtColor(cv2.imread(path), cv2.COLOR_BGR2RGB)
        frames = extend(frames, times, full_plate, load_rgb(args.extend), load_rgb(args.extend_free), args.extend_px)
        h = frames.shape[1]
        masks = matte_all(frames, snap)
    out_size = (args.width, int(round(args.width * h / w / 2)) * 2)
    print(f'output {out_size[0]}x{out_size[1]}', file=sys.stderr)
    sources = {}
    hair_zone = ('auto' if args.hair_zone == 'auto' else tuple(int(v) for v in args.hair_zone.split(','))) if args.hair_zone else None
    hair_dark = tuple(float(v) for v in args.hair_dark.split(',')) if args.hair_dark else HAIR_DARK
    hair_blue = tuple(float(v) for v in args.hair_blue.split(',')) if args.hair_blue else HAIR_BLUE
    shadow = None
    if args.shadow:
        dx, dy, blur, opacity = (float(v) for v in args.shadow.split(','))
        k = out_size[0] / w
        shadow = (dx * k, dy * k, blur * k, opacity)

    def source(i):
        """Premultiplied colour and alpha of source frame i (two kept)."""
        if i not in sources:
            if len(sources) > 2:
                sources.pop(min(sources))
            if args.key == 'green':
                sources[i] = premultiplied_green(frames[i], masks[i], args.floor)
                return sources[i]
            pre, a = premultiplied(frames[i], masks[i], hair_zone, hair_dark, args.edge_fit, args.hair_strands, hair_blue, args.body_gaps)
            rgb = deblue(pre / np.maximum(a, 1e-3)[..., None])
            sources[i] = (np.clip(rgb, 0, 255) * a[..., None], a)
        return sources[i]

    rest_rgba, rest_frames = None, 0
    if args.rest:
        rest = cv2.cvtColor(cv2.imread(args.rest, cv2.IMREAD_UNCHANGED), cv2.COLOR_BGRA2RGBA).astype(np.float32)
        rest_a = rest[..., 3:] / 255
        rest_pre = cv2.resize(rest[..., :3] * rest_a, out_size, interpolation=cv2.INTER_AREA)
        rest_alpha = cv2.resize(rest_a[..., 0], out_size, interpolation=cv2.INTER_AREA)
        rest_rgba = output(rest_pre, rest_alpha, out_size).astype(np.float32)
        rest_frames = int(round(args.rest_seconds * args.fps))

    encode = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', f'{out_size[0]}x{out_size[1]}',
                               '-r', str(args.fps), '-i', '-', '-c:v', 'hevc_videotoolbox', '-alpha_quality', '0.9', '-q:v', str(args.quality),
                               '-tag:v', 'hvc1', '-movflags', '+faststart', args.out], stdin=subprocess.PIPE)
    preview = None
    if args.preview:
        preview = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{out_size[0]}x{out_size[1]}',
                                    '-r', str(args.fps), '-i', '-', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p',
                                    args.preview], stdin=subprocess.PIPE)
        band = np.zeros((out_size[1], out_size[0], 3), np.float32) + np.array((16, 15, 32), np.float32)

    # --meta / --poster: besides encoding, frame 0 is kept (both need it), and
    # with --meta every frame's low-res premultiplied RGBA (safe, the leading
    # and trailing freeze) and coarse alpha grid (mask) are kept too. None of
    # this runs, or costs anything, without the flag that needs it.
    want_frame0 = bool(args.meta) or bool(args.poster)
    frame0_rgba = None
    low_res, grids = (None, None)
    mask_bounds = None
    head_box = None
    if args.meta:
        low_res, grids, heads = [], [], []
        row_bounds = np.linspace(0, out_size[1], MASK_ROWS + 1).round().astype(int)
        col_bounds = np.linspace(0, out_size[0], MASK_COLS + 1).round().astype(int)
        mask_bounds = (row_bounds, col_bounds)
        lr_h = max(1, round(MASK_LOW_RES * out_size[1] / out_size[0]))

    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    cached = {}

    half = (w // 2, h // 2)

    def half_flow(a, b):
        g = lambda m: cv2.cvtColor(cv2.resize(m, half, interpolation=cv2.INTER_AREA), cv2.COLOR_RGB2GRAY)
        return dis.calc(g(a), g(b), None)

    def pair(i):
        if i not in cached:
            cached.clear()
            if args.key == 'green':
                # Half-size flows between her silhouettes and half-size
                # alphas, for splat_flow (see the loop below).
                (pre0, a0), (pre1, a1) = source(i), source(i + 1)
                g0, g1 = silhouette(pre0, a0), silhouette(pre1, a1)
                cached[i] = (half_flow(g0, g1), half_flow(g1, g0),
                             cv2.resize(a0, half, interpolation=cv2.INTER_AREA), cv2.resize(a1, half, interpolation=cv2.INTER_AREA))
            else:
                cached[i] = (flow(dis, frames[i], frames[i + 1]), flow(dis, frames[i + 1], frames[i]))
        return cached[i]

    def full(back):
        f = cv2.resize(back, (w, h), interpolation=cv2.INTER_LINEAR)
        f[..., 0] *= w / half[0]
        f[..., 1] *= h / half[1]
        return f

    warp = lambda image, mx, my: cv2.remap(image, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    opened, open_frames = None, 0
    if args.open_on:
        image = cv2.cvtColor(cv2.imread(args.open_on, cv2.IMREAD_UNCHANGED), cv2.COLOR_BGRA2RGBA)
        opened = opening(image, tuple(float(v) for v in args.open_rect.split(',')), out_size)
        open_frames = max(1, int(round(args.open_seconds * args.fps)))
    for k in range(count):
        now = k / args.fps
        i = min(int(np.searchsorted(times, now, side='right')) - 1, n - 1)
        t = 0.0 if i >= n - 1 else float((now - times[i]) / (times[i + 1] - times[i]))
        if t < 1e-4 or i >= n - 1:
            pre, a = source(i)
        elif snap[i] or snap[i + 1]:
            # --snap: this source interval is too fast for DIS flow to bridge
            # without a double-exposure ghost, so skip the blend entirely and
            # just hold whichever source frame t is nearer to (animation on
            # twos), exactly like the t < 1e-4 case above but mid-clip.
            pre, a = source(i if t < 0.5 else i + 1)
        elif args.key == 'green':
            fwd, bwd, h0, h1 = pair(i)
            (pre0, a0), (pre1, a1) = source(i), source(i + 1)
            # Linear motion as below, but each frame's flow is carried
            # forward to where its pixels are at t (splat_flow).
            back0, back1 = full(splat_flow(fwd, h0, t)), full(splat_flow(bwd, h1, 1 - t))
            ax, ay = xx + back0[..., 0], yy + back0[..., 1]
            bx, by = xx + back1[..., 0], yy + back1[..., 1]
            wa0, wa1 = warp(a0, ax, ay), warp(a1, bx, by)
            # Where the two warps still disagree the flow failed (a turn too
            # fast for it), and a blend there is a double exposure: a ghost
            # of her boot beside it. There, lean on the nearer frame and hold
            # it as it is (animation on twos), fading in between.
            held = np.clip((cv2.GaussianBlur(np.abs(wa0 - wa1), (0, 0), 1.5) - 0.25) / 0.35, 0, 1)
            w1 = (1 - held) * t + held * (1.0 if t >= 0.5 else 0.0)
            pre = warp(pre0, ax, ay) * (1 - w1)[..., None] + warp(pre1, bx, by) * w1[..., None]
            a = wa0 * (1 - w1) + wa1 * w1
            near_pre, near_a = (pre1, a1) if t >= 0.5 else (pre0, a0)
            pre = pre * (1 - held)[..., None] + near_pre * held[..., None]
            a = a * (1 - held) + near_a * held
        else:
            fwd, bwd = pair(i)
            (pre0, a0), (pre1, a1) = source(i), source(i + 1)
            # Linear motion: the pixel at y sat at y - t*F(i->i+1) in frame i
            # and at y - (1-t)*F(i+1->i) in frame i+1.
            ax, ay = xx - t * fwd[..., 0], yy - t * fwd[..., 1]
            bx, by = xx - (1 - t) * bwd[..., 0], yy - (1 - t) * bwd[..., 1]
            pre = warp(pre0, ax, ay) * (1 - t) + warp(pre1, bx, by) * t
            a = warp(a0, ax, ay) * (1 - t) + warp(a1, bx, by) * t
        rgba = output(pre, a, out_size, shadow)
        if args.islands is not None:
            islands(rgba, args.islands)
        if rest_rgba is not None:
            # Both premultiplied, so the mix is too; the ends are the rest
            # image exactly, so any two clips meet on the same picture.
            share = rest_share(k, count, rest_frames)
            if share > 0:
                rgba = np.clip(rgba.astype(np.float32) * (1 - share) + rest_rgba * share + 0.5, 0, 255).astype(np.uint8)
                rgba[..., :3] = np.minimum(rgba[..., :3], rgba[..., 3:])
        if opened is not None and k < open_frames:
            # Smoothstep from all image (k = 0) to all clip; both are
            # premultiplied, so the mix is too, and colour stays at or below
            # alpha once rounding is clamped.
            u = k / open_frames
            clip_share = u * u * (3 - 2 * u)
            mixed = np.clip(rgba.astype(np.float32) * clip_share + opened * (1 - clip_share) + 0.5, 0, 255).astype(np.uint8)
            mixed[..., :3] = np.minimum(mixed[..., :3], mixed[..., 3:])
            rgba = mixed
        encode.stdin.write(rgba.tobytes())
        if preview:
            alpha = rgba[..., 3:].astype(np.float32) / 255
            preview.stdin.write(np.clip(rgba[..., :3] + band * (1 - alpha), 0, 255).astype(np.uint8).tobytes())
        if want_frame0 and k == 0:
            frame0_rgba = rgba.copy()
        if args.meta:
            low_res.append(cv2.resize(rgba, (MASK_LOW_RES, lr_h), interpolation=cv2.INTER_AREA).astype(np.float32))
            if head_box is None:
                head_box = head_region(rgba[..., 3])
            hy0, hy1, hx0, hx1 = head_box
            heads.append(head_gray(rgba[hy0:hy1, hx0:hx1]))
            alpha_frac = rgba[..., 3].astype(np.float32) / 255
            row_bounds, col_bounds = mask_bounds
            grid = np.zeros((MASK_ROWS, MASK_COLS), bool)
            for r in range(MASK_ROWS):
                rows = alpha_frac[row_bounds[r]:row_bounds[r + 1]]
                for c in range(MASK_COLS):
                    grid[r, c] = rows[:, col_bounds[c]:col_bounds[c + 1]].max() > 0.1
            grids.append(grid)
    for process in (encode, preview):
        if process:
            process.stdin.close()
            process.wait()
            if process.returncode:
                sys.exit('ffmpeg failed')
    print(f'wrote {count} frames at {args.fps} fps -> {args.out}', file=sys.stderr)

    if args.poster:
        a0 = frame0_rgba[..., 3].astype(np.float32)
        rgb0 = frame0_rgba[..., :3].astype(np.float32)
        # Un-premultiply: output() kept colour at or below alpha (0-255 scale).
        straight = np.where(a0[..., None] > 0, np.clip(rgb0 * 255.0 / np.maximum(a0, 1)[..., None], 0, 255), 0)
        poster = np.dstack([straight.astype(np.uint8), frame0_rgba[..., 3]])
        Path(args.poster).parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(args.poster, cv2.cvtColor(poster, cv2.COLOR_RGBA2BGRA))
        print(f'wrote {args.poster} ({out_size[0]}x{out_size[1]}, straight alpha)', file=sys.stderr)

    if args.meta:
        low_res = np.stack(low_res)  # (count, lr_h, MASK_LOW_RES, 4)
        step = np.abs(np.diff(low_res, axis=0)).mean(axis=(1, 2, 3)) if count > 1 else np.zeros(0)
        dist0 = np.abs(low_res - low_res[0]).mean(axis=(1, 2, 3))
        # The low-res frames hide a face that moved a few px, a blink or a
        # tilt of the head (all under a pixel at 48 px across), so the pet
        # cross-faded two faces apart; her head is compared at full res too.
        head0 = np.abs(np.stack(heads) - heads[0]).mean(axis=(1, 2))
        print('--meta: head distance from frame 0: ' + ' '.join(f'{v:.2f}' for v in head0), file=sys.stderr)
        still = head0 <= HEAD_SAFE
        span = max(1, round(HANDOFF_SECONDS * args.fps))
        print('--meta: frame-to-frame motion: ' + ' '.join(f'{v:.2f}' for v in step), file=sys.stderr)
        print('--meta: distance from frame 0: ' + ' '.join(f'{v:.2f}' for v in dist0), file=sys.stderr)

        # Whether frame 0 is her neutral pose: --align-to's own job is lining
        # it up with the plate, so a confident match (align() found enough
        # inliers) is the signal, not a raw pixel match against the plate --
        # colour_fit and deblue both deliberately move the clip's colour away
        # from the plate's own, and Seedance's first frame never reproduces a
        # still image exactly, so even a correctly aligned frame 0 sits 9-10
        # (0-255 scale) from the plate: nowhere near a usable "they match" cutoff.
        neutral_match = aligned_to_plate

        hold = 0
        while hold < len(step) and step[hold] < FREEZE_MOTION:
            hold += 1
        from_frame = min(max(hold, 1) if neutral_match else hold, count - 1)
        # Playback starts where the incoming clip is still on frame 0's pose
        # for the whole cross-fade: within the leading hold, the last frame
        # that leaves `span` frames of her head unmoved after it.
        run = 0
        while run + 1 < count and still[run + 1]:
            run += 1
        from_frame = max(1, min(from_frame, run - span)) if count > 1 else 0

        trail = 0
        while trail < len(step) and step[len(step) - 1 - trail] < FREEZE_MOTION:
            trail += 1
        min_trail = max(1, round(FREEZE_SECONDS * args.fps))
        to_frame = max(count - 1 - trail, from_frame) if trail >= min_trail else count - 1
        # Nor does it end on a face that has not come back yet: `to` moves
        # into the run of frames, up to the last, whose head is frame 0's.
        tail = count - 1
        while tail - 1 > from_frame and still[tail - 1]:
            tail -= 1
        if still[count - 1]:
            to_frame = max(to_frame, tail)
        if args.rest:
            # --rest: both ends are the rest image itself, so the whole clip
            # plays and hands over on the very picture the next one starts on.
            from_frame, to_frame = 0, count - 1

        # A safe frame hands over mid-clip, and the outgoing clip keeps
        # playing through the cross-fade: from two frames before it (the
        # page's LEAD) for `span` frames, every frame must be near frame 0,
        # whole and head both.
        near = (dist0 <= args.safe_threshold) & still
        safe = sorted({i for i in range(count) if near[max(0, i - 2):i + span].all() and i + span <= count}
                      | {from_frame, to_frame})

        windows = []
        every = max(1, round(args.fps / 4))
        for start in range(0, count, every):
            union = np.zeros((MASK_ROWS, MASK_COLS), bool)
            for g in grids[start:start + every]:
                union |= g
            dilated = cv2.dilate(union.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
            windows.append(encode_mask(dilated))

        meta = {
            'frames': count,
            'seconds': (count - 1) / args.fps,
            'fps': args.fps,
            'size': list(out_size),
            'box': alpha_box(frame0_rgba[..., 3]),
            'from': int(from_frame),
            'to': int(to_frame),
            'safe': safe,
            'mask': {'every': every, 'cols': MASK_COLS, 'rows': MASK_ROWS, 'frames': windows},
        }
        Path(args.meta).parent.mkdir(parents=True, exist_ok=True)
        Path(args.meta).write_text(json.dumps(meta) + '\n')
        print(f'wrote {args.meta}: frame 0 {"is" if neutral_match else "is not"} the neutral pose; from {from_frame}, to {to_frame}, '
              f'{len(safe)} safe frame(s), {len(windows)} mask window(s)', file=sys.stderr)


if __name__ == '__main__':
    main()
