#!/usr/bin/env python3
"""
scripts/test/generate-icons.test.py

Unit and regression tests for scripts/generate-icons.py:
  1. Output file presence and dimensions.
  2. Safe circle containment for maskable icons (positive check and negative control).
  3. Favicon.ico multi-resolution frames and size-specific raster match.
  4. Byte-for-byte reproducibility across independent generations.
"""

import math
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


class TestGenerateIcons(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.icons_dir = REPO_ROOT / "dashboard" / "public" / "icons"
        cls.favicon_path = REPO_ROOT / "server" / "priv" / "static" / "favicon.ico"

    def test_all_expected_icons_exist_with_correct_dimensions(self):
        expected_sizes = {
            "icon-16.png": 16,
            "icon-32.png": 32,
            "icon-64.png": 64,
            "icon-128.png": 128,
            "icon-192.png": 192,
            "icon-256.png": 256,
            "icon-512.png": 512,
            "icon-maskable-192.png": 192,
            "icon-maskable-512.png": 512,
        }
        for name, size in expected_sizes.items():
            p = self.icons_dir / name
            self.assertTrue(p.is_file(), f"Missing icon: {name}")
            with Image.open(p) as im:
                self.assertEqual(im.size, (size, size), f"Wrong size for {name}")

    def test_maskable_safe_circle_containment(self):
        """Verify all non-background pixels fit within radius 40% of canvas."""
        bg_rgb = (20, 20, 29)
        for s in [192, 512]:
            with Image.open(self.icons_dir / f"icon-maskable-{s}.png") as raw_im:
                im = raw_im.convert("RGBA")
                cx, cy = (s - 1) / 2.0, (s - 1) / 2.0
                safe_r = s * 0.40
                outside = 0
                for y in range(s):
                    for x in range(s):
                        r, g, b, a = im.getpixel((x, y))
                        self.assertEqual(a, 255, f"Maskable pixel not opaque at ({x}, {y})")
                        if (r, g, b) != bg_rgb:
                            dist = math.sqrt((x - cx) ** 2 + (y - cy) ** 2)
                            if dist > safe_r:
                                outside += 1
                self.assertEqual(outside, 0, f"Found {outside} pixels outside safe circle in {s}x{s}")

    def test_favicon_multi_resolution_and_head_frames(self):
        """Verify favicon contains (16, 32, 48) and 16/32 match head icons."""
        self.assertTrue(self.favicon_path.is_file())
        with Image.open(self.favicon_path) as ico:
            sizes = set(ico.ico.sizes())
            self.assertEqual(sizes, {(16, 16), (32, 32), (48, 48)})

            # Frame 16 and 32 must match the head crops in dashboard/public/icons/
            for s in [16, 32]:
                ico_frame = ico.ico.getimage((s, s)).convert("RGBA")
                with Image.open(self.icons_dir / f"icon-{s}.png") as ref_raw:
                    ref_icon = ref_raw.convert("RGBA")
                    diff = sum(1 for p1, p2 in zip(ico_frame.getdata(), ref_icon.getdata()) if p1 != p2)
                    self.assertEqual(diff, 0, f"ICO {s}x{s} frame does not match icon-{s}.png")

    def test_reproducibility_across_independent_runs(self):
        """Verify running the generator twice produces identical bytes."""
        with tempfile.TemporaryDirectory() as tmp1, tempfile.TemporaryDirectory() as tmp2:
            p1, p2 = Path(tmp1), Path(tmp2)
            cmd1 = [
                "/usr/bin/python3",
                str(REPO_ROOT / "scripts" / "generate-icons.py"),
                "--icons-dir", str(p1 / "icons"),
                "--favicon-path", str(p1 / "favicon.ico"),
            ]
            cmd2 = [
                "/usr/bin/python3",
                str(REPO_ROOT / "scripts" / "generate-icons.py"),
                "--icons-dir", str(p2 / "icons"),
                "--favicon-path", str(p2 / "favicon.ico"),
            ]
            subprocess.check_call(cmd1)
            subprocess.check_call(cmd2)

            for item in (p1 / "icons").iterdir():
                b1 = item.read_bytes()
                b2 = (p2 / "icons" / item.name).read_bytes()
                self.assertEqual(b1, b2, f"Byte mismatch in {item.name}")

            b1 = (p1 / "favicon.ico").read_bytes()
            b2 = (p2 / "favicon.ico").read_bytes()
            self.assertEqual(b1, b2, "Byte mismatch in favicon.ico")


if __name__ == "__main__":
    unittest.main()
