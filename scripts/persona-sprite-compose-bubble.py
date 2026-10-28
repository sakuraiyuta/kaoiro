# Restore the speech bubble that birefnet-portrait drops (anzu waiting_permission, 2026-10-28, hisui).
# usage: python3 compose_bubble.py <raw.png> <cut.png> <out.png> x0 y0 x1 y1
# Inside the box, pixels that differ from the white background are the bubble's ink;
# the region they enclose is filled. Alpha 255 on the filled region, ink coverage on a 2 px rim.
import sys
import numpy as np
from PIL import Image
from scipy import ndimage

raw = np.array(Image.open(sys.argv[1]).convert('RGB')).astype(np.float64)
cut = np.array(Image.open(sys.argv[2]).convert('RGBA')).astype(np.float64)
x0, y0, x1, y1 = (int(v) for v in sys.argv[4:8])
box = np.zeros(raw.shape[:2], bool)
box[y0:y1 + 1, x0:x1 + 1] = True
dist = np.abs(raw - 254).max(-1)
ink = (dist > 40) & box
filled = ndimage.binary_fill_holes(ink)
rim = ndimage.binary_dilation(filled, iterations=2) & ~filled & box
alpha = np.zeros(raw.shape[:2])
alpha[filled] = 255
alpha[rim] = np.clip(dist[rim] / 40 * 255, 0, 255)
take = alpha > cut[..., 3]
cut[..., :3][take] = raw[take]
cut[..., 3][take] = alpha[take]
Image.fromarray(cut.round().clip(0, 255).astype('uint8'), 'RGBA').save(sys.argv[3])
