#!/usr/bin/env python3
"""Verify the sprite chain of a persona pack, stage by stage (issue 864).

Chain per state: job record -> raw PNG -> cut (rembg) -> [bubble] -> sprite.
The sprite is reproduced byte for byte from the cut (or the bubble) and
compared with the shipped sprite. Every stage is compared with a recorded
sha256, so a swapped raw, job, cut, box or sprite fails at a named stage.

Usage:
  verify-persona-sprite-chain.py --materials DIR --pack DIR --expected FILE
      [--bubble-box X0 Y0 X1 Y1] [--rembg]

Materials layout: raw/<state>.png, cut/<state>.png, jobs/<state>.json.
Expected: the JSON record in docs/evidence/personas/.
The postprocess scripts are run with the same interpreter as this script.
Exit status is 1 when any stage fails.
"""

import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
STATES = ['idle', 'thinking', 'tool_running', 'waiting_input',
          'waiting_permission', 'done', 'error', 'fatigued']
BUBBLE_STATES = ['waiting_permission']
DEFAULT_BOX = (712, 224, 845, 354)


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run_script(name, args):
    subprocess.run([sys.executable, str(HERE / name), *map(str, args)],
                   check=True, capture_output=True)


def embedded_graph(raw):
    prompt = Image.open(raw).info.get('prompt')
    if prompt is None:
        return None
    return json.loads(prompt)


def check_job_raw(state, materials, pack):
    """Stage 2: job record and provenance agree with the raw PNG's graph."""
    errors = []
    prov = json.loads((pack / 'provenance' / f'{state}.json').read_text(encoding='utf-8'))
    job = json.loads((materials / 'jobs' / f'{state}.json').read_text(encoding='utf-8'))
    if job['job_id'] != prov['job_id']:
        errors.append(f"job_id {job['job_id']} != provenance {prov['job_id']}")
    if job['prompt'] != prov['prompt']:
        errors.append('job prompt != provenance prompt')
    graph = embedded_graph(materials / 'raw' / f'{state}.png')
    if graph is None:
        return [*errors, 'raw PNG has no embedded graph']
    texts, sampler, latent = [], None, None
    for node in graph.values():
        cls, inputs = node.get('class_type'), node.get('inputs', {})
        if cls == 'KSampler':
            sampler = inputs
        elif cls == 'EmptyLatentImage':
            latent = inputs
        elif cls == 'CLIPTextEncode':
            texts.append(inputs.get('text', ''))
    negative = [t for t in texts if t.startswith('worst quality')]
    positive = [t for t in texts if not t.startswith('worst quality')]
    if sampler is None or latent is None or len(positive) != 1 or len(negative) != 1:
        return [*errors, 'raw graph does not have one positive, one negative, a sampler and a latent']
    if positive[0] != prov['prompt']:
        errors.append('raw positive text != provenance prompt')
    if negative[0] != prov['negative']:
        errors.append('raw negative text != provenance negative')
    for key, want in (('seed', prov['seed']), ('steps', prov['steps']), ('cfg', prov['cfg']),
                      ('denoise', prov['denoise'])):
        if sampler.get(key) != want:
            errors.append(f'raw sampler {key} {sampler.get(key)} != provenance {want}')
    if (latent.get('width'), latent.get('height')) != (prov['width'], prov['height']):
        errors.append('raw latent size != provenance size')
    return errors


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--materials', required=True, type=Path)
    ap.add_argument('--pack', required=True, type=Path)
    ap.add_argument('--expected', required=True, type=Path)
    ap.add_argument('--bubble-box', nargs=4, type=int, default=list(DEFAULT_BOX))
    ap.add_argument('--rembg', action='store_true',
                    help='also regenerate each cut with the rembg CLI and compare')
    args = ap.parse_args()
    expected = json.loads(args.expected.read_text(encoding='utf-8'))
    failures = []
    with tempfile.TemporaryDirectory(prefix='persona-chain.') as tmp:
        tmp = Path(tmp)
        for state in STATES:
            want = expected['states'][state]
            raw = args.materials / 'raw' / f'{state}.png'
            cut = args.materials / 'cut' / f'{state}.png'
            sprite = args.pack / 'sprites' / f'{state}.png'
            stage_errors = []
            if sha256(raw) != want['raw_sha256']:
                stage_errors.append('raw sha256 differs from the record')
            stage_errors += check_job_raw(state, args.materials, args.pack)
            if sha256(cut) != want['cut_sha256']:
                stage_errors.append('cut sha256 differs from the record')
            if args.rembg:
                regen = tmp / f'{state}.regen.png'
                subprocess.run(['rembg', 'i', '-m', 'birefnet-portrait', '-a', '-af', '240',
                                '-ab', '10', '-ae', '10', str(raw), str(regen)],
                               check=True, capture_output=True)
                if sha256(regen) != sha256(cut):
                    stage_errors.append('regenerated cut differs from the saved cut')
            source = cut
            if state in BUBBLE_STATES:
                bubble = tmp / f'{state}.bubble.png'
                run_script('persona-sprite-compose-bubble.py',
                           [raw, cut, bubble, *args.bubble_box])
                if sha256(bubble) != want['bubble_sha256']:
                    stage_errors.append('bubble sha256 differs from the record')
                source = bubble
            rebuilt = tmp / f'{state}.sprite.png'
            run_script('persona-sprite-postprocess.py', [source, rebuilt])
            if sha256(rebuilt) != sha256(sprite):
                stage_errors.append('reproduced sprite is not byte-identical to the shipped sprite')
            if sha256(sprite) != want['sprite_sha256']:
                stage_errors.append('shipped sprite sha256 differs from the record')
            status = 'FAIL' if stage_errors else 'PASS'
            print(f'{state:20s} {status} sprite={sha256(sprite)[:16]}')
            for error in stage_errors:
                print(f'  - {error}')
                failures.append((state, error))
    print(f'{len(STATES) - len({s for s, _ in failures})}/{len(STATES)} states pass')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
