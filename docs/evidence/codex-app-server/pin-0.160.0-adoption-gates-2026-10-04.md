# Codex 0.160.0 adoption gates — 2026-10-04

Status: the gate without credentials (part A) is complete on implementation
commit `5b3456ad`. The credentialed part (context meter, model availability)
was not run: no authenticated candidate home exists on this host, the
production home is not used for gates, and the council (Hisui and Kohaku)
moved that acceptance to production. No production home, runner or server was
accessed. The companion [JSON record](pin-0.160.0-adoption-gates-2026-10-04.json)
binds the hashes. Issue: [517](https://github.com/sakuraiyuta/kaoiro/issues/517).

## Pin

At about 10:20 UTC npm listed **0.160.0** as the latest stable for both
`@openai/codex` and `@openai/codex-sdk` (only `0.162.0-alpha.*` was newer).
The linux-x64 native `codex-cli 0.160.0` has SHA-256
`12eb3e81114588aca3b7998f4f19e8997b056aca08e57a7ca7c8a3ec8c652aad`; the
0.159.3 native it replaces is `8bf204b3…` (equal to the
[0.159.3 record](pin-0.159.3-adoption-gates-2026-10-01.md)).

## Gate A

| Id | Check | Result | Negative control |
|---|---|---|---|
| A1 | Pin identity | npm latest stable 0.160.0 for CLI and SDK; native path and SHA-256 above, also returned by the release's `nativeIdentity` | — |
| A2 | App-server schema | `app-server generate-json-schema --out` and `--experimental`, fresh HOME and CODEX_HOME (left empty): stable 314 and experimental 440 files, **byte-identical** to 0.159.3; manifests `905003da…` and `03312a12…`. Our 0.159.3 run reproduces the 0.159.3 record's `ClientRequest.json` and `ServerNotification.json` hashes. | one changed byte in a copied manifest is reported |
| A3 | State migrations, source | `codex-rs/state/` `migrations` (58) and the `goals_`, `logs_`, `memory_`, `queue_`, `thread_history_` migration directories are identical at `rust-v0.159.3` and `rust-v0.160.0` (names and blob shas) | — |
| A3b | State migrations, applied | one local-provider turn per native in a fresh home: `state_5` 58, `thread_history_1` 7, `goals_1`, `logs_2`, `memories_1`, `queue_1` 2 each, **equal on both** | — |
| A4 | SDK stream patch | `@openai/codex-sdk` 0.160.0 `dist/index.js` is byte-identical to 0.159.3 and still splits with `readline`; the patch is re-keyed unchanged (SHA-256 `faafbd61…`). The U+2028 / U+2029 test passes patched on Node 22.23.3 and 24.3.0. Unpatched it **fails on Node 24.3.0 and passes on Node 22.23.3**: Node 22.23.3's `readline` does not split on U+2028 / U+2029 (2 lines from a 2-line input), Node 24.3.0's does (4 lines). The patch is load-bearing on Node 24. | the unpatched Node 24 run |
| A5 | CODEX_HOME classification | of the six upstream files cited by the [classification design](../../plans/issue-468-home-classification.md), five are identical at `rust-v0.160.0` and `core-plugins/src/store.rs` only adds an in-memory manifest cache. A fresh home on 0.160.0 creates no root name that 0.159.3 does not (0.159.3 additionally left `goals_1` and `memories_1` WAL sidecars). | — |
| A6 | Suites (Node 22.23.3) | see [Suites](#suites) | — |
| A7 | Pinned approval capture | remeasured on 0.160.0 through a local Responses provider: code-mode `exec` calling `exec_command` with an escalation request, `on-request` approval, `workspace-write`. Request, decline reply, `serverRequest/resolved`, declined item and completed turn keep the 0.159.3 shape (same request keys, same `availableDecisions`); the outside file is absent. Fixture `app_server_approval_decline_0.160.0.jsonl` (`859d1b78…`), scratch prefix normalised. The 0.159.3 capture came from a live model turn; this one does not need credentials. | with the pin bumped and the old capture, the suite's only failure is "is measured on the pinned version" |
| A8 | Steer on the native | new `app_server_steer.integration.test.ts` (`f8c3393e…`): steer after the command's `item/started`, and while the provider is still streaming; the steer's nonce reaches the provider's next request; the same turn completes. 2 of 2 pass. | with the `turn/steer` write removed and the response faked as accepted, both fail at the nonce assertion |
| A9 | Runner artifact | tarball `kaoiro-runner-5b3456ad…-linux-x64.tar.gz` (`939324b3…`, 164 manifest files) built from the clean tree; `verify-release.mjs --require-manifest --hash` (with `--experimental-vm-modules`) exit 0; `nativeIdentity` resolves the 0.160.0 native inside the release | — |
| A10 | Sandbox enforcement | local provider, code mode, approval `never`, `workspace-write`, scratch outside `/tmp` (which `workspace-write` makes writable): network off, `curl` to a loopback nonce endpoint exits 7 and the endpoint sees no request; network on, one request and exit 0; a write outside the workspace fails with "Read-only file system"; a write inside succeeds. **0.159.3 gives the same five results.** | each allowed variant against its denied pair |

## 0.159.3 gate items not repeated

| Item | Why |
|---|---|
| Runner guard/wiring mutation matrix | No runner wiring code changes; only versions, fixtures and tests. |
| Live steer, interrupt and approval turns | No candidate home; A7, A8 and the existing native interrupt and resume integrations cover the wire on a local provider. |
| Model availability (gate 5), context meter | Credentialed; production acceptance below. |
| Git multi-root commits | Same sandbox and approval paths as A7 and A10. The commit walk (56 commits, 446 files) found no Linux sandbox change; Git-specific code was not inspected. |
| Snapshot backup/restore round trip | The backup code is unchanged and A3/A3b show no state schema change; the real update takes the documented snapshot. |

## Suites

Node 22.23.3, implementation commit `5b3456ad`, each run under an external
`timeout`: wrapper build, wrapper typecheck and runner typecheck exit 0.
`wrapper/core` 455, `agent-common` 539, `claude-code` 794, `antigravity` 481
(2 live tests skipped without `KAOIRO_LIVE_AGY=1`), `codex` 1,354 in 90 files,
`runner` 1,025 in 52 files: every suite exit 0, no unhandled error.

## Production acceptance (replaces the credentialed part)

After the runner update (all peers idle; the update takes the Codex state
snapshot of `docs/operations/runner-update-and-rollback.md` 4.6.2): the first
turn of each production Codex model succeeds (gpt-6-luna, gpt-6.1-sol), the
Codex context report updates, and a Claude first turn and a resumed Claude
session succeed. Any authentication failure, model rejection, startup failure
or missing context report rolls back to the previous runner release (4.6.3).
Never create a candidate home by copying the production `auth.json`.

## Retention

The evaluator's scratch (gate driver, homes under a private cache directory,
the tarball) stays until review completes and is then deleted.
