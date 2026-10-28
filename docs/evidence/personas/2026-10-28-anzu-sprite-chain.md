# anzu sprite chain record (2026-10-28)

Dated record for the `anzu` persona pack (issue [#864](https://github.com/sakuraiyuta/kaoiro/issues/864)).
It shows how each shipped sprite was produced, and how the chain from the job record to the
shipped sprite was checked stage by stage. The machine-readable expected values are in
[2026-10-28-anzu-sprite-chain.json](2026-10-28-anzu-sprite-chain.json).

## Chain

Each state is checked as: job record, then raw PNG, then cut (rembg), then (waiting_permission
only) bubble, then sprite.

1. **Job to raw.** The raw PNG's embedded ComfyUI graph must match the provenance: seed 152050386799615,
   steps 30, cfg 4.0, sampler `er_sde`, scheduler `simple`, denoise 1.0, 1024x1024, the positive text
   equal to the job prompt, and the negative text equal to the fixed negative list.
2. **Raw to cut.** `rembg i -m birefnet-portrait -a -af 240 -ab 10 -ae 10 raw.png cut.png` is run again,
   and the result must be byte-identical to the saved cut.
3. **Bubble (waiting_permission only).** `scripts/persona-sprite-compose-bubble.py <raw> <cut> <bubble>
   712 224 845 354` restores the speech bubble that rembg removes as background.
4. **Cut (or bubble) to sprite.** `scripts/persona-sprite-postprocess.py <input> <sprite>` must
   reproduce the shipped sprite byte for byte.

## Versions

| Stage | Environment |
|---|---|
| rembg (stage 2) | Python 3.12.3; rembg 2.0.85, onnxruntime 1.31.0, Pillow 12.3.0, numpy 2.4.6, pymatting 1.1.16 |
| model | `birefnet-portrait.onnx`, sha256 `1ba1c8ff5a7bbfadc8d8d13fb11d7be793f91f23d9d466549e37a854f6668f99` |
| postprocess and bubble (stages 3 and 4) | Python 3.12.3; Pillow 10.2.0, scipy 1.11.4, numpy 1.26.4 |

Setup, with a disposable environment for each row:

```sh
uv venv --python 3.12 <dir>
uv pip install --python <dir>/bin/python pillow==10.2.0 scipy==1.11.4 numpy==1.26.4
uv pip install --python <dir>/bin/python "rembg[cpu,cli]==2.0.85" onnxruntime==1.31.0 \
  pillow==12.3.0 numpy==2.4.6 pymatting==1.1.16
```

The rembg model is downloaded on first use. Its sha256 is checked as above.

## Check

```sh
<dir>/bin/python scripts/verify-persona-sprite-chain.py --materials <materials-dir> \
  --pack persona-packs/anzu --expected docs/evidence/personas/2026-10-28-anzu-sprite-chain.json --rembg
```

With `--rembg`, the rembg environment's `bin` directory must be first on `PATH`.
The materials directory (`raw/`, `cut/`, `jobs/`) is held by the operator outside this repository.
The script exits 1 when any stage fails, and names the failing stage for each state.

## Results

Checked with the expected values above, in the disposable Python 3.12 environment:

- Positive run, with `--rembg`: 8 of 8 states pass. Every regenerated cut is byte-identical to the saved cut.
- Negative controls A to E, each in a scratch copy, run without `--rembg`. Every control exits 1, and the failing stage is named:

| Control | Change | Stage that fails |
|---|---|---|
| A | two shipped sprites swapped (idle, done) | reproduced sprite and the shipped sprite hash, for both states |
| B | two cuts swapped (idle, done) | cut hash, and the reproduced sprite, for both states |
| C | raw and job record of done replaced by error's | raw hash, job id, job prompt, positive text (done) |
| D | bubble box with x0 = 760 (cuts through the bubble) | bubble hash and reproduced sprite (waiting_permission) |
| E | raw of waiting_permission replaced by idle's raw | raw hash, positive text, bubble hash, reproduced sprite (waiting_permission) |

- Regeneration-only control, with `--rembg` (full record: [2026-10-28-anzu-regen-negative-control.txt](2026-10-28-anzu-regen-negative-control.txt),
  sha256 `e15ae7d197b6a709f6313fc92ed786f91c18bd28ab5722fc8c3149f251f738c5`). The raw and job of done are
  replaced by error's, and the earlier checks are aligned to the swapped raw, so the job, prompt, and cut
  hashes all agree. Only `regenerated cut differs from the saved cut` fails for done (exit 1). The other seven
  states pass.

The raw-swap case for waiting_permission was also run by hand, directly with rembg rather than through the
checker: the regenerated cut of idle's raw does not match the saved cut of waiting_permission
(`f862455e…` against `9e42933b…`, first 16 hex characters).

## Bubble box

The speech bubble spans about x 717 to 840 and y 229 to 349 in the raw. The box 712 224 845 354 is
about 5 px wider on each side. A small shift of the box would leave the bubble inside it, so the
negative control uses x0 = 760, which cuts through the bubble. A small shift is not a negative control.

## Limits

- The bubble and postprocess scripts reproduce the shipped sprites exactly, with the versions above.
  The rembg regeneration is exact only with the versions and the model above. A different version
  is not guaranteed to match; the check then reports the difference.
- The provenance files are written by hand, because the importer requires PNG files named by
  job_id with a sibling JSON, and the generation records do not have that layout. Values come from
  the job record and from the PNG's embedded graph, as stated in the commit.
- The chain check ran in the disposable Python 3.12 environment on the implementer's host, not on the
  remote heavy-test runner. The runner's image did not provide Python with the pinned Pillow: an
  earlier run on a Python 3.13 image failed to install Pillow 10.2.0 (recorded in the design review).
  This check is a short, deterministic script with no network use, and it is run with the pinned
  versions above.
- `waiting_permission` was regenerated once. The speech bubble comes from stage 3, not from rembg alone.

## Server acceptance (M2)

Run through the remote heavy-test runner, on the commit named in the pull request. The bundled ZIP
`server/priv/persona-packs/anzu-1.0.0.zip` is read by the server's pack reader.

| Run | Change | Result |
|---|---|---|
| clean, eb798648 | none | 121 of 121 pass; `mix format --check-formatted` passes |
| clean, e62d3366 (anzu expectations pinned from the ZIP) | none | 121 of 121 pass; `mix format --check-formatted` passes |
| M3 mutation, on e62d3366 | `PersonaAssets.version_param/1` returns `000000000000` for every image; the change is made in a scratch copy and restored by a shell `trap` | 119 of 121; exit 2. The new anzu test fails at its URL assertion (`v=000000000000&auth=1` against `v=32d73f39f44f`). The existing `persona_assets_test` case "url とハッシュが content-addressed 形式に従う" also fails. This is not a claim that the whole suite is green or red for other reasons |
| (a) | `fatigued` removed from `manifest.states`, image kept in the ZIP | 14 of 15; the anzu states assertion fails (seven states, no fatigued) |
| (b) | `sprites/fatigued.png` removed from the ZIP, still declared | 13 of 15; the pack is rejected with `sprites/fatigued.png missing`; anzu is absent |

The build script alone (`scripts/build-persona-pack.sh`) does not check `fatigued`, so it passes
in both controls. The server acceptance test is what catches them.
