---
title: Antigravity CLI 1.3.1 native production entrypoint acceptance evidence
status: measured
last_updated: 2026-10-08
---

# Antigravity CLI 1.3.1 native production entrypoint acceptance evidence

Target: [issue #534](https://github.com/sakuraiyuta/kaoiro/issues/534), runtime acceptance
for Antigravity CLI 1.3.1 on branch `issue-534-agy-1-3-1`.
Host: Linux x64, Node 22.23.3, pnpm 10.20.0.
The installed CLI executable (`/home/yuta/.local/bin/agy`) reports `1.3.1`.

## 1. Composition and reproduction harness

The measurement executed against the production `runAntigravityCli` entrypoint
using the default host factory (`new AntigravityHost`) and production tool
assembly (`interAgent.descriptors()`, `askUserQuestionDescriptor`, etc.).
Observation seams forward without altering runtime control.

- Test harness source: [`wrapper/antigravity/test/agy131_native.test.ts`](../../../wrapper/antigravity/test/agy131_native.test.ts)
- Reproducible run command:
  ```bash
  (cd wrapper/antigravity && KAOIRO_LIVE_AGY=1 PATH="/usr/bin:$PATH" pnpm exec vitest run test/agy131_native.test.ts)
  ```

## 2. Measured outcome

| Item | Measured result | Acceptance status |
|---|---|---|
| CLI version | `1.3.1` | Pass |
| Production entrypoint | `runAntigravityCli` with default host factory & tool assembly | Pass |
| Turn execution | Completed in 78.3s | Pass |
| kaoiro tool invocation | `set_status_line` called via PreToolUse hook bridge with arg `"verified-1.3.1"` | Pass |
| State transition history | `idle` → `sending` → `thinking` → `tool_running` → `thinking` → `done` → `waiting_input` | Pass |
| Terminal state | `waiting_input` (per issue #534 director ruling) | Pass |
| Engine transcript | Session `093319c3-08fc-421c-8ce5-db826078285d` | Recorded |

## 3. Detailed observation JSON

```json
{
  "cli_version": "1.3.1",
  "elapsed_ms": 78318.263488,
  "tool_called": true,
  "tool_arg": "verified-1.3.1",
  "state_history": [
    "idle",
    "sending",
    "sending",
    "thinking",
    "tool_running",
    "thinking",
    "thinking",
    "done",
    "waiting_input"
  ],
  "final_state": "waiting_input",
  "turn_completed": true
}
```
