---
title: Antigravity gate tool-step observations
status: measured
last_updated: 2026-09-27
---

# Antigravity gate tool-step observations

This observation was moved from the tool and permission reference. It covers
the observed Antigravity CLI tool steps behind [ADR-0057 F4b](../../adr/0057-antigravity-adapter.md#f4b--gate-self-verification-on-the-production-path),
not an independent measurement of a newer binary.

- PreToolUse fired for every tool step observed so far: `write_to_file`,
  `view_file`, `list_dir`, `manage_task`, `run_command`, `define_subagent`,
  `search_web` *(measured; `stepIdx` matched `step_index` in all 9 cases)*.
  `wait_5_seconds` and `finish`, when asked for, produced no `tool` step
  in the stream.
