#!/usr/bin/env python3
"""Bakes the skill name, 超频机核, as a cyber-apocalypse neon sign (laid out
like Cyberpunk 2077's HUD, coloured like her: her suit's copper orange and
white) into
Resources/web/layers/: condensed italic letters cut by thin scan slits.

  title-off.webp  the sign switched off: dark glass tubes, no light
  title.webp      lit, every letter whole: a warm white core in her
                  copper-orange glow, the scan lines a faint ripple
  title-hot.webp  a flat silver-white copy, for the glitch as it flickers on

intro.js flickers title.webp on over title-off.webp, letter by letter, like a
broken light that catches. Every glow and wear mark is baked here, never a
filter at play time. Their box in the band is TITLE_BOX in intro.js (390x117
band px; drawn at SCALE times that). It prints where each letter ends at
the box's middle height and how far the slant moves that across the box:
LETTERS and TITLE_SLANT in intro.js, which cut the sign into its letters.

usage: python tools/build-title.py
needs: Pillow, numpy (macOS fonts: Hiragino Sans GB W6)
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'Resources' / 'web' / 'layers'
TEXT = '超频机核'
SCALE = 3
W, H = 390 * SCALE, 117 * SCALE
SLANT = 0.22  # italic: x shift per px up, about the middle
FONT = ('/System/Library/Fonts/Hiragino Sans GB.ttc', 2)  # W6


def letters():
    """The text as a float mask (0-1), condensed and letter-spaced, centred
    in the box with room around it for the glow."""
    font = ImageFont.truetype(FONT[0], int(78 * SCALE), index=FONT[1])
    probe = ImageDraw.Draw(Image.new('L', (1, 1)))
    advances = [probe.textbbox((0, 0), ch, font=font)[2] for ch in TEXT]
    gap = 10 * SCALE
    width = sum(advances) + gap * (len(TEXT) - 1)
    canvas = Image.new('L', (width + 40 * SCALE, H * 2), 0)
    draw = ImageDraw.Draw(canvas)
    x = 20 * SCALE
    for ch, a in zip(TEXT, advances):
        draw.text((x, H // 2), ch, font=font, fill=255)
        x += a + gap
    glyphs = canvas.crop(canvas.getbbox())
    glyphs = glyphs.resize((int(glyphs.width * 0.84), glyphs.height), Image.LANCZOS)
    # Italic: sheared about its middle height, on a canvas wide enough for it.
    lean = int(SLANT * glyphs.height / 2) + 2
    wide = Image.new('L', (glyphs.width + 2 * lean, glyphs.height), 0)
    wide.paste(glyphs, (lean, 0))
    glyphs = wide.transform(wide.size, Image.AFFINE, (1, SLANT, -SLANT * wide.height / 2, 0, 1, 0), Image.BICUBIC)
    glyphs = glyphs.crop(glyphs.getbbox())
    fit = min((W - 40 * SCALE) / glyphs.width, (H - 30 * SCALE) / glyphs.height)
    glyphs = glyphs.resize((int(glyphs.width * fit), int(glyphs.height * fit)), Image.LANCZOS)
    out = Image.new('L', (W, H), 0)
    out.paste(glyphs, ((W - glyphs.width) // 2, (H - glyphs.height) // 2))
    return np.asarray(out, np.float32) / 255


def report_letters(t):
    """Prints where each letter ends, at the box's middle height (% of its
    width), and the slant across the box (% of its width): straightened
    about the middle, the letters' column coverage has a gap between each."""
    rows = np.arange(H)[:, None] - H / 2
    xs = np.arange(W)[None, :] + rows * SLANT
    upright = np.zeros_like(t)
    for y in range(H):
        upright[y] = np.interp(np.arange(W), xs[y], t[y], left=0, right=0)
    cols = upright.max(0) > 0.3
    runs, start = [], None
    for x, on in enumerate(np.append(cols, False)):
        if on and start is None:
            start = x
        if not on and start is not None:
            runs.append((start, x))
            start = None
    gaps = sorted(((b[0] - a[1], (a[1] + b[0]) / 2) for a, b in zip(runs, runs[1:])), reverse=True)[:len(TEXT) - 1]
    cuts = sorted(c for _, c in gaps)
    edges = [0] + [round(c / W * 100, 1) for c in cuts] + [100]
    print('LETTERS', [[edges[i], edges[i + 1]] for i in range(len(TEXT))], 'TITLE_SLANT', round(SLANT * H / 2 / W * 100, 1))


def blur(a, radius):
    image = Image.fromarray(np.clip(a * 255, 0, 255).astype(np.uint8))
    return np.asarray(image.filter(ImageFilter.GaussianBlur(radius)), np.float32) / 255


def save(rgb, alpha, name, quality=90):
    alpha = np.clip(alpha, 0, 1)
    straight = np.where(alpha[..., None] > 1e-3, rgb / np.maximum(alpha, 1e-3)[..., None], 0)
    Image.fromarray(np.dstack([np.clip(straight, 0, 255), alpha * 255]).astype(np.uint8), 'RGBA').save(OUT / name, quality=quality, method=6)


def main():
    t = letters()
    report_letters(t)

    # Scan lines: a faint ripple across the tubes every few px; the letters
    # stay whole and fully lit.
    rows = np.arange(H)[:, None]
    slits = ((rows % (7 * SCALE)) < SCALE).astype(np.float32)
    lit = t

    # Off: dark glass tubes with a faint rim, no light.
    rim = np.clip(t - blur(t, 2.0) * 0.6, 0, 1)
    off_rgb = np.array((30, 22, 22), np.float32) * t[..., None] + np.array((92, 60, 48), np.float32) * rim[..., None] * 0.6
    save(off_rgb, t * 0.92, 'title-off.webp')

    # Lit: warm white core, her copper-orange glow, a wider deeper one.
    core = lit
    inner = blur(core, 1.2 * SCALE)
    core_rgb = np.array((255, 243, 234), np.float32) * inner[..., None] + np.array((255, 156, 104), np.float32) * (1 - inner[..., None])
    core_rgb = core_rgb * (1 - 0.14 * slits[..., None])
    glow1 = blur(core, 4 * SCALE) * 0.85
    glow2 = blur(core, 11 * SCALE) * 0.55
    rgb = np.zeros((H, W, 3), np.float32)
    alpha = np.zeros((H, W), np.float32)

    def over(colour, a):
        nonlocal rgb, alpha
        a = np.clip(a, 0, 1)
        rgb = colour * a[..., None] + rgb * (1 - a[..., None])
        alpha = a + alpha * (1 - a)

    over(np.broadcast_to(np.array((210, 84, 40), np.float32), (H, W, 3)), glow2)
    over(np.broadcast_to(np.array((240, 120, 70), np.float32), (H, W, 3)), glow1)
    over(core_rgb, core)
    save(rgb, alpha, 'title.webp')

    # The silver-white copy for the glitch: the tube shape only.
    save(np.broadcast_to(np.array((244, 238, 240), np.float32), (H, W, 3)) * lit[..., None], lit, 'title-hot.webp', 80)
    print(f'wrote title-off.webp, title.webp and title-hot.webp ({W}x{H})')


if __name__ == '__main__':
    main()
