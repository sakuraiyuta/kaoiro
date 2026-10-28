# Postprocess for anzu sprites (issue 864): rembg cut -> 512x512 RGBA sprite.
# Pinned: Python 3.12, Pillow 10.2.0, numpy 1.26.4, scipy 1.11.4. scipy is used only
# by this script and persona-sprite-compose-bubble.py, not as a product dependency.
# Install in a disposable venv, as in docs/evidence/personas/2026-10-28-anzu-sprite-chain.md
# (Versions section).
# usage: python3 scripts/persona-sprite-postprocess.py <cut.png> <out.png>
# cut.png = output of: rembg i -m birefnet-portrait -a -af 240 -ab 10 -ae 10 raw.png cut.png
import sys
import numpy as np
from PIL import Image
from scipy import ndimage

im = np.array(Image.open(sys.argv[1]).convert('RGBA')).astype(np.float64)
a = im[..., 3]
far = ndimage.distance_transform_edt(a >= 30) >= 4
a[(a >= 200) & far] = 255
im[..., 3] = a
pm = im.copy()
pm[..., :3] *= pm[..., 3:4] / 255
ch = [Image.fromarray(pm[..., k].astype('uint8')).resize((512, 512), Image.LANCZOS)
      for k in range(4)]
r = np.stack([np.array(c).astype(np.float64) for c in ch], -1)
al = r[..., 3:4]
rgb = np.where(al > 0, r[..., :3] * 255 / np.maximum(al, 1), 0)
out = np.concatenate([rgb.clip(0, 255), al], -1).astype('uint8')
Image.fromarray(out, 'RGBA').save(sys.argv[2])
