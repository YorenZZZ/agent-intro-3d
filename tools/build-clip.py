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
(core_level), without flicker.

Seedance often holds still for its last few frames; --trim A:B keeps source
frames A..B (numbered from 1) and --seconds S retimes what is left. --then
appends a second clip made from the first one's last frame (her idle after
the action), with its own --then-trim, --then-drop and --then-seconds.
Seedance redraws that frame a little larger or shifted, so the second clip is
first laid onto the first one's last frame (align), or she would jump there.

--extend paints her below her waist (the clip's bottom edge): REST is the
plate redrawn taller with her hips and thighs (her right hand hanging by her
thigh), --extend-free the same picture without that forearm and hand; see
extend(). The clip gets --extend-px plate px taller.

usage: python tools/build-clip.py CLIP.mp4 PLATE.png [--trim A:B] [--drop N,..] [--seconds S]
           [--then CLIP2.mp4 [--then-trim A:B] [--then-drop N,..] [--then-seconds S]]
           [--extend REST.png --extend-free FREE.png [--extend-px PX]]
           [--core X,Y [--core-min PX]] [--quality Q] [--preview OUT.mp4]
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
# Backdrop between her hair strands (see hair_gaps): blue over red and green
# from the first to the second is the backdrop's; darker than the first grey
# level, not lighter than the second; smoother inside than the first
# (median luma gradient), not as textured as the second.
HAIR_BLUE = (10.0, 20.0)
HAIR_DARK = (58.0, 78.0)
HAIR_SMOOTH = (10.0, 16.0)
# A frame is a repeat of the one before it when it moves less than this share
# of its neighbours' steps, and both move more than REPEAT_MOVING (mean grey
# level change at quarter size): see unrepeat().
REPEAT_RATIO = 0.4
REPEAT_MOVING = 0.8


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


def hair_gaps(frame, matte, zone):
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
    k = ramp(c[..., 2] - c[..., :2].max(axis=2), *HAIR_BLUE) * (1 - ramp(luma, *HAIR_DARK)) * inside
    patches = ((k > 0.3) & (matte > 128)).astype(np.uint8)
    count, labels = cv2.connectedComponents(patches)
    if count > 1:
        grad = np.hypot(cv2.Sobel(luma, cv2.CV_32F, 1, 0, ksize=3), cv2.Sobel(luma, cv2.CV_32F, 0, 1, ksize=3))
        core = cv2.erode(patches, np.ones((3, 3), np.uint8)) > 0
        smooth = np.ones(count, np.float32)
        for j in range(1, count):
            g = grad[(labels == j) & core]
            smooth[j] = 1 - ramp(float(np.median(g)), *HAIR_SMOOTH) if g.size > 5 else 1.0
        smooth[0] = 1.0
        k = k * smooth[labels]
    return cv2.GaussianBlur(k, (0, 0), 0.7)


def premultiplied(frame, matte, hair_zone=None):
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
    if hair_zone:
        a = np.minimum(a, 1 - hair_gaps(frame, matte, hair_zone))
    a = a[..., None]
    return np.clip(c - (1 - a) * bg, 0, 255 * a), a[..., 0]


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
    between the clip's first frame and onto is applied to all its frames."""
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
        return clip
    moved = np.linalg.norm(src @ M[:, :2].T + M[:, 2] - src, axis=1)[inliers.ravel() == 1]
    print(f'second clip laid onto the first: scale {np.hypot(M[0, 0], M[1, 0]):.4f}, '
          f'turn {np.degrees(np.arctan2(M[1, 0], M[0, 0])):+.2f} deg, her points moved {np.median(moved):.1f} px '
          f'(median of {int(inliers.sum())} matches)', file=sys.stderr)
    h, w = clip.shape[1:3]
    return np.stack([cv2.warpAffine(f, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE) for f in clip])


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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('clip')
    parser.add_argument('plate')
    parser.add_argument('--trim')
    parser.add_argument('--drop', help='N,..: source frames (numbered from 1) left out without retiming, such as a cross-fade')
    parser.add_argument('--seconds', type=float)
    parser.add_argument('--preview')
    parser.add_argument('--quality', type=int, default=60, help='VideoToolbox -q:v, 1-100')
    parser.add_argument('--out', default=str(OUT), help='where the clip is written (default Resources/web/layers/awakening.mov)')
    parser.add_argument('--width', type=int, default=OUT_W, help='output px across; keep her pixel density when the plate is wider than 1728 px (1258 for a 2058 px 3:4 whole-body plate)')
    parser.add_argument('--core', help='X,Y: the chest star in the first frame (plate px); re-light it along core_level')
    parser.add_argument('--core-min', type=int, default=4000, help='smallest warm patch (px) taken for the emblem')
    parser.add_argument('--core-max', type=int, help='largest warm patch (px) taken for the emblem (keeps her orange armour out)')
    parser.add_argument('--core-reach', type=int, help='px around its last place searched for the emblem (default 280 across, 260 down)')
    parser.add_argument('--hair-zone', help='X0,Y0,X1,Y1: clip px her head moves in; the backdrop between her hair strands there is taken out (hair_gaps)')
    parser.add_argument('--shadow', help='DX,DY,BLUR,OPACITY: a soft shadow of her under her (clip px; see output)')
    parser.add_argument('--then', help='a second clip made from the first one\'s last frame, played after it')
    parser.add_argument('--then-trim')
    parser.add_argument('--then-drop')
    parser.add_argument('--then-seconds', type=float)
    parser.add_argument('--extend', help='REST.png: the plate redrawn taller, her hips and thighs below her waist, right hand hanging')
    parser.add_argument('--extend-free', help='FREE.png: the same picture without that forearm and hand')
    parser.add_argument('--extend-px', type=int, default=256, help='plate px of her painted below her waist')
    args = parser.parse_args()
    if bool(args.extend) != bool(args.extend_free):
        parser.error('--extend and --extend-free go together')

    def load(path, trim, drop, seconds):
        """The clip's frames and their times (seconds from its first)."""
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
        times = slots / fps
        return clip[keep] if len(keep) < len(clip) else clip, times * (seconds / times[-1] if seconds else 1)

    frames, times = load(args.clip, args.trim, args.drop, args.seconds)
    seconds = times[-1]
    if args.then:
        # Its first frame is the first clip's last one, so it is dropped.
        more, more_times = load(args.then, args.then_trim, args.then_drop, args.then_seconds)
        more = align(more, frames[-1])
        times = np.concatenate([times, seconds + more_times[1:]])
        frames = np.concatenate([frames, more[1:]])
        seconds += more_times[-1]
    n = len(frames)
    h, w = frames.shape[1:3]

    def matte_all(clip):
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
            smooth = np.minimum(masks[max(i - 1, 0)] * 0.25 + m * 0.5 + masks[min(i + 1, last)] * 0.25, cv2.dilate(m, near))
            inside = cv2.erode((m >= 250).astype(np.uint8), np.ones((5, 5), np.uint8)) * 255
            out[i] = np.clip(np.maximum(smooth, inside) + 0.5, 0, 255).astype(np.uint8)
        return out

    # With an extension her mattes are made after it is painted in, on the
    # extended frames; only the first frame's is needed before, for the colours.
    masks = matte_all(frames[:1] if args.extend else frames)

    full_plate = cv2.cvtColor(cv2.imread(args.plate), cv2.COLOR_BGR2RGB)
    plate = cv2.resize(full_plate, (w, h), interpolation=cv2.INTER_AREA)
    fit = colour_fit(frames[0], plate, masks[0])
    print('colour fit (a, b):', np.round(fit, 3).tolist(), file=sys.stderr)
    lut = np.clip(np.arange(256)[None, :] * fit[:, :1] + fit[:, 1:], 0, 255).astype(np.uint8)
    frames = np.stack([np.dstack([lut[c][f[..., c]] for c in range(3)]) for f in frames])
    count = int(round(seconds * OUT_FPS)) + 1
    if args.core:
        reach = (args.core_reach, args.core_reach) if args.core_reach else (280, 260)
        relight_core(frames, times, tuple(int(v) for v in args.core.split(',')), args.core_min, reach, args.core_max)
    if args.extend:
        load_rgb = lambda path: cv2.cvtColor(cv2.imread(path), cv2.COLOR_BGR2RGB)
        frames = extend(frames, times, full_plate, load_rgb(args.extend), load_rgb(args.extend_free), args.extend_px)
        h = frames.shape[1]
        masks = matte_all(frames)
    out_size = (args.width, int(round(args.width * h / w / 2)) * 2)
    print(f'output {out_size[0]}x{out_size[1]}', file=sys.stderr)
    sources = {}
    hair_zone = tuple(int(v) for v in args.hair_zone.split(',')) if args.hair_zone else None
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
            pre, a = premultiplied(frames[i], masks[i], hair_zone)
            rgb = deblue(pre / np.maximum(a, 1e-3)[..., None])
            sources[i] = (np.clip(rgb, 0, 255) * a[..., None], a)
        return sources[i]

    encode = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', f'{out_size[0]}x{out_size[1]}',
                               '-r', str(OUT_FPS), '-i', '-', '-c:v', 'hevc_videotoolbox', '-alpha_quality', '0.9', '-q:v', str(args.quality),
                               '-tag:v', 'hvc1', '-movflags', '+faststart', args.out], stdin=subprocess.PIPE)
    preview = None
    if args.preview:
        preview = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{out_size[0]}x{out_size[1]}',
                                    '-r', str(OUT_FPS), '-i', '-', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p',
                                    args.preview], stdin=subprocess.PIPE)
        band = np.zeros((out_size[1], out_size[0], 3), np.float32) + np.array((16, 15, 32), np.float32)

    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    cached = {}

    def pair(i):
        if i not in cached:
            cached.clear()
            cached[i] = (flow(dis, frames[i], frames[i + 1]), flow(dis, frames[i + 1], frames[i]))
        return cached[i]

    warp = lambda image, mx, my: cv2.remap(image, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    for k in range(count):
        now = k / OUT_FPS
        i = min(int(np.searchsorted(times, now, side='right')) - 1, n - 1)
        t = 0.0 if i >= n - 1 else float((now - times[i]) / (times[i + 1] - times[i]))
        if t < 1e-4 or i >= n - 1:
            pre, a = source(i)
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
        encode.stdin.write(rgba.tobytes())
        if preview:
            alpha = rgba[..., 3:].astype(np.float32) / 255
            preview.stdin.write(np.clip(rgba[..., :3] + band * (1 - alpha), 0, 255).astype(np.uint8).tobytes())
    for process in (encode, preview):
        if process:
            process.stdin.close()
            process.wait()
            if process.returncode:
                sys.exit('ffmpeg failed')
    print(f'wrote {count} frames at {OUT_FPS} fps -> {args.out}', file=sys.stderr)


if __name__ == '__main__':
    main()
