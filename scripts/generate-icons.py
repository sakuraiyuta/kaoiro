#!/usr/bin/env python3
"""
scripts/generate-icons.py

Deterministically generates kaoiro's production icon assets and favicon from
persona-packs/kuroe/sprites/done.png using Pillow.

Outputs:
  - dashboard/public/icons/icon-16.png (16x16 head crop, thickened outline)
  - dashboard/public/icons/icon-32.png (32x32 head crop, thickened outline)
  - dashboard/public/icons/icon-64.png (64x64 full silhouette)
  - dashboard/public/icons/icon-128.png (128x128 full silhouette)
  - dashboard/public/icons/icon-192.png (192x192 full silhouette)
  - dashboard/public/icons/icon-256.png (256x256 full silhouette)
  - dashboard/public/icons/icon-512.png (512x512 full silhouette)
  - dashboard/public/icons/icon-maskable-192.png (192x192 maskable on #14141d)
  - dashboard/public/icons/icon-maskable-512.png (512x512 maskable on #14141d)
  - server/priv/static/favicon.ico (multi-size ICO: 16 head, 32 head, 48 full)

Manual Browser Acceptance Procedure (issue #196):
  1. Build dashboard assets:
       corepack pnpm@10.20.0 -C dashboard build
  2. Start local Phoenix development server:
       (cd server && mix phx.server)
  3. Open http://localhost:4000/ in Google Chrome / Chromium.
  4. Open DevTools (F12) -> Application tab -> Manifest pane.
  5. Verify that:
     - No manifest errors or warnings are shown.
     - Identity (kaoiro), theme color (#14141d), and display (standalone) match.
     - All 4 declared icons (192, 512, maskable-192, maskable-512) load and preview cleanly.
"""

import argparse
import os
import sys
from pathlib import Path
from PIL import Image, ImageFilter

# Supported environment: /usr/bin/python3 (Python 3.12.3, Pillow 10.2.0, zlib 1.3)
EXPECTED_PILLOW_MAJOR = 10


def validate_environment() -> None:
    """Validate that the active Pillow installation matches the supported major version."""
    import PIL
    major = int(PIL.__version__.split(".")[0])
    if major != EXPECTED_PILLOW_MAJOR:
        raise RuntimeError(
            f"Unsupported Pillow version: {PIL.__version__}. "
            f"Expected major version {EXPECTED_PILLOW_MAJOR} (supported environment is Pillow 10.2.0)."
        )

# Pinned brand constants
ALPHA_THRESHOLD = 102  # 40% of 255
GRADIENT_TOP = (30, 42, 74)       # #1e2a4a
GRADIENT_BOTTOM = (154, 95, 224)  # #9a5fe0
OUTLINE_COLOR = (127, 212, 232)   # #7fd4e8
BACKGROUND_COLOR = (20, 20, 29)   # #14141d

# Geometric constants
MASKABLE_SCALE = 0.56             # Proven safe fit within 40% radius safe circle
HEAD_CROP_BOX = (80, 0, 432, 352) # 352x352 square around Kuroe's head


def build_master_silhouette(src_image: Image.Image) -> Image.Image:
    """Build the master 512x512 silhouette with gradient and outline."""
    w, h = src_image.size
    alpha = src_image.getchannel("A")
    mask = alpha.point(lambda a: 255 if a >= ALPHA_THRESHOLD else 0)

    # Dilation for outline at 512px: MaxFilter(7) gives radius 3
    dilated = mask.filter(ImageFilter.MaxFilter(7))

    # Vertical linear gradient
    grad = Image.new("RGBA", (w, h))
    for y in range(h):
        factor = y / (h - 1)
        r = round(GRADIENT_TOP[0] * (1 - factor) + GRADIENT_BOTTOM[0] * factor)
        g = round(GRADIENT_TOP[1] * (1 - factor) + GRADIENT_BOTTOM[1] * factor)
        b = round(GRADIENT_TOP[2] * (1 - factor) + GRADIENT_BOTTOM[2] * factor)
        for x in range(w):
            grad.putpixel((x, y), (r, g, b, 255))

    # Composite gradient silhouette
    sil = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    sil.paste(grad, (0, 0), mask)

    # Outline layer (cyan)
    outline_mask = Image.new("L", (w, h), 0)
    for y in range(h):
        for x in range(w):
            if dilated.getpixel((x, y)) > 0 and mask.getpixel((x, y)) == 0:
                outline_mask.putpixel((x, y), 255)

    cyan = Image.new("RGBA", (w, h), (*OUTLINE_COLOR, 255))
    outline = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    outline.paste(cyan, (0, 0), outline_mask)

    return Image.alpha_composite(outline, sil)


