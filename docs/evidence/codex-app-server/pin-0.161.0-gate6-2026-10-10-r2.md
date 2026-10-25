# Codex 0.161.0 Gate 6 — 2026-10-10 (r2)

Status: measurement complete; independent review pending. This record is not retirement approval and does not set `gate6: true` by itself.

This is a new r2 artifact. The r1 files remain unchanged: [r1 markdown](pin-0.161.0-gate6-2026-10-10.md), SHA-256 `199353939eb78e2e33bf1e9c7a96d458a88cdaa26ca156340154df0abea51a6a`; [r1 JSON](pin-0.161.0-gate6-2026-10-10.json), SHA-256 `60050a4d15db3a747583ee97b567ab9538cfb528708c1b9617eaa604081f60bf`. This r2 responds to Chloe's review [gate6-0.161.0-review-kuroe.md](../gate6-0.161.0-review-kuroe.md), SHA-256 `88f157f0558b1c6b376c8de776bef25b58294dc9cd1d0022da46facdcddd9778` (must 2 / should 1 / nit 1).

## Target and source binding

The target is release `e82033393c5f99e586b7f7967f8780ccfc1a3d8e`, version `2026.10.10.1`, branch `develop`; its source revision is the same commit. `codex --version` returned `codex-cli 0.161.0` (exit 0). The candidate native binary SHA-256 is `9a820c17865fa825d04db416818679a9d63bd72e50835c396f496e5684626c9c`.

The release manifest SHA-256 is `7e8942f42cfb7cc112172f30cbe73828cc1279c555a0f6afc010189104ac5b41`; `dist/build-info.json` SHA-256 is `27ee983c44866324faaded28cb38d2812f1ee847cde3acb7292c47b13387e7c4`. Strict `verify-release.mjs <release> --require-deploy-manifest --hash` returned `e82033393c5f99e586b7f7967f8780ccfc1a3d8e` (exit 0).

The deployed helper files still match the target source commit:

| File | SHA-256 |
| --- | --- |
| `runner/deploy/kaoiro-runner-codex-state.mjs` | `f34d86cb16d98f800886f7c53e6619175592682b2f1760d5c88acb9c15df79be` |
| `runner/deploy/codex-snapshot.mjs` | `bf0d4d5a5af15b34f61400e3c0fdcd62db0b348c70a86f495932d3f3d7385cb9` |
| `runner/deploy/codex-service.mjs` | `e2022f6f440f69aa4615101b0b2e7352aaa5afeeac7861baa26311691471976f` |
| `runner/deploy/codex-native.mjs` | `e811d9172786195e8d6f3817b2735839384d28e9cfefe4dec111a2ef024eb672` |
| `runner/deploy/verify-release.mjs` | `9e9ff68f7577ca31122dbab1e8d9e1cd0ff3be598bb27a6c19d21eaf33165058` |

## Isolation and method

All measured state was under `<scratch>`, with disposable `HOME`, `CODEX_HOME`, `XDG_CONFIG_HOME`, `TMPDIR`, project, and install root. The release was copied into the scratch install root with hard-linked files; the candidate files were only read. The final app-server ran with the scratch project as cwd and an `env -i` environment. No real credential, API key, remote model, or operator login was used.

The local Responses provider listened on `127.0.0.1`. The target release's `AppServerRpc` started native 0.161.0 app-server processes. It observed seven requests: four `GET /v1/models?client_version=0.161.0` requests and three `POST /v1/responses` requests, one per completed turn. Every peer address was `127.0.0.1`; no Authorization header was present. The model calls were served entirely by this local deterministic fixture.

The state helper used a scratch-only fake inactive `systemctl` service. A forward transaction was seeded in scratch from the target helper's `staticBinding` and `nativeIdentity` results, so the deployed snapshot command could run without inspecting a live runner cgroup. The deployed `prepare-restore` command was then used successfully to create and validate the restore transaction (exit 0); the restore transaction itself was not hand-seeded. No real systemd unit, production runner, production `current` link, or production Codex state path was read or changed.

## Results

