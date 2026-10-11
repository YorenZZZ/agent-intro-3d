"""pad_plate.py SRC OUT SCALE [--wm X0,Y0,X1,Y1]
Shrinks a 1728x2304 plate to SCALE, bottom-anchored and centred. The freed
top/left/right are filled with the plate's own background, continued outward:
the character is masked out (anything brighter or more saturated than the dark
navy backdrop), the backdrop inpainted at low resolution into a smooth field,
and that field sampled through the same scaling with edge replication, so both
sides of the seam carry the same colour; a wide feather hides the grain.
--wm inpaints a watermark box (source px) first."""
import sys
import cv2
import numpy as np

src, out, scale = sys.argv[1], sys.argv[2], float(sys.argv[3])
img = cv2.imread(src)
H, W = img.shape[:2]
if '--wm' in sys.argv:
    x0, y0, x1, y1 = map(int, sys.argv[sys.argv.index('--wm') + 1].split(','))
    mask = np.zeros((H, W), np.uint8)
    mask[y0:y1, x0:x1] = 255
    img = cv2.inpaint(img, mask, 9, cv2.INPAINT_TELEA)
    cv2.imwrite(out.replace('.png', '-clean.png'), img)

# Smooth backdrop field without her.
hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
fg = ((hsv[..., 2] > 70) | ((hsv[..., 1] > 120) & (hsv[..., 0] < 40) & (hsv[..., 2] > 40))).astype(np.uint8) * 255
fg = cv2.dilate(fg, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (61, 61)))
k = 8
low = cv2.resize(img, (W // k, H // k), interpolation=cv2.INTER_AREA)
low_mask = cv2.resize(fg, (W // k, H // k), interpolation=cv2.INTER_NEAREST)
field = cv2.inpaint(low, low_mask, 15, cv2.INPAINT_TELEA)
field = cv2.GaussianBlur(field, (0, 0), 6)

w, h = round(W * scale), round(H * scale)
x, y = (W - w) // 2, H - h
# Canvas pixel -> plate pixel through the same scaling, then into the field.
u, v = np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32))
map_x = ((u - x) / scale) / k
map_y = ((v - y) / scale) / k
canvas = cv2.remap(field, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE).astype(np.float32)

small = cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA).astype(np.float32)
feather = 140
alpha = np.ones((h, w), np.float32)
ramp = (1 - np.cos(np.linspace(0, np.pi, feather, dtype=np.float32))) / 2
alpha[:feather, :] *= ramp[:, None]
alpha[:, :feather] *= ramp[None, :]
alpha[:, -feather:] *= ramp[::-1][None, :]
a = alpha[..., None]
canvas[y:y + h, x:x + w] = small * a + canvas[y:y + h, x:x + w] * (1 - a)
cv2.imwrite(out, np.clip(canvas, 0, 255).astype(np.uint8))
print(f'{out}: her {w}x{h} at ({x},{y}) in {W}x{H}')
