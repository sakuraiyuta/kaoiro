---
title: Peer routing
status: accepted
last_updated: 2026-09-18
---

# Peer routing

#### Destination-resolution guidance

`send_to_agent.to` requires an **agent_id** (charset `[A-Za-z0-9._-]`). If an
operator names a persona such as `@あお`, the model must resolve it with
`list_agents` before calling `send_to_agent`:

1. Collect entries with `persona.name == "あお"` from `list_agents`.
2. One entry → use its agent_id as `send_to_agent.to`.
3. Multiple → ask the operator which matching persona should receive this
   (include the candidate IDs) and wait for a choice before sending.
4. None → tell the operator “No matching persona was found.”

An agent named by the operator is an existing kaoiro peer. Do not skip the
resolution above and create a same-named internal subagent as a substitute
([ADR-0038](../adr/0038-codex-internal-subagents-toggle.md)). Create internal
subagents only when explicitly requested and by **role name**, not persona
name. Do not report collaboration or investigation as complete until an actual
`send_to_agent` is sent and answered.

Spell out candidate handling (3) in injected text and TOOL_DESCRIPTION.

## Related topics

- [Directory contract](../reference/inter-agent/directory.md).
- [Send and wait](../reference/inter-agent/send-and-wait.md).
- [Agent operations](../specs/agent-operations.md).
