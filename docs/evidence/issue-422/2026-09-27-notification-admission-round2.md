---
title: Issue 422 notification admission review round 2
status: verified
last_updated: 2026-09-27
---

# Issue 422 notification admission review round 2

## Correction and artifact

The prior (a)/(b) probes in [the first admission record](2026-09-27-issue-422-notification-admission.md) attached peer turns to the reply-basis ledger but sent separate Bash-only prompts to the SDK. Those observations did not establish that a peer's actual input owned the SDK turn. This round uses the received peer envelope for both `prepareReplyInput` and the SDK prompt, via the production `formatInboundMessages` path. The approved design remains commit `690913dd` and SHA-256 `c6ceffc660833eab720aa652cc82ccd6f179604a99e0775d95f626877d4671ab`.

The M2 source fix is commit `5451ef20`. A rejected distinct notification prompt ID is recorded while a wrapper turn owns the SDK stream. An originless terminal result after that collision cannot be attributed to the wrapper owner, so the host stops admission, retains that owner's unresolved state, and the CLI freezes further ingress until operator recovery. A same-ID fold with no collision still completes once. A result tagged only `task-notification` does not identify which prompt ID produced it, so it does not clear the collision.

## Input identity and native server comparison

Both probes used Claude Agent SDK 0.3.280, Claude CLI 2.1.280, the real `AgentHost`, SDK hooks and MCP callback, two joined `ServerLink` clients, and a local Phoenix server. The peer's ordinary message was accepted by the server and delivered to the host. `renderPeerInput` applied the production `formatInboundMessages` to that same envelope; the resulting text was both prepared for reply-basis tracking and passed to `host.run` or `host.send`. An offline controlled SDK iterator first checked the formed input against the actual SDK prompt. Removing the peer body from the formatter made that check fail; restoring it passed.

The final event audit compared the exact `formed_input.text` bytes with the corresponding `UserPromptSubmit.prompt` bytes, and asserted that the prompt contained the peer body, conversation ID, and `turn_number`. It also checked the T2 notification's prompt ID, turn-5 non-delivery, server rejection details, and peer delivery counts. The audit exited 0 for both final probes. Changing only the formed turn-3 text in a copied raw log made the same audit exit 1 with `SDK prompt differs from prepared envelope`.

For example, the actual `UserPromptSubmit.prompt` in (a) contains these peer-input substrings, rather than a separate Bash-only instruction:

```text
[from fuji422.nativea2.peer] request: Body A. Use Bash exactly once to run `sleep 18; printf BACKGROUND_DONE` with run_in_background=true.
(meta: done=false, propose_next=, conversation_id=fuji422-nativea2-1790452055139, turn_number=1)
[from fuji422.nativea2.peer] response: Body B. Run Bash exactly once with command `node -e 'setTimeout(() => console.log("SECOND_DONE"), 30000)'` and timeout=40000.
(meta: done=false, propose_next=, conversation_id=fuji422-nativea2-1790452055139, turn_number=3)
```

The lines above are substrings from two different prompts, with the intervening instructions omitted. The byte-for-byte comparison used each complete prompt, including those instructions. The equivalent CID and turn fields were present in (b)'s actual SDK prompts.

| Observation | Actual SDK input and ownership | Wrapper `NOTIFICATION` attempts | Server acceptances | Peer deliveries |
| --- | --- | ---: | ---: | ---: |
| (a) server latest peer turn 3 | T1 input contains body A, CID, turn 1; T2 input contains different body B, same CID, turn 3. Background Bash completion folded into T2's confirmed prompt ID. T2 kept default basis 3. | 1 | 1 | 1 |
| (b) server latest peer turn 5, host queued turn 5 | T1/T2 actual inputs remain turn 1/3. The host formed turn-5 input but no SDK `UserPromptSubmit` received it before the folded call; T2 kept basis 3. | 1 | 0: `stale_reply_basis(5,3)` | 0 |

