# Codex 0.161.0 compatibility evidence — 2026-10-08

Issue: [539](https://github.com/sakuraiyuta/kaoiro/issues/539).
The implementation base is `6234bd5e258bb6d7e57aba42767d9ef7bcd02da0`, after
Haiku 5.5 integration. The [JSON record](pin-0.161.0-adoption-gates-2026-10-08.json)
contains measured identities, schema deltas, fixture provenance and limits.
Historical 0.160.0 records and fixtures remain intact.

## Package and reader identity

Both exact npm pins are 0.161.0. The [upstream release](https://github.com/openai/codex/releases/tag/rust-v0.161.0)
and verified npm tarballs are the primary release sources. The installed
linux-x64 native reports `codex-cli 0.161.0` and SHA-256
`9a820c17865fa825d04db416818679a9d63bd72e50835c396f496e5684626c9c`.
The SDK and app-server resolve to the same real native path.

The unchanged SDK patch is re-keyed and renamed to 0.161.0. Its SHA-256 is
`faafbd6188ec0466bd5d3dfd02ed642304b5e09be1986b58533577b8456dbd0c`;
the actual patched SDK `dist/index.js` is
`2597aa3b22fa8a1d7cbd4fa313a0f6a3cba006654f372458daf84aca501749da`.
Upstream still uses readline. The research's actual SDK probe passes patched
on Node 22.23.3 and 24.3.0; unpatched, it passes on Node 22 and fails on
Node 24 with literal U+2028/U+2029 in a JSONL command-output event. Node 22's
unpatched success therefore cannot justify removing the patch.

## Native approval capture and production composition

The candidate capture uses a fresh isolated home, local Responses provider,
`workspace-write`, `on-request`, and an explicit escalation request to touch
an owned scratch file outside the workspace. The captured request has
`availableDecisions` without `decline`, but replying with `decline` yields
`serverRequest/resolved`, a declined command item and a completed turn;
the outside file remains absent. Only the owned scratch prefix is normalized.

The new fixture is
`wrapper/codex/test/fixtures/app_server_approval_decline_0.161.0.jsonl`
(SHA-256 `24807e4636c589683eb4e7981903044202f5bf05b14b2d759d7d5f016caaa879`).
Its sibling metadata records native SHA/version, initialization response and
fixture hash. The regression checks the candidate pin and rejects stale
0.160.0 metadata; changing a version label is not a new native capture.
The request shape is exercised through the existing approval runtime test.

`cli_sdk_native.integration.test.ts` calls `runCodexCli()` with no dependency
injection. Real config/argument parsing, ServerLink, Host, SDK and transport
factories run through both backends, with exec selected by its production
default. Only Phoenix and the Responses provider are external fixtures. A
real native command emits U+2028/U+2029; the next provider request must contain
that output and the wrapper must report the unique successful result. Homes
are isolated and deleted; no credentials or active CODEX_HOME are copied.
Existing native integration suites separately cover permission/network
settings, steer, interrupt, resume/history and default-effort resolution.

## Schema and model results

Fresh installed-native JSON schema exports match every research file hash:
stable 315 files and experimental 445 files. The primary tarball/native
comparison against 0.160.0 gives:

| Export | Old → candidate | Added | Changed | Removed |
|---|---|---|---|---|
| TypeScript stable | 734 → 737 | 3 | 9 | 0 |
| TypeScript experimental | 875 → 882 | 7 | 11 | 0 |
| JSON stable | 314 → 315 | 1 | 25 | 0 |
| JSON experimental | 440 → 445 | 5 | 28 | 0 |

Changes include prediction notification/types, optional goal mutation origin,
optional MCP OAuth login ID, broader CodexErrorInfo forms and Cyber descriptions;
experimental exports additionally expose prediction requests and Bedrock
GovCloud checks. SDK types add an optional Cyber program option, with no
required option or usage/event change. These additions do not establish a
wrapper defect. No speculative runtime API or selector is introduced.

Fresh unauthenticated candidate introspection reproduces all 11 model rows
from the 0.160.0 research, including hidden rows. The default model is
GPT-6.1 Sol, its declared default effort is `low`, and a thread started without
explicit model/effort resolves to GPT-6.1 Sol with `reasoningEffort: null`.
This introspection enables the experimental API; the production-composition
tests retain production capabilities. The tagged
[models.json](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/models-manager/models.json)
is byte-identical to 0.160.0, SHA-256
`fd219bd9f061278275f528939f82f54d2eb97df4b25c23b022adbe48813d920b`.
The catalog rows, order, plan policy, effort and minimum versions are unchanged.

## State adoption and limits

Migration source files are unchanged: state 58, thread history 7, and goals,
logs, memory and queue 2 each. The six inspected plugin/connector/pet
classification source files are also byte-identical. This is source evidence;
upstream SQLite quick-check/recovery behavior changed, and corrupt-database
recovery was not measured. No home-classification guess or backup/restore
policy change is introduced. The existing private snapshot and rollback gates
remain necessary for later operator adoption.

Signed-in server defaults, live entitlement, provider-specific effort semantics,
Cyber authorization, credentialed context-meter qualification and corrupt-state
recovery remain unverified. Production acceptance belongs to the operator's
later runner adoption, outside this change. No production server, runner or
live `~/.codex` was accessed.

The approved research SHA-256 is
`ece674ef17193b966a52562f793eb8a8b569af450f8a64626d3c34c878473fb9`.
Implementation mutation and final gate results are recorded after the checkpoint
commit, and final native evidence must be retaken after the last code change.

## Committed mutation controls

Both controls were measured after checkpoint commit
`eaf5db2c9ff0caa9ffa35394d98032bbc582e3c9`, with no runtime/catalog change.
Only the owned worktree SDK link or the owned test guard was changed;
shared pnpm-store files were never edited. Each was restored byte-for-byte.

| Control | Exit | Result | Restored result |
|---|---|---|---|
| Unpatched 0.161.0 SDK, Node 24.3.0 | 1 | Reader source check, synthetic SDK Unicode case and default exec CLI case fail; app-server passes (3 failed, 1 passed, 133 filtered skips) | Exit 0: 4 passed, 133 filtered skips |
| Remove capture-version guard only, Node 22.23.3 | 1 | Coherent metadata claiming the older pin is accepted; its expected-rejection test fails (1 failed, 8 passed) | Exit 0: 9 passed |

The initial negative metadata mixed version claims, so another check still
rejected it when the pin guard was removed. That control was insufficient
and is superseded by the internally consistent older-version input above.
The fresh schema comparer also rejects a copied manifest with one changed
file hash (exit 1), then passes restored stable/experimental manifests.

An initial full runner run on `88a403ae` exited 1 with 1046 passed and
2 failures in behaviour-relay-wiring.test.ts (a 5-second timeout and a missing
second warning). The unchanged file's focused repeat exited 0 with 8 passed;
the cause remains unverified. The saved initial log remains available for
review. Required final gates and native acceptance are repeated on the final
artifact; their report must include actual commands, exit codes, counts,
warnings and skipped checks, rather than treating this initial run as green.
