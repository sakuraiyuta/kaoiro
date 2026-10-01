---
title: Antigravity CLI usage and rate limits evidence
description: Measured `agy -p /usage --output-format json` schema, timing, and window semantics for Antigravity rate limits.
status: provisional
last_updated: 2026-10-01
related: [antigravity-adapter]
---

# Antigravity CLI usage and rate limits evidence

The measurements below were conducted on 2026-10-01 on the development host.

- **CLI version**: `agy --version` returned `1.2.14`.
- **Executable path**: `/home/yuta/.local/bin/agy`.
- **Raw fixture output**: Recorded at `docs/evidence/antigravity/usage-probe-raw-20261001.json` (`conversation_id` is redacted as `<redacted>`).
- **Raw fixture SHA256**: `956fb00b6306e85a37fc985f33cb1fba4133bd8901aa2e5f9a0f8e5f0cd54ac7`.

## 1. Command, Timing, and Mid-Turn Verification

```bash
time agy -p /usage --output-format json
```

- **Execution time**: ~6.0s (`real 0m6.008s`, `user 0m0.591s`, `sys 0m0.348s`).
- **Token consumption**: 0 tokens (`usage.input_tokens = 0`, `usage.output_tokens = 0`, `usage.total_tokens = 0`).
  *(Inference / observation)*: The command appears to query the quota/accounting service directly without running an LLM turn or consuming prompt/output tokens.
- **Mid-turn execution procedure**:
  - Tested from within an active Antigravity session while the runner was executing a turn.
  - An independent child process was spawned running `agy -p /usage --output-format json`.
  - The command completed cleanly with exit code 0 and emitted valid JSON, without blocking or terminating the parent session.
  - However, because each probe takes ~6 seconds and creates subprocess/network overhead, probes must only be initiated at turn boundaries (after `result`) and never mid-turn.

## 2. CLI Log Accumulation and Retention Observations

- **Per-run log generation**: Each execution of `agy` writes a new timestamped log file `cli-YYYYMMDD_HHMMSS.log` under `~/.gemini/antigravity-cli/log/`. A single `/usage` run generated a 22,384-byte log file (~171 lines).
- **Directory observation**: As of 2026-10-01, the directory contained 263 files; the oldest was `2026-09-24 23:36:00` (followed by `2026-09-25 00:41:40`). Whether the CLI prunes by day count or file count is indeterminate.
- **Rate of accumulation**: A 5-minute throttling interval bounds probe log generation to at most 12 files per hour per peer, mitigating the risk of evicting historical debugging logs.
- **Throttling requirement**: Probes must be throttled (5 minutes between successful probes), except at initial launch or when recovering past a known `blocked` reset deadline.

## 3. Response Schema and Field Semantics

```json
{
  "conversation_id": "<redacted>",
  "status": "SUCCESS",
  "response": "Gemini Models\tWeekly Limit Remaining\t...\n...",
  "duration_seconds": 0,
  "num_turns": 0,
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "thinking_tokens": 0,
    "cache_read_tokens": 0,
    "total_tokens": 0
  },
  "command": {
    "name": "usage",
    "data": {
      "description": "Within each group, models share a weekly limit and a 5-hour limit...",
      "groups": [
        {
          "name": "Gemini Models",
          "description": "Models within this group: Gemini Flash, Gemini Pro",
          "buckets": [
            {
              "id": "gemini-weekly",
              "name": "Weekly Limit Remaining",
              "description": "You have used some of your weekly limit, it will fully refresh in 1 day, 14 hours.",
              "window": "weekly",
              "remaining_fraction": 0.6695590615272522,
              "reset_time": "2026-10-03T04:39:01Z"
            },
            {
              "id": "gemini-5h",
              "name": "Five Hour Limit Remaining",
              "description": "You have used some of your 5-hour limit, it will fully refresh in 2 hours, 27 minutes.",
              "window": "5h",
              "remaining_fraction": 0.4947547912597656,
              "reset_time": "2026-10-01T16:06:46Z"
            }
          ]
        },
        {
          "name": "Claude and GPT models",
          "description": "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
          "buckets": [
            {
              "id": "3p-weekly",
              "name": "Weekly Limit Remaining",
              "description": "You have used some of your weekly limit, it will fully refresh in 2 hours, 7 minutes.",
              "window": "weekly",
              "remaining_fraction": 0.9866412281990051,
              "reset_time": "2026-10-01T15:47:19Z"
            },
            {
              "id": "3p-5h",
              "name": "Five Hour Limit Remaining",
              "window": "5h",
              "remaining_fraction": 1.0,
              "reset_time": "2026-10-01T18:39:44Z"
            }
          ]
        }
      ]
    }
  }
}
```

### In-Use vs Unused `reset_time` Behavior (Measured across 2 samples)
- Sample 1: 2026-10-01 13:33:30 UTC
- Sample 2: 2026-10-01 13:39:40 UTC (~6 minutes later)

| Bucket ID | Remaining Fraction | Sample 1 `reset_time` | Sample 2 `reset_time` | Behavior |
|---|---|---|---|---|
| `gemini-weekly` | ~0.67 -> ~0.67 | `2026-10-03T04:39:01Z` | `2026-10-03T04:39:01Z` | Fixed epoch deadline |
| `gemini-5h` | ~0.54 -> ~0.49 | `2026-10-01T16:06:46Z` | `2026-10-01T16:06:46Z` | Fixed epoch deadline |
| `3p-weekly` | ~0.98 -> ~0.98 | `2026-10-01T15:47:19Z` | `2026-10-01T15:47:19Z` | Fixed epoch deadline |
| `3p-5h` (unused) | 1.0 -> 1.0 | `2026-10-01T18:33:37Z` | `2026-10-01T18:39:44Z` | Moves with probe invocation time (+5h) |

**Finding**:
- For buckets with consumption (`remaining_fraction < 1.0`), `reset_time` points to a fixed future epoch when the quota fully resets.
- For unused buckets (`remaining_fraction >= 1.0`), `reset_time` is merely a rolling placeholder generated relative to probe execution time (`probe_time + window_duration`).
- **Policy**: When `remaining_fraction >= 1.0`, `resets_at` must be omitted so downstream consumers do not interpret the moving placeholder as an active exhaustion deadline.

## 4. Mapping Rules to Wrapper `rate_limits`

- **Bucket ID Prefix Matching**:
  - `gemini-*` buckets are selected for Gemini models (`gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-3.8-flash-high`, etc.).
  - `3p-*` buckets are selected for 3p models (`claude-*`, `gpt-*`).
  - If model name is unknown (empty `value` account default or unmapped custom model), no bucket is mapped (`rate_limits` omitted).
- **Window mapping**:
  - `window === "5h"` -> `"five_hour"`
  - `window === "weekly"` -> `"seven_day"`
- **Utilization**:
  - `utilization = Math.max(0, Math.min(1, 1.0 - remaining_fraction))`.
- **Resets At**:
  - Emitted only when `remaining_fraction < 1.0`.
  - Value is `Math.floor(Date.parse(bucket.reset_time) / 1000)` (Unix seconds).
- **Status**:
  - Omitted during normal operation. Only set to `"blocked"` when `remaining_fraction <= 0`.
  - Quota exhaustion `status: "blocked"` originating from terminal `RESOURCE_EXHAUSTED` errors takes strict precedence and is never cleared by probe results.
