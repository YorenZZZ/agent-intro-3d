#!/usr/bin/env python3
"""Writes her plate made taller: the plate itself, and below its bottom edge
(her waist) PX plate px of a generated extension (her hips and thighs, right
hand hanging), laid on as build-clip.py --extend lays it under her clip, with
the same blue cast taken out (deblue). Her
still layers are cut from it (tools/build-portrait.sh), so they fill the same
box as the extended clip.

usage: python tools/extend-plate.py PLATE.png REST.png PX OUT.png
needs: numpy, opencv-python-headless, scipy
"""
import importlib.util
import sys
from pathlib import Path

import cv2
import numpy as np

spec = importlib.util.spec_from_file_location('build_clip', Path(__file__).with_name('build-clip.py'))
build_clip = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build_clip)

plate_path, rest_path, px, out = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
plate = cv2.cvtColor(cv2.imread(plate_path), cv2.COLOR_BGR2RGB)
rest = cv2.cvtColor(cv2.imread(rest_path), cv2.COLOR_BGR2RGB)
h, w = plate.shape[:2]
M = build_clip.register(rest, plate)
taller = cv2.warpAffine(rest, M, (w, h + px), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
taller[:h] = plate
# The same blue cast comes out of the stills as out of her clip.
taller = np.clip(build_clip.deblue(taller.astype(np.float32)) + 0.5, 0, 255).astype(np.uint8)
cv2.imwrite(out, cv2.cvtColor(taller, cv2.COLOR_RGB2BGR))
print(f'wrote {out} ({w}x{h + px})')
