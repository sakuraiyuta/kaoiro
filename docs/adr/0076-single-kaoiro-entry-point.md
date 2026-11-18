---
title: One kaoiro entry point and the run verb
status: accepted
date: 2026-11-18
opened: 2026-11-17
supersedes: []
superseded_by: null
related_specs: [protocol]
related_adrs: [17, 18, 23, 32, 57, 75]
---

# ADR-0076 — One kaoiro entry point and the run verb

## Status

Accepted (2026-11-18). First unit of stage 1 of
[issue #140](https://github.com/sakuraiyuta/kaoiro/issues/140), tracked in
[issue #1177](https://github.com/sakuraiyuta/kaoiro/issues/1177). The stage 1
design went through three review rounds by a different model family (must 9
cumulative across its nine units; this unit was approved at round 3). The
operator decided on 2026-11-18 that there is a single entry, that wrapper hot
reload is dropped and that the positional start form is not kept.

This record implements D1 and D2 of
[ADR-0075](0075-runner-engine-launch-contract.md) for the bundled engines. It
amends the start parts of [ADR-0017](0017-wrapper-multientity-packages.md),
[ADR-0032](0032-codex-adapter.md) F4a and
[ADR-0057](0057-antigravity-adapter.md) F1 (a wrapper started as its package's
`dist/cli.js`), and the statement in
[ADR-0018](0018-runner-distribution.md) that the runner resolves a wrapper from
disk at each spawn. The package structure and the release profiles of those
records stand.

## Context

Stage 1 of issue #140 turns a release into one bundled JavaScript file that no
longer carries the engines. Three properties of the old start path stood in
the way.

- Each role had its own start file: `runner/dist/cli.js`,
  `runner/dist/setup-cli.js`, and one `dist/cli.js` per wrapper package,
  found through a table of package names. Six modules decided from
  `process.argv[1]` whether they were the start file. A prototype that
  bundled them into one file made every such check true, and a wrapper's
  `main` ran inside the runner.
- A start file was found from `process.argv[1]` or resolved from disk at
  spawn time. Measured through a `current -> releases/<id>` link:
  `process.argv[1]` keeps the link, while the main module's `import.meta.url`
  is the real path. A path that keeps the link starts the next child from
  whichever release the link points at after a switch, the defect the
  2026-08-16 amendment of ADR-0018 closed for the resolver.
- The initial prompt and the resume target were arguments of the wrapper
  process, readable by any local user from the process list.

## Decision

**D1. One entry with subcommands.** `runner/src/kaoiro.ts` is the only start
file. It dispatches by `import()`, so a wrapper process never loads the runner
and no module's top-level code starts anything.

| Command | Runs |
|---|---|
| `kaoiro runner [config]`, `kaoiro --version [--json]` | the runner |
| `kaoiro setup` | the setup wizard |
| `kaoiro wrapper <engine> run <launch file>` | that engine's wrapper |
| `kaoiro wrapper claude-code probe` | the Claude catalog probe |

Anything else prints one usage line and exits 64 before a module is loaded.
The alternative, keeping each package's start file and adding an entry beside
them, was rejected because two start paths would remain. A checkout runs the
same entry, built or under `tsx`; there is no development-only launcher.

**D2. One engine table.** `runner/src/engines.ts` maps each engine name to its
verbs and the module a verb imports. It is the only list of the engine names
on the start path: the launcher passes the requested name through, and the
entry looks it up. The table of package names in the launcher is gone.

**D3. One self-start command.** `[process.execPath, ...process.execArgv,
<entry>]`, where `<entry>` is the real path of the entry taken from its
`import.meta.url`. The runner starts a wrapper with it, and the runner and the
Claude wrapper start the probe with it. The whole `process.execArgv` is passed
on without filtering, which is what lets a runner started under `tsx` start
its children; the cost is that a debugging option given to the runner reaches
every child. The production shim gives node no options.

Measured with a transient systemd user unit (systemd 255): a wrapper and a
probe started this way stay in the runner's control group and end when the
unit stops; they start with an empty `PATH`; and after `current` moves to
another release, the running runner keeps starting the wrappers of its own
release. A consequence is that the release directory of a running runner must
not be deleted: its next wrapper start would fail.

**D4. The invocation is `run <launch file>`.** The launch file gains
`initial_prompt` and `resume_session_id`, the names the `spawn` message uses.
The launcher writes them per launch; the prompt is written only for the launch
a `spawn` starts, so a relaunch still does not repeat the first turn. The
wrapper's argument parser reads the verb and the file path and nothing else.
The positional form `<launch file> [prompt] [--resume <id>]` is removed, not
kept for development.

**D5. Wrapper hot reload is removed.** The `KAOIRO_WRAPPER_DEV` branch
(`tsx watch` on a wrapper's source) is deleted with the resolver it lived in.

**D6. The release layout does not change in this unit.** The entry is
`dist/kaoiro.js`; the later bundle's entry is named `dist/kaoiro.mjs` so the
two layouts can be told apart. `dist/cli.js` of the runner and of each wrapper
package stay in the tree as modules, and the tree keeps everything the
verifier of the previous release requires, because during an update the tools
of the running release verify the candidate. The launch shim and the setup
shim start the entry, and the verifier requires it.

## Not in this unit

- The `process.argv[1]` checks in the wrapper modules are no longer reached
  through the entry but are still present. They are removed in
  [issue #1178](https://github.com/sakuraiyuta/kaoiro/issues/1178), and the
  Codex bridge's one in
  [issue #1179](https://github.com/sakuraiyuta/kaoiro/issues/1179) when the
  bridge becomes a subcommand.
- The Codex bridge and the Antigravity hook and bridge are still handed to
  their engines as `<node> <package file>`
  ([issue #1179](https://github.com/sakuraiyuta/kaoiro/issues/1179),
  [issue #1180](https://github.com/sakuraiyuta/kaoiro/issues/1180)).
- Engine executable locations, `kaoiro engines install` and the bundled
  release layout are later units of issue #140.

## Consequences

- A wrapper started by hand goes through the entry:
  `node runner/dist/kaoiro.js wrapper <engine> run <launch file>`.
- Anything that identified a wrapper process by the path of its start file
  now sees the same entry for every role; the subcommand tells them apart.
- `node dist/cli.js` no longer starts a runner. A service definition that
  starts the launch shim is unaffected.

## Related

- [Launch contract](../reference/protocol/launch-contract.md).
- [High-risk change release](../operations/high-risk-change-release.md).
- [Runner development](../contributing/runner-development.md).
- ADRs: [0017](0017-wrapper-multientity-packages.md),
  [0018](0018-runner-distribution.md),
  [0023](0023-host-runner-architecture.md),
  [0032](0032-codex-adapter.md), [0057](0057-antigravity-adapter.md),
  [0075](0075-runner-engine-launch-contract.md).
