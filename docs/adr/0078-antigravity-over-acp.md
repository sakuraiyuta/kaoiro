---
title: Host Antigravity over ACP with one agy process per prompt
status: accepted
date: 2026-11-23
supersedes: []
superseded_by: null
related_specs: [antigravity-adapter, antigravity-events, antigravity-tools-permissions, launch-contract, permission-state]
related_adrs: [57, 67, 77]
---

# ADR-0078 — Host Antigravity over ACP with one agy process per prompt

## Status

Accepted ([issue #1238](https://github.com/sakuraiyuta/kaoiro/issues/1238),
unit 3 of [issue #1181](https://github.com/sakuraiyuta/kaoiro/issues/1181)).
It replaces these parts of [ADR-0057](0057-antigravity-adapter.md): F2, F2a
in part (the stop routes and graces are kept, a watchdog cancel is final),
F3, the sandbox and `Cwd` parts of F4, the key and recovery of F4b, F5, and
the ACK transport of F5a (its meaning is kept). It reverses the choice of
one resident process made in
[issue #377](https://github.com/sakuraiyuta/kaoiro/issues/377).

## Context

The wrapper drove `agy` through `--print` with stream-json input and output,
one resident process per conversation, kaoiro tools through a CLI bridge and
a unix-socket tool host, and a PreToolUse gate that read a command's `Cwd`.
`agy` 1.5 serves the Agent Client Protocol (`agy acp`), which gives a
session, structured updates, a prompt response, cancellation and an HTTP MCP
server per session. On 2026-11-21 and 2026-11-22 the operator decided the
permission behaviour for Antigravity: `agy`'s own prompts off, the kaoiro
gate as the only check, `--sandbox` for the read-only and workspace-write
cells, and the cells of the permission mapping.

Measurements of `agy` 1.5.14 over ACP (see
[the measurements](../evidence/antigravity/agy-1.5.14-acp-measurements-2026-11-22-setup-and-sessions.md))
settled the shape of the host:

- **C1.** A command promoted to the background lets the prompt return
  `end_turn` while it runs, so a prompt does not wait for background work by
  itself. A Stop hook that answers `continue` while `fullyIdle` is false kept
  the prompt open until the output was in the reply (4 of 4 runs); `agy`
  honoured at most 10 continuations per prompt (D9).
- **C2.** Starting a generation costs a median of 2.2 s (`session/new`) or
  2.7 s (retire and `session/resume`), against about 7.5 s with `agy` 1.2.7
  when issue 377 chose a resident process.
- **C3.** After retirement, the sandboxed cells left no command behind on
  every measured route; `danger-full-access` can leave a command running.

## Decision

1. **One generation per prompt.** Every input runs on its own `agy acp`
   process (a generation): spawn, `initialize`, `session/new` or
   `session/resume`, the model and level, then one `session/prompt`. The
   generation is retired once the input settles, and the next one starts only
   after the previous process exited. A permission change needs nothing else:
   the next generation starts with the new launch flags (operator decision
   D16, 2026-11-22).
2. **The hook is the only permission check.** `agy` runs with
   `--dangerously-skip-permissions`, plus `--sandbox` except under
   `danger-full-access`. A PreToolUse hook registered in a managed
   customization directory asks the wrapper's gate, which decides by the
   permission mapping in
   [antigravity-tools-permissions.md](../reference/engines/antigravity-tools-permissions.md).
   A command's `Cwd` decides no cell. The gate joins each hook request to its
   ACP tool call; a mismatch, or tampering with the managed directory, is a
   gate fault that is sticky until the wrapper restarts or the session resets
   (D3).
3. **The Stop hook holds the prompt while background work runs.** Inside a
   prompt, the gate answers `continue` only while the turn's own loop reports
   unfinished background work, up to 10 times per prompt; otherwise `stop`
   (D9). The start is refused when the hook list shows another enabled Stop
   hook (D18).
4. **kaoiro tools over HTTP.** Each generation lists the kaoiro tools on the
   shared HTTP tool host of `@kaoiro/agent-common`, with a bearer for that
   generation only.
5. **What is removed.** The stream-json adapter, the CLI bridge and its
   `bridge` verb, the unix-socket tool host, the resident epoch and its idle
   timer, the recovery of the old gate, its `Cwd` rules and step ledger, and
   the `/usage` probe. `antigravity.epoch_idle_ms` is accepted and ignored
   ([runner configuration](../reference/configuration/runner.md)).

## Consequences

- Every turn pays a start (C2). A later turn does not reuse an earlier
  generation's process or tool host; the conversation continues through
  `session/resume`.
- A background command ends with its generation at the latest. Under
  `danger-full-access` a command may outlive `agy` on a teardown path; this
  is a known limitation (D14, C3).
- Holding a prompt open through the Stop hook costs model tokens while the
  model waits; the cost is documented, not metered (D9).
- The Stop hook set is checked at start only: a Stop hook added between the
  check and the spawn loads unseen (D18).
- `agy` keeps its conversations, including the bearer of the running
  generation's tool host, under its own home, which must not be shared
  ([enforcement boundaries](../reference/security/enforcement-boundaries.md)).
- The known limitations and the measured vendor behaviour are listed in
  [antigravity-tools-permissions.md](../reference/engines/antigravity-tools-permissions.md);
  the native acceptance of this design is in
  [the acceptance record](../evidence/antigravity/agy-1.5.14-acp-native-acceptance-2026-11-23.md).
