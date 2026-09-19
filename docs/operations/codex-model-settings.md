---
title: Codex model settings
status: accepted
last_updated: 2026-09-18
---
<!-- markdownlint-disable MD033 -->

# Codex model settings

## Four paths for changing models

(A)-(C) below select AMONG the models Codex (or kaoiro's own curated
snapshot) already knows about. (D) is a different axis: it is how an
operator makes kaoiro aware of a model neither has advertised yet.

### (A) Web UI (Codex Settings)

On 2026-07-09, Codex was integrated into the macOS/Windows ChatGPT Desktop App.

- **Gear icon at top-right of the Codex sidebar → “Codex Settings” → model
  pull-down to switch**. The same panel has an “Open config.toml” button (an
  entry point to editing config.toml directly).
- Desktop / CLI / IDE extensions share the same `~/.codex/config.toml`, so a
  change anywhere affects all paths.

Note that this changes it **only on the Codex side**, not on the ChatGPT web
settings page (ChatGPT conversation and Codex coding are handled separately).

### (B) CLI option (temporary override)

Codex CLI help:

```text
-m, --model <MODEL>
    Model the agent should use
-c, --config <key=value>
    Override a configuration value that would otherwise be loaded from
    `~/.codex/config.toml`. Examples: `-c model="o3"`
```

- One-off override: `codex -m gpt-5.6-terra "..."`
- Dot notation: `codex -c model="gpt-5.6-luna" "..."`

The same flags pass to subcommands such as `codex exec` / `codex mcp-server`
(and to kaoiro through `@openai/codex-sdk`). Under ChatGPT auth, however,
specifying a slug outside the plan results in 400/404.

### (C) Persistent setting (`~/.codex/config.toml`)

```toml
# ~/.codex/config.toml
model = "gpt-5.6-sol"
```

**Resolution priority** (high → low):

1. CLI flags (`--model` / `-c model=`)
2. Profile (`[profiles.xxx]` section, enabled by `--profile`)
3. Project config `.codex/config.toml` (trusted projects only)
4. User config `~/.codex/config.toml`
5. Account / plan default (implicit)

The `CODEX_HOME` environment variable can also relocate `~/.codex` itself.

### (D) kaoiro's own `extra_models` declaration (issue #292)

kaoiro advertises a CURATED static snapshot of the entitled-model set
(`wrapper/codex/src/catalog.ts`, ADR-0035 H3) rather than probing Codex at
runtime, so a brand-new upstream model (like `gpt-6-astra`) is invisible to
LaunchDialog / AgentDetail until a kaoiro release updates that snapshot.
`runner.config.json`'s `codex.extra_models` lets an operator declare one
themselves in the meantime:

```json
"codex": {
  "extra_models": [
    { "value": "gpt-6-astra", "display_name": "GPT-6-Astra",
      "effort_levels": ["low", "medium", "high", "xhigh", "max", "ultra"],
      "default_effort": "low" }
  ]
}
```

- Only `value` is required; `resolved_model` is upstream-derived metadata and
  is never read from config. `display_name` defaults to `value`;
  `effort_levels` / `default_effort` absent means no effort switching is
  offered for that model (ADR-0035's "never infer an effort domain" rule
  — kaoiro does not guess one).
- The same mechanism (identical `parseExtraModels` / `mergeExtraModels`
  helpers) is available for the Antigravity engine as
  `antigravity.extra_models` (phase-34 Stage B6, issue #292) — see
  [Runner configuration](../reference/configuration/runner.md#antigravity-configuration)'s
  "Antigravity configuration" section.
- Declared entries are merged onto the resolved base catalog by
  `mergeExtraModels` (runner/src/config.ts, and the identical wrapper-side
  copy in `@kaoiro/agent-common`'s `catalog.ts`): a `value` matching an
  existing entry overrides it in place, a new `value` is appended. The runner
  applies this to the register payload it advertises (so
  LaunchDialog offers it before any wrapper exists); the wrapper applies
  the same merge to its own catalog resolution (`ext.models`, effort-switch
  availability, `setModel`).
  A matching Codex entry retains its curated `minimal_client_version` unless
  the declaration explicitly supplies a replacement.
- The declaration is host-wide (every agent on that runner), takes effect
  on the next spawn after a runner restart or config hot-reload, and does
  not bypass entitlement — a model the account is not actually entitled to
  still fails with the SDK's usual 400/404, surfaced as the existing
  `switch_error` rollback (or a launch failure for a fresh spawn).
- A Codex declaration may include `minimal_client_version` as a
  `major.minor.patch` string. When present, the runner and wrapper exclude
  the entry if the SDK-bundled Codex CLI is older. When absent, the entry
  remains advertised and the wrapper writes one process-wide warning per
  model; runner validation itself does not emit that warning. CLI compatibility
  is the operator's responsibility for that escape-hatch declaration.


## Migration links

- [Catalog contract](../reference/engines/codex-model-catalog.md)
- [Dated catalog evidence](../evidence/codex/model-catalog.md)
