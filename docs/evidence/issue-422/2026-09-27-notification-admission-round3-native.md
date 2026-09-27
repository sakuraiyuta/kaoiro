---
title: Issue 422 notification admission round 3 native gates
status: verified
last_updated: 2026-09-27
---

# Issue 422 notification admission round 3 native gates

## Artifact and scope

The source artifact is commit `7e99856141be443c0f3bb1200393e3d71e2d8132` on the landing candidate. These measurements loaded the built Claude SDK host and common inter-agent tool from that artifact. Claude Agent SDK 0.3.280, CLI 2.1.280, actual CLI hooks and MCP callbacks, joined `ServerLink` clients, and a local Phoenix server were used. The model API was called; no result below comes from a simulated model response. The separate [round-3 record](2026-09-27-issue-422-notification-admission-round3.md) contains the controlled fail-stop tests and mutations. This record binds the native normal path to the final send guard.

| Built module | SHA-256 |
| --- | --- |
| `wrapper/agent-common/dist/inter_agent.js` | `197cd3ee158d2d34ad1c775d0e65b89f8923f1ce973d40798410b7cb15fc7cd2` |
| `wrapper/agent-common/dist/tool_origins.js` | `1803709154121cfe10c0b71c371443c5fd0f941e02f2b1f941d3c90fdaf30bac` |
| `wrapper/claude-code/dist/host.js` | `76042923045689009d9ebb3dd89b13d20afba673841736c6db1b9a156b7a3e97` |
| `wrapper/claude-code/dist/cli.js` | `00daf7dca9da209c99a0dfd64458b3bf1fb3b5ca5c22a6835e33ba245576ba5c` |

The peer's actual server envelope was passed through production `formatInboundMessages`. That same formatted input was passed to both `prepareReplyInput` and `host.run`/`host.send`. The audit compared the complete `formed_input.text` to the `UserPromptSubmit.prompt` bytes and checked the peer body, CID, and turn number. It exited 0 for both valid probes. Changing only the formed turn-3 text made the audit exit 1 with `SDK prompt differs from prepared envelope`; the original log then passed again. This negative control checks the verifier as well as the probe.

| Observation on final build | T1/T2 actual SDK input | Wrapper notification attempts | Server acceptances | Peer deliveries |
| --- | --- | ---: | ---: | ---: |
| (a) server latest peer turn 3 | T1 had body A/CID/turn 1 (prompt seq 10); T2 had different body B/same CID/turn 3 (prompt seq 30). Bash completion folded into T2. | 1, basis 3 (push seq 52) | 1 | 1 (seq 51) |
| (b) server latest peer turn 5 | T1/T2 had the same distinct turn-1/turn-3 inputs (prompt seq 10/30). Turn 5 was accepted by the server and held in the host queue, with no SDK prompt for it before the folded call. | 1, basis 3 (push seq 58) | 0: `stale_reply_basis(5,3)` | 0 |

The counts distinguish the wrapper attempt, server acceptance, and peer delivery. Turn 5 was neither borrowed for T2's default snapshot nor removed from the server's ordinary history. The audit result is `tmp/fuji-422/r3-native-audit-final.json`, SHA-256 `31c51d5617bd092ca309643f69596781e8af7d38d2893876b0855384b6ca2e4e`.

The Bash N→N2 control also used the final build. N's first send attempted basis 1 and was rejected with `stale_reply_basis(3,1)` (push seq 44). Recovery handed off turn 3 to N; after N ended, N2's independent notification used basis 3 and was accepted and delivered once (peer delivery seq 63, push seq 64). The background Agent control used the actual Agent tool. Its child send received `unbound_tool_call` (tool result seq 23; zero transport sends), while the root's completion notification sent `AGENT_ROOT` once (transport seq 37, accepted tool result seq 38). These are native controls for the shared outbound guard, not replacements for (a)/(b).