The raw sequence for (a) is `a-real-nativea2-events.jsonl`: host inbound turn 1 seq 4, formed input seq 7, SDK prompt seq 10; host inbound turn 3 seq 28, formed input seq 30, SDK prompt seq 32; peer delivery seq 54 and accepted wrapper push seq 55. The raw sequence for (b) is `a-real-nativeb3-events.jsonl`: host inbound/formed input/SDK prompt for turn 1 at seq 4/7/9, and turn 3 at seq 29/31/33; server acceptance and host receipt of turn 5 at seq 39–40, formed but queued at seq 41–42; rejected wrapper push at seq 60. The wrapper attempt, server acceptance, and peer delivery columns are separate counts. A later ticket-authorized recovery, if performed, would be counted separately and would not change T2's default basis.

The final joined-server ledger control separately held the server's latest peer turn at 3. Notification N handed off turn 3, and N2's default basis 3 was accepted and delivered once (`a-ledger-final-events.jsonl` seq 6–10). The prior [first admission record](2026-09-27-issue-422-notification-admission.md) retains the ledger-merge mutation: suppressing only N's completed-ledger merge changed N2's basis to 1 and made the same server reject it. That test is distinct from the normal (b) rejection after server turn 5. The unchanged `reply_basis.ts` source and built JS in this round have the same hashes recorded there.

The final native Agent, retired-call, and independent-notification probes also exited 0 against the corrected `AgentHost` build. The Agent child's callback made zero wrapper sends, while the root completion made one. The retired T1 callback made zero sends after T2 admission. In the two-notification probe, N's stale basis 1 was rejected, recovery handed off turn 3, and N2's basis 3 was accepted once. Their event logs are listed below. These probes did not substitute for the peer-input (a)/(b) measurements.

## Ambiguous terminal and negative controls

The controlled real-`AgentHost` test creates T1 completion, a confirmed T2, rejection of a distinct notification prompt ID with a matching task candidate, then an originless result. The host does not call T2's `onTurnEnd`, and the CLI stops further ingress. A normal same-ID fold and a rejected notification result with a tagged origin are separate controls. A later result after a session change cannot release the frozen owner. The fail-stop remains until host teardown and operator recovery; it does not guess an owner for the ambiguous result.

One-step mutations of the collision marker, the cross-session terminal freeze, and the CLI admission callback each made their focused test exit 1. Restoring each source byte-for-byte returned the focused test to exit 0. The audit's negative control above independently pins the probe's input-identity assertion.

| Mutation | Red log | Restored test |
| --- | --- | --- |
| Remove rejected-prompt collision marker | `m2-collision-mutation-red.log`, exit 1 | Focused host test, exit 0 |
| Let a later session result release the frozen owner | `m2-late-result-mutation-red.log`, exit 1 | Focused host test, exit 0 |
| Disconnect the CLI admission freeze callback | `m2-cli-freeze-mutation-red.log`, exit 1 | Focused CLI composition test, exit 0 |
| Bypass the ambiguous-result guard | `m2-guard-mutation-red.log`, exit 1 | Focused host test, exit 0 |

The offline input probe exited 0 (`m1-offline-input.json`). Blanking the peer body in the shared formatter exited 1 (`m1-offline-negative.log`); source restoration exited 0 (`m1-offline-restored.json`). The final raw-log audit exited 0 (`m1-native-audit-final.json`); mutating the formed turn-3 text exited 1 (`m1-native-audit-negative.log`).

## Commands and retained raw artifacts

Run from the landing worktree after `cd wrapper && pnpm build` and starting local Phoenix with `PORT=42522 MIX_ENV=dev mix phx.server`:

```sh
node tmp/fuji-422/probe-a-input-offline.mjs
node tmp/fuji-422/probe-a-real-native-a.mjs nativea2
node tmp/fuji-422/probe-a-real-native-b.mjs nativeb3
python3 tmp/fuji-422/audit-m1.py
```

The raw event and SDK debug logs stay in `tmp/fuji-422` through the review round. They are excluded from git because SDK debug logs can contain session content. Only processes started for this measurement were closed or signalled; no process-name signal was used.