def build_head_icon(src_image: Image.Image, target_size: int, inner_size: int) -> Image.Image:
    """
    Build a simplified head icon (16x16 or 32x32) with a thickened outline
    applied at the target resolution so the contour survives downscaling.
    """
    head_crop = src_image.crop(HEAD_CROP_BOX)
    cw, ch = head_crop.size

    # Gradient for head region
    grad_head = Image.new("RGBA", (cw, ch))
    for y in range(ch):
        factor = y / 511.0  # Align gradient phase with master 512px height
        r = round(GRADIENT_TOP[0] * (1 - factor) + GRADIENT_BOTTOM[0] * factor)
        g = round(GRADIENT_TOP[1] * (1 - factor) + GRADIENT_BOTTOM[1] * factor)
        b = round(GRADIENT_TOP[2] * (1 - factor) + GRADIENT_BOTTOM[2] * factor)
        for x in range(cw):
            grad_head.putpixel((x, y), (r, g, b, 255))

    head_alpha = head_crop.getchannel("A").point(lambda a: 255 if a >= ALPHA_THRESHOLD else 0)
    head_sil = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    head_sil.paste(grad_head, (0, 0), head_alpha)

    # Scale head to inner_size with padding for outline
    head_resized = head_sil.resize((inner_size, inner_size), Image.Resampling.LANCZOS)
    pad = (target_size - inner_size) // 2

    canvas = Image.new("RGBA", (target_size, target_size), (0, 0, 0, 0))
    canvas.paste(head_resized, (pad, pad), head_resized)

    # Extract mask at target resolution and dilate by 1px (MaxFilter 3)
    alpha_target = canvas.getchannel("A").point(lambda a: 255 if a >= 64 else 0)
    dilated_target = alpha_target.filter(ImageFilter.MaxFilter(3))

    outline_mask = Image.new("L", (target_size, target_size), 0)
    for y in range(target_size):
        for x in range(target_size):
            if dilated_target.getpixel((x, y)) > 0 and alpha_target.getpixel((x, y)) == 0:
                outline_mask.putpixel((x, y), 255)

    cyan = Image.new("RGBA", (target_size, target_size), (*OUTLINE_COLOR, 255))
    outline = Image.new("RGBA", (target_size, target_size), (0, 0, 0, 0))
    outline.paste(cyan, (0, 0), outline_mask)

    return Image.alpha_composite(outline, canvas)


def build_maskable_icon(master_sil: Image.Image, size: int) -> Image.Image:
    """Build a PWA maskable icon padded onto #14141d with safe-circle scale."""
    scaled_w = round(size * MASKABLE_SCALE)
    scaled_h = round(size * MASKABLE_SCALE)
    fg = master_sil.resize((scaled_w, scaled_h), Image.Resampling.LANCZOS)

    bg = Image.new("RGBA", (size, size), (*BACKGROUND_COLOR, 255))
    ox = (size - scaled_w) // 2
    oy = (size - scaled_h) // 2
    bg.alpha_composite(fg, (ox, oy))
    return bg


def save_png(image: Image.Image, path: Path) -> None:
    """Save PNG with deterministic compression options."""
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", optimize=False, compress_level=9)


def generate_all(repo_root: Path, icons_dir: Path, favicon_path: Path) -> None:
    src_path = repo_root / "persona-packs" / "kuroe" / "sprites" / "done.png"
    if not src_path.is_file():
        raise FileNotFoundError(f"Source sprite not found: {src_path}")

    src_image = Image.open(src_path).convert("RGBA")
    master_sil = build_master_silhouette(src_image)

    # 1. Full silhouette icons
    for s in [512, 256, 192, 128, 64]:
        if s == 512:
            img = master_sil
        else:
            img = master_sil.resize((s, s), Image.Resampling.LANCZOS)
        save_png(img, icons_dir / f"icon-{s}.png")

    # 2. Simplified head icons (32x32 and 16x16)
    im32_head = build_head_icon(src_image, target_size=32, inner_size=28)
    save_png(im32_head, icons_dir / "icon-32.png")

    im16_head = build_head_icon(src_image, target_size=16, inner_size=14)
    save_png(im16_head, icons_dir / "icon-16.png")

    # 3. Maskable PWA icons
    for s in [512, 192]:
        maskable = build_maskable_icon(master_sil, s)
        save_png(maskable, icons_dir / f"icon-maskable-{s}.png")

    # 4. Multi-resolution favicon.ico
    # Base is 48x48 full silhouette, appended with separate 16x16 and 32x32 head frames
    im48_full = master_sil.resize((48, 48), Image.Resampling.LANCZOS)
    favicon_path.parent.mkdir(parents=True, exist_ok=True)
    im48_full.save(
        favicon_path,
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48)],
        append_images=[im16_head, im32_head],
    )


def main():
    validate_environment()
    parser = argparse.ArgumentParser(description="Generate kaoiro icons and favicon deterministically.")
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--icons-dir", type=Path, default=None)
    parser.add_argument("--favicon-path", type=Path, default=None)
    args = parser.parse_args()

    repo_root = args.repo_root.resolve()
    icons_dir = args.icons_dir.resolve() if args.icons_dir else repo_root / "dashboard" / "public" / "icons"
    favicon_path = args.favicon_path.resolve() if args.favicon_path else repo_root / "server" / "priv" / "static" / "favicon.ico"

    print(f"Generating icons from {repo_root}...")
    generate_all(repo_root, icons_dir, favicon_path)
    print("All icons and favicon generated successfully.")


if __name__ == "__main__":
    main()
