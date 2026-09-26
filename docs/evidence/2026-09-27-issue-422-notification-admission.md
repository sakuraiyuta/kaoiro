---
title: Issue 422 Claude notification admission verification
status: verified
last_updated: 2026-09-27
---

# Issue 422 Claude notification admission verification

## Artifact and method

Option A source and reference documentation are commit `077b3dee78af7fdef7e1aa1ea03f1b7e266ddbd3`, built from the approved design at `690913ddeb0e9ab3cfc95cde21d64fe9c5935c6f` (design SHA-256 `c6ceffc660833eab720aa652cc82ccd6f179604a99e0775d95f626877d4671ab`). The earlier [implementation gate](2026-09-27-issue-422-implementation-gate.md) measured a fold with a synthetic repeated peer input and was blocked. The measurements below use the final source, distinct inputs, and a real joined server comparison. No server comparison or ticket rule was relaxed.

The native probes used Claude Agent SDK 0.3.280, CLI 2.1.280, the actual `AgentHost`, SDK hooks and MCP callback, and model API requests. The joined-server probes used two actual `ServerLink` clients against a local Phoenix server started in this worktree with `PORT=42522 MIX_ENV=dev mix phx.server`. The Agent and held-call probes used a transport recorder to count wrapper sends. Run the retained probes from the worktree root:

```sh
node tmp/fuji-422/probe-a-real-final-a.mjs fina
node tmp/fuji-422/probe-a-real-final-b.mjs finb
node tmp/fuji-422/probe-a-ledger-native.mjs ledgernative
node tmp/fuji-422/probe-a-agent-bound.mjs
node tmp/fuji-422/probe-a-oldcall-bound.mjs
node tmp/fuji-422/probe-server-stale-final.mjs
node tmp/fuji-422/probe-a-ledger-final.mjs
```

All seven commands exited 0. The five native CLI probes made 6, 6, 7, 7, and 3 model API dispatches respectively, counted from `[dispatch] sent anthropic-dispatch-id=` in each debug log: **29** in this final verification set. The entire issue investigation retained 119 dispatches across 18 debug files, including superseded probes and the earlier design measurements. No extra model request was made by the two controlled server probes. Only processes started by these probes were closed; no process-name signal was used.

| Measured boundary | Wrapper tool attempts | Server acceptances | Peer deliveries | Evidence |
| --- | ---: | ---: | ---: | --- |
| (a) T1 received body A/turn 1, T2 received different body B/turn 3; a background Bash notification reused T2's confirmed prompt ID. Its root call kept T2's fixed default basis 3. | 1 `NOTIFICATION` | 1 | 1 | `a-real-fina-events.jsonl` seq 45–48; T2 ended once at seq 52. |
| Separate stale-basis control with the joined server's latest peer turn 3: direct channel push with basis 1. This is not a T2 wrapper tool attempt. | 0 | 0; `stale_reply_basis(3,1)` | 0 | `a-server-stale-final-events.jsonl`. |
| (b) Server accepted ordinary peer turn 5 and host received it while T2 was active, before yielding it to the SDK. The folded root call kept basis 3. | 1 `NOTIFICATION` | 0; `stale_reply_basis(5,3)` | 0 | `a-real-finb-events.jsonl` seq 35, 53–55. The queued wrapper input was later cancelled on stream end. |
| (c) SDK MCP callback captured a T1 call before T1 was interrupted. It was released after T2's prompt confirmation. | 0 | 0 | 0 | `a-oldcall-bound-events.jsonl` seq 10, 16–21: `stale_tool_call`, `send_not_attempted=true`. |
| Actual background Agent: child callback, then root completion notification with a fresh prompt ID. | 1 root `AGENT_ROOT`; 0 child | Recorder only | Recorder saw 1 root | `a-agent-bound-events.jsonl` seq 22–23 and 31–44. The child received `unbound_tool_call`. |
| Two independent background Bash completions. First notification N used completed basis 1 and received `stale_reply_basis(3,1)`; the recovery result handed off peer turn 3. N2 then used default basis 3. | 1 N, 1 N2 | 0 N, 1 N2 | 0 N, 1 N2 | `a-real-ledgernative-events.jsonl` seq 39–48 and 52–69. Recovery committed at seq 47, handoff at seq 48; both notification tokens had separate terminal results. |

The L64 ledger mutation was also run against a real joined server with controlled token boundaries and no model request. With server latest turn 3, a confirmed N handoff made N2's default basis 3 and the server accepted one delivery (`a-ledger-final-events.jsonl` seq 8–10). Suppressing **only** N-to-completed-ledger merge made N2 use basis 1; the same server rejected it as stale and delivered zero. Restoring the source returned to basis 3 and one delivery. The turn-5 rejection above is the separate queue-control result; it was not used to claim the ledger mutation worked.

## Terminal ownership and negative controls

The fold's single T2 terminal result is recorded at `a-real-fina-events.jsonl` seq 52. The independent Agent and two-Bash notifications have their own `sdk_notification` starts and terminal results. The held T1 origin was captured before retirement and rejected after interruption; no new T2 token or snapshot was borrowed. In the two-Bash run, the first notification's committed recovery advanced only the next notification snapshot. Unit tests also cover session reset, queued undelivered input, rollback, error/interrupt failure notices for owned CIDs, and the union of wrapper batch and recovery CIDs before a same-peer successor.

One-step mutations on the final source were restored byte-for-byte. The affected focused test exited 1 in each red run and 0 after restoration:

