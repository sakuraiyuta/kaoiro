---
title: Method for extracting cwd changes in the Codex adapter
description: Choose among extracting cd from Codex event-stream item.command_execution, fixing it through wrapper-side pre-run env, or using Codex hooks (PreShellCall equivalent). Best-effort; the MVP accepts a fixed launch cwd.
status: open
urgency: low
blocks: []
opened: 2026-07-10
decided: null
---

## 背景

[ADR-0032](../adr/0032-codex-adapter.md) F9 decides that the `EngineAdapter` interface has a cwd notification
contract (equivalent to `onCwdChanged`) and that the Codex adapter does not
implement it in the MVP (display a fixed launch cwd). Track dynamic tracking as
candidate approaches in this open question and implement it in the phase where
it becomes necessary.

For background, see Claude-side [issue #92](https://github.com/sakuraiyuta/kaoiro/issues/92)
(the SDK does not persist Bash cd, so CwdChanged does not fire; waiting for an
upstream bug fix) and `ext.cwd` in [protocol](../specs/protocol.md). The Claude
side is also operationally unstable, so Codex-side extraction has the same low
urgency.

## 選択肢

| Option | Content | Advantages | Disadvantages |
|----|------|----------|-----------|
| A | Parse and extract commands containing `cd` from Codex event-stream `item.command_execution` | No additional infrastructure; complete within the event path | Fragile parsing (many complex cases such as `cd $(pwd)/x`); shell cd can diverge from the process cwd |
| B | Inject `PWD` into the pre-run env on the wrapper side and embed it in the prompt through shell hooks | High accuracy | Complex implementation; depends on how the Codex CLI starts shells |
| C | Use the Codex hooks system (the PreShellCall / PostShellCall equivalent introduced in v0.116+) | Clean, Codex-native path | Must track the state of the Codex hooks implementation |
| D | Give up dynamic tracking and keep the fixed launch-cwd display (MVP equivalent) | Zero implementation | UX degrades (`ext.cwd` loses meaning as dynamic information) |

## 影響

None (best-effort; not part of phase-14 completion). The dashboard displays the
cwd fixed at launch, but this is at the same level as the Claude-side SDK bug.

## 判断材料

- Upstream resolution status of Claude-side [issue #92](https://github.com/sakuraiyuta/kaoiro/issues/92)
  (if the SDK resolves it, kaoiro-side demand also changes)
- Hooks-system coverage in Codex SDK 0.144.1 (introduced in v0.116, but concrete
  capabilities need confirmation)
- Information granularity of Codex event-stream `item.command_execution`

## 暫定方針

Complete phase-14's MVP with option D (fixed launch-cwd display). Wait for the
resolution of Claude-side [#92](https://github.com/sakuraiyuta/kaoiro/issues/92),
reconsider the kaoiro-side policy then, and choose among A / B / C at that time.

## 解決時のアクション

- [ ] When Claude-side [#92](https://github.com/sakuraiyuta/kaoiro/issues/92) is
      resolved, reconsider the kaoiro-side tracking policy
- [ ] When this open question is resolved, incorporate the implementation method
      into the body as an addition to [ADR-0032](../adr/0032-codex-adapter.md) F9,
      or promote it to an independent ADR
- [ ] Close (delete) this open question
