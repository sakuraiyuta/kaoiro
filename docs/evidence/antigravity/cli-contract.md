---
title: Antigravity CLI contract evidence
status: measured
last_updated: 2026-09-18
description: Dated observations of agy headless behaviour that informed the Antigravity adapter; not a current vendor guarantee.
---

# Antigravity CLI contract evidence

## Measurement record

**Target:** `agy` 1.1.26 on x86-64 Linux, authenticated by personal OAuth.
**Date:** 2026-09-04. **Conditions:** `--print` and
`--output-format stream-json` runs from a scratch directory, with isolated
customization roots and selected negative controls. The binary had
self-updated from 1.1.8 at the start of the session.

These observations explain adapter choices; they are not a claim that a later
vendor binary behaves identically. The current wrapper contract is in
[the event reference](../../reference/engines/antigravity-events.md) and
[the tools and permissions reference](../../reference/engines/antigravity-tools-permissions.md).

## Observations used by the adapter

- Headless print mode emitted one newline-delimited JSON object per line with
  `init`, `step_update`, and `result` top-level events. The first `init`
  contained the conversation id; `--conversation` resumed it in another
  process.
- A process per turn worked under piped stdio and without a controlling TTY.
  Leaving stdin open produced an error rather than a usable interactive input
  channel, so the wrapper closes it.
- `step_update` reported `agent_response` text deltas and tool
  `ACTIVE` / `DONE` / `ERROR` transitions. `result` reported `SUCCESS`,
  `ERROR`, or `CANCELED`. A permission auto-denial was observed as
  `CANCELED` with `denied_actions`.
- `--add-dir` made `.agents/rules/AGENTS.md` and `.agents/hooks.json`
  discoverable. Passing both the agent working directory and the generated
  customization directory made the intended working directory available to
  tool calls. A cwd-only hook was not observed to load.
- A PreToolUse hook was invoked for observed tool calls, and its `stepIdx`
  matched the corresponding stream `step_index`. A hook timeout killed the
  hook and did not run the tool.
- Native MCP configuration was not observed to start an MCP server in
  headless print mode, including global, plugin, and custom-agent attempts.
  This led to the wrapper CLI bridge.
- `agy models` returned tab-separated slug/display-name lines in one capture
  and bare slugs in an earlier capture. The wrapper therefore parses both and
  treats vendor catalog drift as normal.
- The CLI sandbox flag did not prevent the tested write outside the cwd or a
  network request. This is why the adapter labels sandbox enforcement
  advisory.
- A blocked mock passphrase prompt produced no stdout for 22.6 seconds. The
  indefinite incident shape was not reproduced: the CLI backgrounded the
  child and its print timeout ended the turn. The wrapper consequently keeps
  both inactivity and absolute tool deadlines.

## Raw shapes and negative controls

The resident-mode command was
`agy --print='' --input-format stream-json --output-format stream-json`; its
input was one line per turn:

```json
{"event":"user","message":{"content":"<text>"}}
```

An unsupported event value emitted
`warning: ignoring unsupported stream input message event "…"` to stderr.
This evidence is why the resident process was not selected as a control plane.

For the headless MCP negative control, a stdio server was registered with
`agy mcp add` globally at `~/.gemini/config/mcp_config.json`, through a plugin
under `--add-dir`, and through a custom agent with `inheritMcp: true`. In every
case the server startup marker was absent. The CLI log contained:

```text
declarative_config_loader.go: skipping component during resolution:
empty component: prompt section "mcp_servers"
```

`call_mcp_tool` remained listed in `init.tools`, but the model reported no MCP
tools. This is the negative control behind the CLI bridge design; it is not a
claim that every future `agy` version lacks MCP.

The observed hook input, including `transcriptPath`, is the authorization
contract in [the tools and permissions reference](../../reference/engines/antigravity-tools-permissions.md#authorization-boundary).
The observed path was
`~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl`.
Its JSONL schema is not established. The measured conversation database paths were
`~/.gemini/antigravity-cli/conversations/<id>.db` and
`conversation_summaries.db`; their schema was also unmeasured. `--continue`
resumed the most recent conversation, but was not adopted because it is
ambiguous across agents on one host.

The quota-free slash-command capture was:

```text
agy -p /usage --output-format json
```

Its response had `command.data.groups[].buckets[]` values with `window:
"weekly"`, `remaining_fraction`, and `reset_time`, in groups named `Gemini
Models` and `Claude and GPT models`. `-p /model`, `-p /permissions`,
`-p /hooks`, and `-p /help` were also observed without a model turn or quota
spend. This was a dated CLI observation, not the source of the wrapper's 429
projection.

## Catalog and authentication observations

The 2026-09-04 evening `agy models` capture contained 14 lines in
`<slug><TAB><display name>` form, for example
`gemini-3.8-flash-high<TAB>Gemini 3.8 Flash (High)`, and 1.1.26 rejected
`--output-format` for that subcommand. An earlier capture returned bare slugs
without the 3.8 family. Passing a display name rather than the slug to
`--model` exited 1 in a reviewer measurement. `--model <slug>` echoed into
`init.model`; `--effort low|medium|high` was accepted, although its effect was
not separately observable because Gemini slugs encode tier.

Personal OAuth was stored under `~/.gemini/` with
`selectedAuthType: "oauth-personal"`; the child inherited the wrapper HOME and
environment. `GEMINI_API_KEY` as an alternative was vendor documentation, not
a measurement. The runner's `agy models` registration probe was quota-free.

## Explicitly unmeasured or non-guaranteed

- The actual `stream-json` terminal `result.error` containing both a 429
  marker and `Resets in …` was **not measured**. The quota parser uses the
  internal-log string form as a fail-soft inference; a later capture must
  replace this evidence before widening the accepted grammar.
- Signal output in the middle of a stream, the runtime effect of `--mode`,
  the CLI behaviour on every hook timeout shape, and customization skill
  loading from `--add-dir` were not established as general contracts.
- The transcript path was observed through hook input, but its JSONL schema
  was not verified here.
- Vendor documentation and changelog statements are not measurements. They
  must be rechecked against the target binary before becoming an adapter
  dependency.

## Evidence limits

The original captures were local investigation artifacts, not durable source
files. This page deliberately records target, conditions, observations, and
limits rather than linking a reader to an ephemeral `/tmp` path. Re-run these
probes after a material `agy` upgrade or a change to the wrapper parser, hook
registration, bridge, or watchdog assumptions.

## Related pages

- [Antigravity adapter architecture](../../architecture/antigravity-adapter.md)
- [Antigravity event reference](../../reference/engines/antigravity-events.md)
- [ADR-0057](../../adr/0057-antigravity-adapter.md)
