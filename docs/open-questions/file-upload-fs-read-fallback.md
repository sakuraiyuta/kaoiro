---
title: File upload — trigger and boundary for reimplementing the (2) FS + Read path
description: Open question on the decision boundary for switching to wrapper-local FS + Read guidance (2) when direct content-block delivery (1) causes memory / speed problems.
status: open
urgency: low
blocks: []
opened: 2026-06-27
decided: null
---

## 背景

The [#52 issue body](https://github.com/sakuraiyuta/kaoiro/issues/52) specifies:
“First (1), expand the content into the prompt and attach it to the SDK message.
If problems arise, consider reimplementing it as (2), placing the file on the
wrapper host FS and having Read load it.” [ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md)
F1 / F3 finalized (1) (wrapper-internal rendering + all in memory) as the MVP,
but the decision boundary for switching to (2) is undecided.

## 選択肢

| Option | Content | Advantages | Disadvantages |
|--|--|--|--|
| A | Switch the wrapper's internal implementation to (2) when memory / speed becomes a problem (protocol unchanged) | Default in the issue body; switching cost stays inside the wrapper | Threshold for “a problem has appeared” is ambiguous |
| B | Keep (1) for now and reassess the switch in a separate issue when it is filed | Preserve the current state; defer the decision | No decision venue when the problem becomes visible |

## 影響

No impact while operation succeeds with (1). Switching to (2) remains inside the
wrapper implementation (whether prompt injection and Read guidance occur at SDK
call time). Protocol / client / server remain unchanged
([ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md) F1's
wrapper-internal principle).

## 判断材料

- Measured memory peak / SDK-call latency in operation with (1) (observe in live
  operation after Stage C completes)
- Stability of behavior as the Claude API content-block limit is approached
- How reliably Read guidance fires in the SDK / model (if guidance is unstable,
  (2) is unreliable)

## 暫定方針

A — This is the default in the issue body. Set the switching threshold through
operational observation after phase-1 (Stage C) completes.

## 解決時のアクション

- [ ] Add observation metrics (memory / latency) to the plan
- [ ] If adopting (2), record it in an ADR and change the wrapper internal
      implementation
- [ ] Promote this file to an ADR, then delete it
