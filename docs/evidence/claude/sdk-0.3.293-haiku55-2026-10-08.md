---
title: Claude Agent SDK 0.3.293 Haiku 5.5 measurements
status: measured
last_updated: 2026-10-08
---

# Claude Agent SDK 0.3.293 Haiku 5.5 measurements

Target: [issue #535](https://github.com/sakuraiyuta/kaoiro/issues/535), runtime/test
commit `fece17735613b862b63f3ab45b25b663f467779e`, based on
`26584d74aca456c96311cfa922496171ce95b1ff`. Host: Linux x64, Node 24.3.0,
pnpm 10.20.0. The installed SDK is 0.3.293; its native executable reports
`2.1.293 (Claude Code)`.

## Artifacts and composition

The init-only catalog measurement used `runClaudeCli` → real `AgentHost`
startup probe → real `runProbe` → installed SDK. Observation wrappers forwarded
the SDK calls and stored `initializationResult().models` and
`supportedModels()`; both returned the same 13 rows, identical to the earlier
research capture. No prompt was yielded and no model generation was requested.
The account/endpoint was inherited for this catalog measurement.

The captured rows are in
[`claude-agent-sdk-0.3.293.models.json`](../../../wrapper/claude-code/test/fixtures/claude-agent-sdk-0.3.293.models.json),
SHA-256 `637abfa8a2467d3e39c5eb5284ae0fc52b0b1e02d733d80da956fbc7747f3642`.
Older fixtures remain unchanged. Compared with 0.3.289, the `haiku` row resolves
to `claude-haiku-5-5` and gains five effort levels, adaptive-thinking and auto-mode
metadata. A self-resolving `claude-haiku-4-5-20251001` row is added; other rows
are unchanged. Haiku 5.5 has no separate canonical row in this capture.

The regression measurement uses the real `runClaudeCli` and `AgentHost`, with
its default query factory and bundled native CLI. The link only captures
outgoing envelopes. Config/cwd/HOME are temporary; inherited account/provider
environment is cleared and the API key is a placeholder. A loopback HTTP server
answers Messages/count_tokens requests. It echoes the CLI's actual request model
and returns synthetic usage; it supplies no model catalog or context capacity.
Capacity is read through the SDK's real `getContextUsage()` control response.

[`sdk-0.3.293-haiku55-2026-10-08.json`](sdk-0.3.293-haiku55-2026-10-08.json)
contains the restored-run requests, context projections and effort outcomes;
SHA-256 `2cd86964c65c8e7bc48f156b1a975b8e7e77667c3790204e676bc78ad9edddf8`.
Content identities:

| Artifact | SHA-256 |
|---|---|
| `src/host.ts` | `81d7b0204e7ff517921984715f0656531252edc71c5087de5de9d57df5eb1cfd` |
| `test/haiku55_native.test.ts` | `b84b0fc5fab45feefef0b175a1bee1e99089eded5cb0e485637126c175b06c2e` |
| installed `sdk.mjs` | `a980b792353c301eea60d7896704cff21440de7c4aeefc3fe481be079504e203` |
| installed Linux x64 `claude` | `8968405e26db478af44eabc4635ab5ca557057b702a54460a59c13e1b253e978` |

## Native observations and negative controls

| Configured model / control | Outgoing canonical model | Native capacity | Host effort controls |
|---|---|---:|---|
| `haiku` | `claude-haiku-5-5` | 1000000 | All five accepted |
| `claude-haiku-5-5`, initial effort `high` | `claude-haiku-5-5` | 1000000 | All five accepted |
| `haiku`, disable1m | `claude-haiku-5-5` | 200000 | All five accepted |
| `claude-haiku-4-5-20251001` | Same old ID | 200000 | All five rejected locally |

The host retained each configured pin and its `config` source without a false
fallback. New Haiku requests used adaptive thinking, output limit 128000 and
initial effort `medium` (or configured `high`). Old Haiku used budget thinking,
output limit 32000, and rejected every effort with `effort_level_unsupported`.
The effort domain was `low`, `medium`, `high`, `xhigh`, `max`. Controls were
acknowledged by the actual CLI, without another model generation per level.

The native test is opt-in (`KAOIRO_LIVE_CLAUDE=1`): existing Claude real-process
tests substitute the executable rather than exercise the bundled Claude CLI.
The opt-in follows the existing Antigravity live-test arrangement. The ordinary
suite still covers captured catalog publication through the startup probe parser,
alias/canonical/legacy pin behavior and effort validation. GitHub Actions uses
Linux x64 and Node 22; this measurement used the host's Node 24.3.0.

A `strace -f -e trace=connect` native run reported 4 passed, exit 0, test time
6.65s and total Vitest duration 11.92s. All 64 IP connection attempts were to
`127.0.0.1`; no non-loopback IP connect was observed. The restored run reported
4 passed, exit 0, test time 2.79s and total duration 4.51s. Both emitted
`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`; neither emitted unhandled errors.

After committing the changes, the host's context projection was temporarily
mutated from `usage.maxTokens` to `200_000`. The native alias and canonical
1M tests both failed at the context assertion, exit 1 (2 failed / 2 skipped).
The failed tests were:

- `retains 'haiku' (disable1m=false, effort=undefined) and projects 1000000`
- `retains 'claude-haiku-5-5' (disable1m=false, effort='high') and projects 1000000`

`git checkout -- wrapper/claude-code/src/host.ts` restored the committed file;
its SHA-256 matched the value above. The complete native suite then returned
4 passed and exit 0. Disable1m and legacy-effort refusal remain native negative
controls. A captured-catalog test also rejects a fabricated canonical model.

Reproduce the native suite from `wrapper/claude-code`:

```sh
KAOIRO_LIVE_CLAUDE=1 env -u CODEX_HOME pnpm exec vitest run test/haiku55_native.test.ts
```

## Scope and limits

No model-specific runtime branch was added. PDF fitting retains the common
100-page / 22 MiB raw cap, including for the 200K legacy and disable1m cases.
The provider's 600-page allowance for 1M context was not generation-tested.

The loopback run establishes SDK/CLI request construction, control behavior and
host projection, not successful upstream generation, token accounting, pricing,
provider entitlement or auto-mode classifier behavior. Bedrock, Vertex and
Foundry were not measured. SDK 0.3.292 run_id / parent_task_id and canUseTool
changes remain compatibility-check targets, not established kaoiro defects.
The full existing wrapper suite exercises the adapter/permission/stream paths;
it does not prove the upstream fixes themselves.

Primary references: [SDK release notes](https://github.com/anthropics/claude-agent-sdk-typescript/blob/5dc91fb5ebe27e926e95d62f4b5dd7632e936e79/CHANGELOG.md),
[CLI release notes](https://github.com/anthropics/claude-code/blob/79babc372d64101f981bd2b52c3dbe588596dc56/CHANGELOG.md),
[Haiku 5.5 overview](https://platform.claude.com/docs/en/models/haiku-5-5/overview),
[CLI model configuration](https://code.claude.com/docs/en/model-config#haiku-5-5-context-window-and-pricing),
and [PDF limits](https://platform.claude.com/docs/en/build-with-claude/pdf-support#pdf-support-limitations).

## Initial gates and runner environment failure

The wrapper build/typecheck/test and runner typecheck returned exit 0.
Wrapper test counts were core 455, agent-common 539, Claude 803 (4 native tests
skipped), Codex 1355, and Antigravity 481 (2 live tests skipped). The test run
emitted SIGINT MaxListenersExceededWarning and CLAUDE_SDK_CAN_USE_TOOL_SHADOWED;
there were no unhandled errors. Build/typecheck emitted no warnings.

The Node 24.3.0 full runner suite returned exit 1: 1046 passed / 2 failed,
51 passed files / 1 failed file, duration 389.55s. It emitted SQLite's
ExperimentalWarning and negative-path diagnostics, without unhandled errors.
Both failures were in `codexState.test.ts`:

- `refuses a differing native pin through current with absent barrier directory on forward switch and zero link mutations`
- `refuses a differing native pin through current with absent registry on forward switch and zero link mutations`

Both threw `ERR_FS_EISDIR` at line 183, `rmSync(previous)`, while preparing a
temporary directory symlink; the product switch script had not yet been called.
The same four-condition selection (these two cases and two rollback controls)
was run twice in a disposable worktree fixed to the base commit
`26584d74aca456c96311cfa922496171ce95b1ff`. Each run returned exit 1, 2 failed /
2 passed / 31 skipped. A feature-branch repeat returned the same result.
The test bytes match the base, SHA-256
`c7f70c6eb542e1f783d17e4ebc7b667171a75cf90bf9ee366f25476faf896e66`.

A standalone temporary directory/symlink probe reproduced `ERR_FS_EISDIR`
with Node 24.3.0 and succeeded with Node 22.23.3. The four selected tests with
Node 22.23.3 returned exit 0, 4 passed / 31 skipped. The failure path uses only
this test's mkdtemp root and symlinks; it does not read the operator's Codex home,
peer processes or time before throwing. This is an existing test/environment
issue, not evidence of a Haiku regression. No runner test or product code was
changed; the director was notified and requested reporting without an out-of-scope
fix. Full failing logs were retained before any rerun.
