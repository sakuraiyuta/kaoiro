#!/usr/bin/env python3
"""Integration tests for the portable Anima provenance importer."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
IMPORTER = ROOT / "scripts" / "import-anima-provenance.sh"
STATES = (
    "idle",
    "thinking",
    "tool_running",
    "waiting_input",
    "waiting_permission",
    "done",
    "error",
)
COLORS = ((10, 20, 30), (40, 50, 60), (70, 80, 90), (100, 110, 120), (130, 140, 150), (160, 170, 180), (190, 200, 210))


class ImportAnimaProvenanceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source_dir = self.root / "source"
        self.anima_dir = self.root / "anima"
        self.pack_dir = self.root / "pack"
        self.source_dir.mkdir()
        self.anima_dir.mkdir()
        (self.pack_dir / "sprites").mkdir(parents=True)
        self._create_fixture()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _create_fixture(self) -> None:
        for index, (state, color) in enumerate(zip(STATES, COLORS, strict=True)):
            raw_path = self.source_dir / f"source-{index}.png"
            Image.new("RGB", (32, 32), color).save(raw_path)
            job_id = f"job-{index}"
            shutil.copyfile(raw_path, self.anima_dir / f"{job_id}.png")
            (self.anima_dir / f"{job_id}.json").write_text(
                json.dumps(
                    {
                        "mode": "txt2img",
                        "prompt": state,
                        "seed": index,
                        "job_id": job_id,
                        "account": "private@example.test",
                        "image_url": "https://example.test/signed",
                        "untrusted": "drop-me",
                    }
                ),
                encoding="utf-8",
            )
            Image.new("RGBA", (16, 16), (*color, 255)).save(
                self.pack_dir / "sprites" / f"{state}.png"
            )

    def invoke(
        self, *extra: str, source_dir: Path | None = None, match_mode: str = "rgb-invariant"
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                str(IMPORTER),
                "fixture",
                "--anima-dir",
                str(self.anima_dir),
                "--source-dir",
                str(source_dir or self.source_dir),
                "--pack-dir",
                str(self.pack_dir),
                "--match-mode",
                match_mode,
                *extra,
            ],
            check=False,
            capture_output=True,
            text=True,
        )

    def test_imports_sanitized_rgb_verified_mapping(self) -> None:
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("verified waiting_permission: job_id=job-4", result.stdout)
        self.assertNotIn("private@example.test", result.stderr)
        for index, state in enumerate(STATES):
            payload = json.loads((self.pack_dir / "provenance" / f"{state}.json").read_text())
            self.assertEqual(payload["job_id"], f"job-{index}")
            self.assertNotIn("account", payload)
            self.assertNotIn("image_url", payload)
            self.assertNotIn("untrusted", payload)

    def test_requires_explicit_anima_directory(self) -> None:
        result = subprocess.run(
            [str(IMPORTER), "fixture"], check=False, capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("--anima-dir", result.stderr)

    def test_rejects_7x7_mapping_without_wrong_pair_separation(self) -> None:
        Image.new("RGB", (32, 32), (10, 20, 31)).save(self.source_dir / "source-1.png")
        shutil.copyfile(self.source_dir / "source-1.png", self.anima_dir / "job-1.png")
        Image.new("RGBA", (16, 16), (10, 20, 31, 255)).save(
            self.pack_dir / "sprites" / "thinking.png"
        )
        result = self.invoke("--verify-only")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("insufficient wrong-pair separation", result.stderr)
        self.assertFalse((self.pack_dir / "provenance").exists())

    def test_imports_sha256_verified_mapping(self) -> None:
        sha_source_dir = self.root / "sha-source"
        sha_source_dir.mkdir()
        for index, state in enumerate(STATES):
            shutil.copyfile(self.source_dir / f"source-{index}.png", sha_source_dir / f"{state}.png")
        result = self.invoke(source_dir=sha_source_dir, match_mode="sha256")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("verified done: job_id=job-5 sha256=byte-identical", result.stdout)
        for index, state in enumerate(STATES):
            payload = json.loads((self.pack_dir / "provenance" / f"{state}.json").read_text())
            self.assertEqual(payload["job_id"], f"job-{index}")


if __name__ == "__main__":
    unittest.main()
