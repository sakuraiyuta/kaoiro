---
title: Antigravity CLI contract evidence
description: Measured customization and headless-MCP observations for the Antigravity CLI adapter.
status: provisional
last_updated: 2026-09-26
related: [antigravity-adapter]
---

# Antigravity CLI contract evidence

The measurements below were made on 2026-09-04 with `agy` 1.1.26 (x86-64
Linux, OAuth personal login) on the development host. The binary self-updated
from 1.1.8 during the session; probes used `--print` and
`--output-format stream-json` in a scratch directory. Vendor changelog and
documentation claims are unverified and must be re-measured before relying on
them.

### Customization discovery (persona, hooks, skills)

*(measured)* A directory passed with `--add-dir <dir>` is scanned as a
customization root **without** being listed in
`settings.json.trustedWorkspaces`:

- `<dir>/.agents/rules/AGENTS.md` — always-on rule; verified as the persona
  injection point (the rule "begin every reply with BANANA-OK" was obeyed on
  every run). This is the `systemPrompt.append` / `developer_instructions`
  equivalent (ADR-0032 F3).
- `<dir>/.agents/hooks.json` — PreToolUse hooks fired from here. The same
  file placed under the **cwd**'s `.agents/` did not fire in two probes
  (once untrusted, once trusted + `git init`); root cause not isolated, so
  the adapter relies on `--add-dir` only.
- `<dir>/.agents/skills/<name>/SKILL.md` — progressive-disclosure skill
  (name + description always in context) *(format from the bundled
  `agy-customizations` docs; loading from `--add-dir` unverified)*.
- `<dir>/.agents/agents/<name>/agent.md` + `--agent <name>` — markdown
  custom agent with YAML frontmatter and an H1 system prompt; measured to
  take effect (`init.agent = "kaoiro"`, prompt obeyed). Not used: whether it
  replaces the default scaffolding is unknown.
- **Workspace roots (measured, Stage 0.2)**: in print mode the process cwd
  is **not** a workspace root by itself — with no `--add-dir` the model ran
  `pwd` in `~/.gemini/antigravity-cli/scratch`, and a `.agents/hooks.json`
  under the cwd never fired (this is the root cause of the earlier
  "cwd hooks did not fire" observation; trusting the cwd in
  `settings.json` did not change it). With `--add-dir <customization dir>`
  alone, that dir became the only root and the model's `Cwd`. With
  **both** `--add-dir <cwd> --add-dir <customization dir>` (either order),
  `hook.workspacePaths` lists both and `run_command` ran in the real cwd.
  For the adapter's required launch arguments, see
  [Antigravity events](../../reference/engines/antigravity-events.md#main-api-and-process-model).
  The generated rules text names the working directory; the adapter's
  operating preamble supplies that directory.
  The `Cwd` containment contract is in
  [Antigravity tools and permissions](../../reference/engines/antigravity-tools-permissions.md#run_command-cwd-containment).
- **Environment inheritance (measured, Stage 0.3)**: a variable set on the
  `agy` process reached both the hook command and the `run_command` shell,
  so the bridge socket path and per-spawn nonce can travel in the
  environment.
- **Hook timeout exceeded (measured, Stage 0.3)**: a handler that outlived
  its `timeout` was killed and the tool step ended in `ERROR`
  (`JSON hook "jsonhook__kaoiro-gate_PreToolUse_0_0" failed: command
  failed: signal: killed`) — the tool did **not** run. Timeout is
  fail-closed on the CLI side as well.
- `.agents/permissions.json` and `.agents/settings.json` — **not loaded** in
  headless mode *(measured)*. MCP configuration behavior is detailed below.
- **Hook registration output (measured)**: `agy -p /hooks --add-dir <dir>
  --output-format json` lists the registered gate's `name`, `source` path,
  `matcher`, and `timeout_seconds` without a model turn. Without `--add-dir`,
  the list is empty. The wrapper uses this quota-free check before the first
  turn.

### MCP is not available in headless mode

*(measured)* No MCP server was ever spawned in print mode: a stdio server
registered via `agy mcp add` (global `~/.gemini/config/mcp_config.json`),
via `.agents/mcp_config.json`, via a plugin under `--add-dir` (including
`.agents/plugins/<p>/mcp_config.json`), and via a custom agent with
`inheritMcp: true` never started (startup marker absent), and the CLI log
shows `declarative_config_loader.go: skipping component during resolution:
empty component: prompt section "mcp_servers"` on every run. `call_mcp_tool`
is listed in `init.tools` but the model reports no MCP tools. Consequently
kaoiro's tool surface cannot ride on MCP as it does for Codex
(ADR-0032 F5) and uses a CLI bridge instead (next section). Re-check on
each `agy` upgrade; an MCP path would simplify the bridge.