| Final native probe | Event-log SHA-256 | SDK debug SHA-256 | Model API dispatches |
| --- | --- | --- | ---: |
| (a) `nativea2` | `98332df7d9188c46e6f2ddd3a490d142f2ce3e91c1f98caf550e2bdbbfbb4edc` | `df1860147d9c8e662321a8e61c818e9e1339c3230eb46899e20b9f22951067d1` | 6 |
| (b) `nativeb3` | `dd8474cf267688d1b21b5eaffab54069c1e1f62155dc45cff8b0a688918030b6` | `2e27260583a2e9d7ded27ec085982f48ab2fee8e998b5e576d62031d8e5a2fae` | 6 |
| Two notifications, `ledgernative` | `1ee342b40c0d988078cac072561c9f5d425b3007f85041664cefb7c9f107844b` | `fa9537e84200b981133d5fac07332092eacbd9d2313def3aaa047dd24c9831b0` | 7 |
| Background Agent, `agent-bound` | `cf3957351fa8e3543f6ba77a0534559cf1c4a8c4ee743b3b7b60fd44e45b3867` | `0565798169114814434578cacdfc463ea19b19780f41f1a5eb39beaefbe55cb5` | 7 |
| Retired callback, `oldcall-bound` | `bc1a4a7f0e8be9304ad7e1f44c2ee78c39da031f7446e84c51e815e67af90ac9` | `cc67a9bc95fbc86619919b8b7338f0710081b3c70a8d38a84b88ca9aec03ea9b` | 3 |

The five final native probes made 29 model API dispatches. This round's exploratory probes made 18 additional dispatches: 12 before the final M2 artifact and six in a discarded (b) run whose scratch stage condition failed to enqueue turn 5. That discarded run had process exit 0 but failed the audit; it is not gate evidence. Total new dispatches in this landing worktree were 47, counted from the SDK debug files. The final controlled ledger event log SHA-256 is `fb90f268b4bf2079ecc03f9360f5ce8764ea0d1fd1ee7cd40b3f465bc40c2629`; it used no model API request.

The input formatter helper SHA-256 is `bf71556f1033659049a046860660d33399127e015f20e11b351ffcd3323b4e62`, the offline probe is `d3a901198c95f66858a0970c196c751a2ac207628a0bb4e4a307e2f941422fee`, the (a)/(b) scripts are `da5206af72eb94eb54263c690e62eda89923ce711f322616867d5aaf7c2de572` and `9fc4bf56e9b9a7c4b8a964e1dcabc7ebe6dd55294870057db73d8ef273b086e3`, and the audit script is `c9af51dc4310ac879ed3a54fe1ae2afba48fd1f81989887395258bb16213160a`. The audit output SHA-256 is `e6ade8fbc99905798fffba3c4ff519cec0b0e12a03b2a05ea7f39465d90010fd`.

## Source-to-build binding and final gates

The actual CLI probes loaded `wrapper/claude-code/dist/host.js` SHA-256 `c7280d256546f6493d531fcc3283910a86bb0f5ce728dca80c486d575ddbbfd0`, built from `src/host.ts` SHA-256 `60adf140de26c4c00c274b7f2c462e65224cae9c25d2d3641d67c6a6af9caf53`; and `dist/cli.js` SHA-256 `3171ad5a65f1c28d6275860362a871783f19cefc43222b91726fef18176b0064`, built from `src/cli.ts` SHA-256 `0f55a2bf2f28d03402ce4883ff293aae55c55f78bc2646bd241cfd9cb3f235d8`. The ledger source/build hashes are `78e6834e1ce65cbfb7ea5e4d01c6384d3c21e8d25a1671b3583512be491ef508` / `6dc4a13056e5dcec5ba741cc98bde217edfbd7dddfae55bba424eb49f2164511`.

The clean-tree wrapper build, typecheck, full test, runner typecheck, and runner full test are run after this evidence commit. Their command logs and exit codes are retained in `tmp/fuji-422` and reported with the submitted HEAD; this evidence file records the native and mutation boundaries rather than treating a precommit gate as a clean-tree gate.