| Removed mechanism | Red evidence | Restored evidence |
| --- | --- | --- |
| Completed-ledger merge | `a-ledger-mutation-test.log` (2 failures); real-server N2 rejected with basis 1 | `a-ledger-restored-test.log`; real-server N2 accepted with basis 3 |
| Fold owner classification | `a-fold-mutation-red.log` (1 failure) | `a-fold-restored-green.log` |
| Candidate deadline after an active turn | `a-candidate-expiry-mutation-red2.log` (1 failure) | Targeted test exit 0 after byte restoration |
| Wrapper coordinator CID union | `a-coordinator-union-mutation-red.log` (1 failure) | `a-cid-restored-green.log` |
| Independent notification's recovered CID settlement | `a-notification-cid-mutation-red.log` (1 failure) | `a-cid-restored-green.log` |
| Old tool-call origin retirement | `a-oldcall-retire-mutation-red.log` (1 failure) | `a-oldcall-retire-restored-green.log` |
| Background-task-only candidate filter | `a-foreground-mutation-red.log` (1 failure) | `a-foreground-mutation-green.log` |
| Retired prompt-ID rejection | `a-retired-mutation-red.log` (1 failure) | `a-retired-mutation-green.log` |

## Clean-tree gates

The code commit was pushed, `git status --short` was empty, and the following gates ran on that clean tree. Evidence writing began after all five completed. The test output has no Vitest `Unhandled Errors`; the wrapper full output includes warnings and expected error logs from failure fixtures, including a Codex bridge-handshake failure exercised by a passing test.

| Gate | Exit | Result |
| --- | ---: | --- |
| `cd wrapper && pnpm build` | 0 | All five wrapper packages built. |
| `cd wrapper && pnpm typecheck` | 0 | All five wrapper packages. |
| `cd wrapper && pnpm test` | 0 | core 270, agent-common 396, Claude 540, Codex 851, Antigravity 392 passed; 2 Antigravity skipped. |
| `cd runner && pnpm typecheck` | 0 | TypeScript accepted. |
| `cd runner && pnpm test` | 0 | 33 files, 774 passed. |

The retained gate logs are `tmp/fuji-422/a-clean-*`. The source-to-build binding is SHA-256 `78e6834e1ce65cbfb7ea5e4d01c6384d3c21e8d25a1671b3583512be491ef508` for `wrapper/agent-common/src/reply_basis.ts` and `6dc4a13056e5dcec5ba741cc98bde217edfbd7dddfae55bba424eb49f2164511` for its built JS; `40cbd0099732e32e90d8d68be6541584eb9a6388d869fb300a6763826373e271` / `f331d09dc01217e67fd2474058e118f493cca9235046776de27dfbcb7d661887` for `tool_origins`; `b08688b887ea9706ef5a4f943751eceeff7d4aa88c971b7fed00a63c2dc494de` / `f559273772e69b2fc1b707df44b31a4f622a4fb9d22e58d413fd8f472def9111` for Claude `host`; and `1f7e3b74624b77463ce5e521a3a115792e16980104490a61c428fcf3aa2d8e33` / `e70b514d92cc386ddcce6bfab973eacb34200a7b9ff68ba46cfcad375d27f1a5` for Claude `cli`.

## Retained raw artifact hashes

These scratch artifacts remain through implementation review and are removed by their creator after the round closes. They are not checked in because SDK debug logs can contain session content.

| Probe | Script SHA-256 | Event-log SHA-256 | SDK debug SHA-256 |
| --- | --- | --- | --- |
| `probe-a-real-final-a.mjs` | `bb1beb5708c8bfa6ef44cacfae20a217b296bab8cb18e8929cdce417347b7054` | `05d17d16605624d514ff01839387b8e6587822c90b42991fe8cb70efc5b60300` | `9fcdc76c5f97ffb20141fee2692badae0689ccfa39fffa430427aef0e2850dea` |
| `probe-a-real-final-b.mjs` | `57f57c4ffb63baec85e93c5570b2f1d50d152c2dedad39c7fc5e66d899757127` | `534daaf97b1cac225d11ec0d73d5e7b8e36163753144ebd067c2d16afd43bc81` | `06e6044065c2dae4d8b10458a988a2bf065b4c64f9a650144d0f5c8099646481` |
| `probe-a-ledger-native.mjs` | `a944edeeba9f5311836f1100c1eec959a98065267b14813fe69c0404be22e43c` | `48086a974e33bee19e0f50f19e4e2efb5d37ce1938d503f4cb885e0373b8eada` | `55d3e32e4daa3dd6f672835a50b16136b28b3f9568585c6769404cfe38444d5b` |
| `probe-a-agent-bound.mjs` | `8e70fbdf0b0873f831fb0caae21c20579034871b0872e7c2c1772d315f9ce607` | `f68652c9e26f3c70f61e88c5c11393375f32a8563a5e023f30a5838125514090` | `5670ca128bd88bf2a44a209b15f6af45f33376276e65eee7d3929b63892e51d5` |
| `probe-a-oldcall-bound.mjs` | `35289d50857a03cdd93e440290586c3488cfb32f743003bfed7884c5035928e2` | `17ae5e94bc5f1e67e4b87b8a1ab4c6d2697baf3531a585dac96638479f34b76e` | `ff666d9baf6cbf477c9cb92c7fab52479e564f26f9c2df50e17d717ac1637a44` |
