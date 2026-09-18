---
title: Antigravity adapter architecture
status: implemented
last_updated: 2026-09-18
description: Why kaoiro drives Antigravity through agy, and how the adapter owns a turn, customization, bridge, and watchdog lifecycle.
---

# Antigravity adapter architecture

## Why kaoiro drives the CLI

kaoiro's Antigravity engine is a TypeScript wrapper around the `agy` CLI, not
the Python SDK. The SDK was Python-only when this adapter was chosen, whereas
the runner and wrappers are Node processes. Headless `agy` provides a
newline-delimited JSON stream that the adapter can convert to the common
engine state machine without a second hosting runtime. The decision and its
alternatives are recorded in [ADR-0057](../adr/0057-antigravity-adapter.md).

The CLI is self-updating. Its observed behaviour is therefore not a permanent
vendor guarantee: dated observations and their limits live in
[the CLI contract evidence](../evidence/antigravity/cli-contract.md). The
current wrapper-facing event contract lives in
[the event reference](../reference/engines/antigravity-events.md).

## Turn lifetime and ownership

`AntigravityHost` owns one `agy` child per submitted turn. The first `init`
event supplies the conversation id; later children receive that id with
`--conversation`. A child is not a resident control plane: the wrapper closes
its stdin, terminates it for interruption, and treats an exit without a
terminal `result` as a failed turn. The host serializes its turn queue, so one
conversation is not driven by concurrent children.

Before a turn, the host creates (on first use) and rewrites a private
customization directory. It contains the persona rule, the PreToolUse hook,
and a bridge skill. The child receives both the agent working directory and
the customization directory through `--add-dir`; the customization directory
is not a workspace for the model to edit. The host verifies the generated
files and the registered hook before using them. It removes its directory on
close and sweeps only stale directories carrying its ownership marker at
startup.

The host also refreshes the model catalog with `agy models`. A failed probe
does not replace the static catalog snapshot. Display-name synchronization is
state-only; it does not rewrite the persona text until the next turn rewrite.

## Customization discovery and persona injection

The following behaviour was measured for a directory passed by `--add-dir`
without adding it to `settings.json.trustedWorkspaces`:

- `<dir>/.agents/rules/AGENTS.md` was always-on and was the persona injection
  point. A rule requiring replies to begin `BANANA-OK` was obeyed in every
  probe. This is the engine equivalent of `systemPrompt.append` or developer
  instructions.
- `<dir>/.agents/hooks.json` supplied PreToolUse hooks. The same file below
  the process cwd did not fire in two probes (untrusted and trusted +
  `git init`), so the adapter relies on `--add-dir` rather than the cwd.
- `<dir>/.agents/skills/<name>/SKILL.md` has the documented
  progressive-disclosure format; its loading from `--add-dir` was not
  established.
- `<dir>/.agents/agents/<name>/agent.md` with `--agent <name>` is a markdown
  custom agent with YAML frontmatter and an H1 system prompt. It took effect
  in a measurement (`init.agent = "kaoiro"`), though replacement of default
  scaffolding was not established.
- In print mode the process cwd alone was not a workspace root: without
  `--add-dir`, `pwd` ran in `~/.gemini/antigravity-cli/scratch` and a cwd hook
  did not fire. The customization directory alone became the only root. With
  both the real cwd and customization directory, in either order,
  `hook.workspacePaths` listed both and `run_command` used the real cwd. The
  adapter therefore passes both, names the working directory in its rules, and
  rejects a gate `Cwd` outside it.
- Environment variables from `agy` reached the hook and `run_command`, which
  lets the bridge pass its socket path and nonce. `.agents/mcp_config.json`,
  plugin MCP config, `.agents/permissions.json`, and `.agents/settings.json`
  were not loaded in headless mode.

The host creates `<dir>/.agents/rules/AGENTS.md` lazily before the first turn
from the server-provided persona prompt (personality plus footer) and its
working-directory/bridge preamble. It rewrites that file before each turn;
`display_name_sync` changes displayed state only and never rewrites persona
text. Persona packs remain engine-independent.

## Bridge and permission boundary

Headless `agy` does not provide kaoiro's MCP integration. The adapter instead
passes a private socket path and nonce to a wrapper-owned CLI bridge. The
generated rule tells the model to invoke that bridge through `run_command`.
The PreToolUse hook is the authorization boundary: it recognizes the strict
bridge command grammar and otherwise delegates to the Antigravity gate.

The detailed command classification, advisory sandbox limit, permission
switching, and recovery meaning are the
[tools and permissions reference](../reference/engines/antigravity-tools-permissions.md).
This separation matters: a successful CLI tool invocation is not evidence
that the CLI sandbox enforced a restriction.

## Watchdog and failure ownership

The host uses one `TurnWatchdog` for both inactivity and tool wall-clock
limits. The watchdog starts only for an admitted turn, observes parsed tool
`ACTIVE` / `DONE` / `ERROR` transitions, and requests interruption before a
fail-stop if the child does not settle within the abort grace. Stream activity
can extend the inactivity timer but never the absolute tool deadline.

The default inactivity limit is 30 minutes; the default tool limit is ten
minutes. Both are wrapper environment settings, not CLI flags. A tool timeout
is reported through the existing failed-turn path with `error_detail` set to
`tool_timeout`; it does not introduce a new wire event. Lifecycle logs omit
raw tool input. Exact defaults, environment names, and event mappings are in
the [event reference](../reference/engines/antigravity-events.md).

## Boundaries

The adapter accepts text turns only and advertises no attachment or
context-usage capability. Its sandbox value is advisory: enforcement comes
from the wrapper gate and the permission broker, not from a demonstrated CLI
sandbox. The adapter can advertise runtime permission switching only after a
successful permission-sync negotiation and only when all three launch ceilings
were supplied by the runner. These are current implementation constraints,
not claims about all `agy` versions.

Headless MCP was investigated and not adopted. A stdio server registered via
`agy mcp add` globally, through a plugin below `--add-dir`, or by a custom
agent with `inheritMcp: true` never started (its startup marker was absent).
The CLI log repeatedly said `declarative_config_loader.go: skipping component
during resolution: empty component: prompt section "mcp_servers"`.
`call_mcp_tool` still appeared in `init.tools`, but the model had no MCP tools.
The bridge therefore remains the adapter's tool surface. This is an observed
version-specific limitation, not an assertion about a future `agy` release.

## Related pages

- [Antigravity event reference](../reference/engines/antigravity-events.md)
- [Antigravity tools and permissions](../reference/engines/antigravity-tools-permissions.md)
- [Antigravity CLI contract evidence](../evidence/antigravity/cli-contract.md)
- [ADR-0057](../adr/0057-antigravity-adapter.md)