| Step | Observation | Exit |
| --- | --- | ---: |
| Candidate version and strict release verification | `codex-cli 0.161.0`; release verifier returned `e82033393c5f99e586b7f7967f8780ccfc1a3d8e` | 0 / 0 |
| Original home | Wrote a 3-byte dummy `auth.json` containing `{}` plus newline; one local turn completed and the prompt/answer were readable. Codex created `state_5.sqlite` and a rollout file. | 0 |
| Snapshot | Deployed `kaoiro-runner-codex-state.mjs snapshot`; manifest SHA-256 `5505e24bdd9e813ad8f387df290a67d5ebe38dc625f8ecdfaa3e1f316a738e3a`; 94 state entries; `auth.json` absent from manifest and payload; `sameState` matched source state. | 0 |
| Divergence after snapshot | Resumed the same thread in a new app-server, completed a second local turn, and changed `model_reasoning_effort` from `low` to `high`. The divergent home hash differed from the snapshot. | 0 |
| `prepare-restore` | Called the deployed CLI against the scratch inactive service and original snapshot. It created restore transaction `617c07ac-dde7-4cb6-8457-43b8568b5e98`. | 0 |
| Restore | Deployed `restore` returned `state-restored`; `sameState` matched the manifest, the second turn and config edit were gone, and the original dummy auth bytes were present in the restored home with the same SHA-256. | 0 |
| History after restore | `thread/read` with `includeTurns=true` returned one turn: the first prompt and answer were readable; the second prompt and answer were absent. | 0 |
| Fresh home | Preserved the restored tree inside scratch, recreated `CODEX_HOME` at the same canonical scratch path, installed a trusted scratch `UserPromptSubmit` hook, and completed/read a local first turn in a distinct new thread. The hook marker was written. | 0 |

The dummy auth file's SHA-256 before snapshot and after restore was `ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356`. The snapshot manifest lists exclusions `auth.json`, `.credentials.json`, `secrets`, and `mcp-oauth-locks`.

Fresh-home hook evidence: the `hooks/list` result reported `trusted` for key `<scratch>/codex-home/config.toml:user_prompt_submit:0:0` and trusted hash `sha256:fa12feaa64ce69f5ff51ad9775212fa2f8121687892fcd9b80f4602c7e58a040`. The command wrote `FRESH_HOME_HOOK_RAN` to the scratch marker. The fresh thread ID `01a1264d-fdc9-7581-ae8b-81697739f960` differs from restored thread `01a1264d-df10-7133-8a8d-ee4edc0e065b`.

## Negative controls

Each refusal happened while the current home was divergent. The helper returned the listed refusal and the divergent home fingerprint, including dummy auth hash, stayed unchanged.

| Control | Refusal | Exit |
| --- | --- | ---: |
| Add a dummy `auth.json` only to the copied snapshot payload | `Snapshot contains excluded entries` | 78 |
| Modify `config.toml` only in the copied snapshot payload | `Snapshot payload mismatch` | 78 |
| Flip one byte in copied `state_5.sqlite` | `Snapshot payload mismatch` | 78 |

## Basis for the five retained snapshots

This run is bound to the home that remains on Codex 0.161.0. Retiring the five retained references gives up older recovery points; it does not move the active home back to an older binary. One reference, `f5221dc5`, supported the earlier migration to 0.160.0; it is an older recovery point too. A completed 0.161.0 Gate 6 run therefore tests the relevant candidate version for all five retirement decisions. This is the stated basis for review, not a claim that each historical binary was remeasured or an independent approval to retire the references.

## Discarded harness attempts

These attempts are not part of the result table. They used scratch state only and were reset before the final complete run:

- A fake-active service `prepare` attempt was refused with exit 78, `Active runner has no cgroup`. The final setup did not pretend a fake cgroup represented the live runner; it seeded only the forward record in scratch and exercised the real deployed `prepare-restore` and restore paths.
- An app-server launch preceded creation of its scratch project directory and did not complete `initialize`. The final run used an existing scratch cwd.
- A cross-process `turn/start` without first resuming the thread returned `thread not found`. The final run explicitly resumed the thread before the second turn.
- Harness assertions were corrected where they compared the snapshot-name UUID to the transaction UUID, and where they compared inode-sensitive inventory hashes instead of the helper's `sameState` predicate.
- One discarded initialize-only diagnostic inherited `<home>` as cwd, while all state environment variables remained scratch. It returned initialization/config-warning output only and ran no turn; it did not access `~/.local/share/kaoiro`. All measured app-server runs used the scratch project as cwd.

## Limits

- This does not measure `prepare()` against a real active runner, an actual systemd unit, or live cgroup membership. The deployed `prepare-restore` admission path did run, using a scratch inactive service and scratch-seeded forward transaction.
- It uses no real credentials or operator login. The operator's acceptance of snapshot/fresh-setup recovery, including fresh setup's login requirement, is separate from Gate 6 and must be recorded by Hisui.
- No remote model/provider call, old-version login, or opening of a database migrated by an older Codex binary was measured; these are outside the target Gate 6 definition.
- The deployed release `verifySnapshot` and restore path were tested against this credential-free candidate-generated home. Chloe decides whether this evidence supports `gate6: true` for all five references.

Definition sources were read at the target revision: `docs/plans/issue-468-codex-state-backup.md:646-651` (Gate 6) and `:323-327` (retirement), `docs/operations/runner-update-and-rollback.md:524-530` (Retirement), and `docs/operations/codex-home.md:254-259` (fresh setup).

The scratch tree was removed after the r2 markdown and JSON were checked: `<scratch>`.
