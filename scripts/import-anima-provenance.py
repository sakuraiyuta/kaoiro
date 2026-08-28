#!/usr/bin/env python3
"""Import sanitized Anima provenance after content-bound state verification."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

try:
    from PIL import Image, ImageChops, ImageFilter, ImageStat
except ImportError as error:
    raise SystemExit(
        "error: Pillow is required; install it with `python3 -m pip install Pillow`"
    ) from error


REQUIRED_STATES = (
    "idle",
    "thinking",
    "tool_running",
    "waiting_input",
    "waiting_permission",
    "done",
    "error",
)
ALLOW_FIELDS = (
    "mode",
    "prompt",
    "negative",
    "model",
    "architecture",
    "seed",
    "steps",
    "width",
    "height",
    "cfg",
    "denoise",
    "generated_at",
    "job_id",
    "source_job_id",
    "tool",
    "source_refs",
    "postprocess",
    "sha256",
)
SILENT_DENY_FIELDS = {"account", "image_url"}
EROSION_RADIUS = 3
MAX_CORRECT_MAE = 0.05
MIN_WRONG_PAIR_MAE = 1.0
MIN_WRONG_PAIR_MARGIN = 1000.0


class VerificationError(RuntimeError):
    """Raised when the source-to-sprite mapping is not uniquely verified."""


@dataclass(frozen=True)
class Match:
    state: str
    source: Path
    anima_png: Path
    anima_json: Path
    mae: float
    exact_ratio: float


def repository_root() -> Path:
    return Path(__file__).resolve().parent.parent


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def png_files(directory: Path) -> list[Path]:
    if not directory.is_dir():
        raise VerificationError(f"directory is not accessible: {directory}")
    return sorted(path for path in directory.iterdir() if path.is_file() and path.suffix == ".png")


def source_directory(persona_id: str, requested: str | None) -> Path:
    if requested is not None:
        return Path(requested).resolve()

    root = repository_root()
    candidates = (
        root / "assets-work" / f"{persona_id}-provenance-source",
        root / "assets-work" / persona_id,
        root / "assets-work" / "dist" / persona_id / "raw",
    )
    available = [candidate for candidate in candidates if candidate.is_dir()]
    if len(available) != 1:
        formatted = ", ".join(str(candidate) for candidate in candidates)
        raise VerificationError(
            "source directory is ambiguous or missing; pass --source-dir explicitly "
            f"(checked: {formatted})"
        )
    return available[0]


def pack_directory(persona_id: str, requested: str | None) -> Path:
    return Path(requested).resolve() if requested else repository_root() / "persona-packs" / persona_id


def load_rgba(path: Path) -> Image.Image:
    with Image.open(path) as image:
        return image.convert("RGBA")


def interior_mask(final_sprite: Image.Image) -> Image.Image:
    alpha = final_sprite.getchannel("A")
    exact_alpha = alpha.point(lambda value: 255 if value == 255 else 0)
    mask = exact_alpha.filter(ImageFilter.MinFilter(EROSION_RADIUS * 2 + 1))
    if mask.getbbox() is None:
        raise VerificationError("sprite has no opaque interior after 3px erosion")
    return mask


def rgb_score(source: Path, final_sprite: Path) -> tuple[float, float, int]:
    final_rgba = load_rgba(final_sprite)
    mask = interior_mask(final_rgba)
    source_rgb = load_rgba(source).convert("RGB").resize(
        final_rgba.size, Image.Resampling.LANCZOS
    )
    final_rgb = final_rgba.convert("RGB")
    difference = ImageChops.difference(source_rgb, final_rgb)
    mae = sum(ImageStat.Stat(difference, mask=mask).mean) / 3

    exact = 0
    mask_pixels = 0
    for mask_value, difference_pixel in zip(mask.getdata(), difference.getdata(), strict=True):
        if mask_value:
            mask_pixels += 1
            if difference_pixel == (0, 0, 0):
                exact += 1
    return mae, exact / mask_pixels, mask_pixels


def unique_minimum(values: dict[Path, float], label: str) -> tuple[Path, float]:
    minimum = min(values.values())
    winners = [path for path, value in values.items() if value == minimum]
    if len(winners) != 1:
        candidates = ", ".join(path.name for path in winners)
        raise VerificationError(f"RGB mapping for {label} is not unique: {candidates}")
    return winners[0], minimum


def verify_rgb_invariant(source_dir: Path, pack_dir: Path) -> dict[str, tuple[Path, float, float]]:
    sources = png_files(source_dir)
    if len(sources) != len(REQUIRED_STATES):
        raise VerificationError(
            f"RGB invariant requires exactly {len(REQUIRED_STATES)} source PNGs, found {len(sources)}"
        )

    finals = {state: pack_dir / "sprites" / f"{state}.png" for state in REQUIRED_STATES}
    missing = [str(path) for path in finals.values() if not path.is_file()]
    if missing:
        raise VerificationError(f"missing final sprite(s): {', '.join(missing)}")

    scores: dict[str, dict[Path, tuple[float, float]]] = {}
    for state, final_sprite in finals.items():
        state_scores: dict[Path, tuple[float, float]] = {}
        for source in sources:
            mae, exact_ratio, _mask_pixels = rgb_score(source, final_sprite)
            state_scores[source] = (mae, exact_ratio)
        scores[state] = state_scores

    assignments: dict[str, tuple[Path, float, float]] = {}
    assigned_sources: set[Path] = set()
    for state, state_scores in scores.items():
        mae_by_source = {source: score[0] for source, score in state_scores.items()}
        source, correct_mae = unique_minimum(mae_by_source, state)
        if correct_mae > MAX_CORRECT_MAE:
            raise VerificationError(
                f"RGB mapping for {state} exceeds correct-pair MAE limit: {correct_mae:.6f}"
            )
        wrong_maes = [mae for candidate, mae in mae_by_source.items() if candidate != source]
        weakest_wrong_mae = min(wrong_maes)
        required_wrong_mae = max(
            MIN_WRONG_PAIR_MAE, correct_mae * MIN_WRONG_PAIR_MARGIN
        )
        if weakest_wrong_mae < required_wrong_mae:
            raise VerificationError(
                f"RGB mapping for {state} has insufficient wrong-pair separation: "
                f"correct={correct_mae:.6f}, wrong={weakest_wrong_mae:.6f}, "
                f"required>={required_wrong_mae:.6f}"
            )
        assignments[state] = (source, correct_mae, state_scores[source][1])
        assigned_sources.add(source)

    if len(assigned_sources) != len(REQUIRED_STATES):
        raise VerificationError("RGB mapping is not bijective across all seven states")
    return assignments


def source_paths_for_sha(source_dir: Path) -> dict[str, Path]:
    paths = {state: source_dir / f"{state}.png" for state in REQUIRED_STATES}
    missing = [str(path) for path in paths.values() if not path.is_file()]
    if missing:
        raise VerificationError(f"missing source PNG(s): {', '.join(missing)}")
    return paths


def index_anima_pngs(anima_dir: Path) -> dict[str, list[Path]]:
    indexed: dict[str, list[Path]] = {}
    for path in png_files(anima_dir):
        indexed.setdefault(sha256(path), []).append(path)
    if not indexed:
        raise VerificationError(f"no PNG files under Anima directory: {anima_dir}")
    return indexed


def anima_match(source: Path, indexed_anima: dict[str, list[Path]]) -> tuple[Path, Path]:
    matching = indexed_anima.get(sha256(source), [])
    if len(matching) != 1:
        qualifier = "no" if not matching else "multiple"
        raise VerificationError(
            f"{qualifier} Anima byte-identical match(es) for source {source}"
        )
    anima_png = matching[0]
    anima_json = anima_png.with_suffix(".json")
    if not anima_json.is_file():
        raise VerificationError(f"matched Anima PNG has no sibling JSON: {anima_png}")
    return anima_png, anima_json


def load_sanitized_provenance(path: Path) -> dict[str, object]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise VerificationError(f"invalid JSON: {path}: {error.msg}") from error
    if not isinstance(payload, dict):
        raise VerificationError(f"Anima JSON must be an object: {path}")
    job_id = payload.get("job_id")
    if not isinstance(job_id, str) or not job_id:
        raise VerificationError(f"Anima JSON has no usable job_id: {path}")

    for field in payload:
        if field not in ALLOW_FIELDS and field not in SILENT_DENY_FIELDS:
            print(f"warn: unknown field '{field}' in {path}, dropped", file=sys.stderr)
    return {field: payload[field] for field in ALLOW_FIELDS if field in payload}


def verified_matches(
    source_dir: Path, anima_dir: Path, pack_dir: Path, match_mode: str
) -> list[Match]:
    indexed_anima = index_anima_pngs(anima_dir)
    matches: list[Match] = []

    if match_mode == "sha256":
        for state, source in source_paths_for_sha(source_dir).items():
            anima_png, anima_json = anima_match(source, indexed_anima)
            matches.append(Match(state, source, anima_png, anima_json, 0.0, 1.0))
        return matches

    for state, (source, mae, exact_ratio) in verify_rgb_invariant(source_dir, pack_dir).items():
        anima_png, anima_json = anima_match(source, indexed_anima)
        matches.append(Match(state, source, anima_png, anima_json, mae, exact_ratio))
    return matches


def write_provenance(output_dir: Path, payloads: Iterable[tuple[str, dict[str, object]]]) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    for state, payload in payloads:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=output_dir, prefix=f".{state}.", delete=False
        ) as temporary:
            json.dump(payload, temporary, ensure_ascii=False, indent=2)
            temporary.write("\n")
            temporary_path = Path(temporary.name)
        os.replace(temporary_path, output_dir / f"{state}.json")


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Import sanitized Anima provenance after content-bound state verification."
    )
    parser.add_argument("id", help="persona id")
    parser.add_argument(
        "--anima-dir", required=True, help="directory containing Anima PNG and sibling JSON files"
    )
    parser.add_argument(
        "--source-dir", help="directory containing pre-rembg source PNG files"
    )
    parser.add_argument("--pack-dir", help="persona-pack root (defaults to persona-packs/<id>)")
    parser.add_argument(
        "--match-mode",
        choices=("sha256", "rgb-invariant"),
        default="sha256",
        help="state-mapping verifier (default: sha256)",
    )
    parser.add_argument(
        "--verify-only", action="store_true", help="verify and report mappings without writing JSON"
    )
    return parser.parse_args()


def main() -> int:
    arguments = parse_arguments()
    try:
        source_dir = source_directory(arguments.id, arguments.source_dir)
        anima_dir = Path(arguments.anima_dir).resolve()
        pack_dir = pack_directory(arguments.id, arguments.pack_dir)
        matches = verified_matches(source_dir, anima_dir, pack_dir, arguments.match_mode)
        payloads = [(match.state, load_sanitized_provenance(match.anima_json)) for match in matches]
        if not arguments.verify_only:
            write_provenance(pack_dir / "provenance", payloads)
        for match in matches:
            if arguments.match_mode == "rgb-invariant":
                print(
                    f"verified {match.state}: job_id={json.loads(match.anima_json.read_text(encoding='utf-8'))['job_id']} "
                    f"mae={match.mae:.6f} exact_rgb={match.exact_ratio:.4%}"
                )
            else:
                print(
                    f"verified {match.state}: job_id={json.loads(match.anima_json.read_text(encoding='utf-8'))['job_id']} "
                    "sha256=byte-identical"
                )
        return 0
    except VerificationError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
