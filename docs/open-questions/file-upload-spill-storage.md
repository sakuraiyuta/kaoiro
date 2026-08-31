---
title: File Upload — Need for Wrapper Spill-to-FS / Always-on FS
description: Unresolved issue concerning spilling the wrapper's pending_uploads from an entirely memory-based implementation to a temp FS. Consider only if RSS becomes a problem with parallel uploads.
status: open
urgency: low
blocks: []
opened: 2026-06-27
decided: null
---

## 背景

[ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md) F3 established
pending_uploads as entirely memory-based (strengthening the disk-unreachable
principle = ADR-0020 F3). If the RSS peak becomes a problem with parallel
uploads (up to 20 × 128 MB in flight), there remains room to switch inside the
wrapper to threshold-based spilling (B) or always-on temp FS (C).

## 選択肢

| Option | Description | Advantages | Disadvantages |
|--|--|--|--|
| A | Keep the entirely memory-based implementation (MVP) | Maximize the disk-unreachable principle; minimal implementation | RSS peak with parallel large files |
| B | Spill above a threshold (small = RAM / large = temp FS) | Reduce memory pressure; support large files | More temp-file hygiene (perm 0600 / cleanup-on-crash / naming collisions); disk access |
| C | Always-on temp FS (unified) | Minimize memory pressure; one path | All files reach disk; unnecessary I/O |

## 影響

Either way, this concerns the wrapper's internal implementation and the
**protocol remains unchanged**. If B/C is adopted, the wrapper's test surface
expands (perm / unlink / GC timing). The interpretation of ADR-0020 F3's
"disk-unreachable" principle would need to be relaxed from "simply do not write
to disk" to "short-lived temp files are allowed."

## 判断材料

- Measured wrapper RSS in parallel upload operation (after Stage C completion)
- Host OS `tmpfs` capacity and permissions
- Risk of sensitive-data leakage (temp files remaining after a crash)

## 暫定方針

A — entirely memory-based for the MVP. Wait for measurements showing that RSS
has become a problem.

## 解決時のアクション

- [ ] Add RSS observation metrics to the plan
- [ ] Specify the threshold and spill strategy
- [ ] Promote to an ADR and delete this file