An exploratory (b) run with an 18-second background command was **not** a valid gate: the notification arrived before the T2 SDK prompt. Its process exited 0, but the prompt-order audit rejected it. The valid (b) retry used a 50-second background command and passed the audit. A separate exploratory retired-call run also exited 0 but the model made no T1 send call, so it never captured a call to release; it is **not** evidence for the retired-call gate. The earlier round-2 retired-call result remains a historical observation, not a final-build remeasurement.

## Reproduction, files, and API use

With the final build and a local Phoenix server at `PORT=42522 MIX_ENV=dev`, the valid probes were run from this worktree with:

```sh
node tmp/fuji-422/probe-a-real-r3-a.mjs nativea3
node tmp/fuji-422/probe-a-real-r3-b5.mjs nativeb5
node tmp/fuji-422/probe-a-ledger-r3.mjs ledgernative3
node tmp/fuji-422/probe-a-agent-r3.mjs
python3 tmp/fuji-422/audit-m1-r3-final.py
```

The raw files stay in ignored `tmp/fuji-422` until this review ends. SDK debug logs can contain session content, so they are not committed. File hashes bind the reported observations to those retained files:

| Probe | Event log SHA-256 | SDK debug SHA-256 | Model API dispatches |
| --- | --- | --- | ---: |
| (a) `nativea3` | `15805258dc9bda7747f79674db95a3dddc812e424ad89c8fdec6e191f966352f` | `f9457693e83f7f863f23ee80c222c99c0b8659d92f82a6572fdba3efdbb9afe6` | 6 |
| (b) `nativeb5` | `b2ba9853d6ec856e60f6d8f11a4558f1829a1edf6f8aed09639ad92c62697bb1` | `1dac9510039f692d65c31e8b101da30101c1b4237f27d6a335416e30ffa6fe57` | 6 |
| Bash N→N2 `ledgernative3` | `ceea379ec68aed3dd2f3d5a432f5a7001a6ca5d7be3cd94f1130bed3d85cce27` | `fdcd8995159cea69aff0519f15243659835763e08a91ef8f47200b769ec7c4d6` | 7 |
| Background Agent | `f4bec012cc0763ffd3e9e7682d474083aa8617a4c499c45607141b4b586e34d2` | `c5ae467f74954fedb5e7ca71ea5150827e3f37e712cea2f079d7f995b10dc1e2` | 7 |
| Invalid first (b), `nativeb4` | `43eca6e7f6efe517683589b2b7ca9ee4c84968aea94e14c27ac96a349c49abb7` | `3b1be71b083592493b049aea4c9f089fe358296e6fdb9c5c0e297d92521ea021` | 5 |
| Exploratory old-call without a captured call | `61ca2091f3b57cb4a2ece13b8035b44a5f5c86738bfde398b9e6edf74bb4bdda` | `4cf8ba0fb6da3a2838ce561c60c8e6e707021b82036a02ea194122c7e2cd523d` | 3 |

The four valid probes made 26 dispatches. The two excluded exploratory runs made eight more, for **34 model API dispatches** in this final-build rerun. Dispatches were counted from each SDK debug log's `[dispatch] sent anthropic-dispatch-id=` entries. No additional real model request was made for the controlled ambiguous-result case; the Host/ToolOrigins/InterAgentTool mutation and the reviewer's unchanged controlled test in the round-3 record cover it.

The probe script SHA-256 values in command order are `8d3eb98e4f3cc68d83739c80461e756d0902123751204874bc5d1fbc2ea95496`, `bfe70ef15d83b1d629508481df2810583fb63cc6b0a495d4373b91749237dd3f`, `132a67ff90f3ee71a867d3b4f9c13b0336d17ed830e7a02e2d95f5022ce93546`, and `a2c187046571fab4ab6cd109b5b84110f57ed3aeaf75f40861e8860496204cc4`. The audit script SHA-256 is `e85d66bc1b96d13f3d286808ce625714640580704035e786377c375db105a9d7`; its changed-input negative log SHA-256 is `66606d3a3bbf072083b00f65d44eee49b59268459615646cf7d4de56e38d5c3c`. Only PIDs started for the local server and probes were signalled.
