---
title: The launch contract between the runner and an engine
status: accepted
date: 2026-11-18
opened: 2026-11-17
supersedes: [17, 32, 57]
superseded_by: null
related_specs: [protocol]
related_adrs: [17, 18, 23, 32, 57]
---

# ADR-0075 — The launch contract between the runner and an engine

## Status

Accepted (2026-11-18), as the "launch contract only" step of
[issue #1043](https://github.com/sakuraiyuta/kaoiro/issues/1043) that precedes
stage 1 of [issue #140](https://github.com/sakuraiyuta/kaoiro/issues/140).
Design review: two rounds by a different model family, must 3 cumulative, 0
at round 2. The operator shrank this step to "write down the current contract
and hand issue #140 three constraints" on 2026-11-18.

Implementation state: D3 records the behaviour that exists, stated in
[Launch contract](../reference/protocol/launch-contract.md). D4 is
implemented by [issue #1169](https://github.com/sakuraiyuta/kaoiro/issues/1169)
(`develop` at `fda95f95`). D1, D2 and D6 are implemented in issue #140
stage 1; until then the reference page describes the old form.

Partially supersedes the launch parts of
[ADR-0017](0017-wrapper-multientity-packages.md),
[ADR-0032](0032-codex-adapter.md) F1 and F5, and
[ADR-0057](0057-antigravity-adapter.md) F1 and F5: a wrapper package started as
its own `dist/cli.js` by the runner's Node binary through a table of package
names, and bridge and hook scripts handed to an engine as
`<node> <package file>`. The frontmatter lists them for that reason; their
other decisions, including the package structure, stand.

## Context

Issue #140 replaces the per-engine wrapper entries with one kaoiro entry
point and stops bundling the engines. Issue #1043 wants an engine to be an
executable the runner talks to through a versioned contract, so that the
four engines are no longer a closed set. No document stated the contract that
issue #140 has to build against.

The process contract that issue #140 changes is small: how a wrapper is found
and started. What the runner knows about each engine (catalogs, probes,
session lookups, pre-launch checks) is much larger and is not changed by
issue #140. A prototype of the single entry showed that the runner's
in-process imports of wrapper code bundle, but that code running at import
time and files found from their own location break; those are fixes inside
issue #140, not contract matters.

## Decision

**D1. An engine is a descriptor, and its command is an argument vector.**
The runner starts `command[0]` with `command.slice(1)` followed by the
contract arguments. A bundled engine's descriptor is built in; under
issue #140 its command is the kaoiro entry followed by `wrapper <engine>`.
The `KAOIRO_WRAPPER_DEV` branch (`tsx watch`) is removed with the old resolver
and not carried over as a second command (operator decision, 2026-11-18:
hot reload is dropped). Running kaoiro from a checkout goes through the same
entry. Where external descriptors are declared, and what else a descriptor
carries, is left to issue #1043.

**D2. The invocation is `<command...> run <launch file>`.** The initial
prompt and the resume target move into the launch file, which is mode 0600 in
a private directory; today the prompt is an argument that any local user can
read from the process list. `run` sits beside the `hook`, `bridge` and `probe`
subcommands of issue #140. The names `describe`, `preflight`, `sessions` and
`catalog` are reserved for issue #1043, not defined. The positional form is
removed, not kept as a second form (operator decisions, 2026-11-18). A
prototype started itself as `wrapper claude-code run <launch file>` and
completed a turn; moving the two values into the file was not tried.

**D3. The lifecycle is contract 1 as it stands.** Working directory,
readiness by server join, the recovery checkpoint and its states, exit code
79, recovery selection deciding which exits may be relaunched, SIGTERM and
inherited streams are written down unchanged. No version field is added:
bundled engines run from the same release as the runner, and a field arrives
with the first change an engine has to tell apart.

**D4. The runner's own credentials do not belong in a child's environment.**
Every child inherited the runner's whole environment, including its server
credential, while the wrapper already receives its own token in the launch
file. Options were to keep that, to remove the runner's credentials, or to
pass an allow-list of variables. The runner now deletes its three credential
variables from its own environment right after reading the token, as its own
unit independent of issues #140 and #1043. An allow-list was rejected as
brittle: engines need `HOME`, `PATH`, their own auth and home variables,
proxies and SSH agent sockets. This does not stop a process of the same OS
user from reading the runner's environment file or initial environment; it
matters most once an engine is third-party code.

**D5. The engine knowledge inside the runner is not part of contract 1.**
The six responsibilities listed in the reference page stay in the runner
through issue #140. Each is to become data an engine declares or an
operation an engine provides, under issue #1043. This fixes who is
responsible, not the form; issue #140 may simplify how one is done, and the
release check for each `@kaoiro/<engine>/dist/cli.js` disappears with those
files.

**D6. An engine's executables are found through an explicit location.** The
Codex app-server binary and the Agent SDK's search for its CLI take a
location that is passed in; for Claude the SDK option
`pathToClaudeCodeExecutable` exists, for Codex one is added. The Codex version
read at import time needs no location and reads the version table generated
from the lockfile. A prototype ran the pinned SDK against separately installed
CLIs for a catalog read and one turn with a tool call; permission prompts,
interrupts, resume, compaction, input folding and uploads were not measured,
so the version pin still decides which CLI kaoiro accepts.

## Constraints handed to issue #140

1. **One registry.** Every place that enumerates engines reads the same
   descriptor table, and an enumeration that is no longer needed is removed
   instead of being rewired. No new list of the four names.
2. **Start by command.** The runner starts an engine through its
   descriptor's command and the `run` verb, not through `process.execPath`
   plus a resolved file. Engine-facing scripts become subcommands of the
   same command.
3. **Artifacts hang off the descriptor.** The engine binaries that
   `kaoiro engines install` fetches (name, version, integrity) are declared
   per bundled descriptor, sourced from the list of expected versions of
   [issue #1168](https://github.com/sakuraiyuta/kaoiro/issues/1168). An
   external engine manages its own dependencies. The wrapper receives the
   location of a fetched executable explicitly (D6).

## Consequences

- The reference page is the single statement of what a wrapper may rely on
  when it is started; issue #140 changes it in the same change as D1 and D2.
- The engine knowledge inside the runner remains the main work of
  issue #1043 after issue #140.
- Out of scope here: capability declarations replacing engine names in the
  server and dashboard, splitting `WrapperConfig`, moving the four engines,
  an example external engine, a contract version field, and installing or
  sandboxing third-party engines.

## Related

- [Launch contract](../reference/protocol/launch-contract.md).
- [Runner control and launch](../reference/protocol/runner-control.md).
- ADRs: [0017](0017-wrapper-multientity-packages.md),
  [0018](0018-runner-distribution.md),
  [0023](0023-host-runner-architecture.md),
  [0032](0032-codex-adapter.md), [0057](0057-antigravity-adapter.md).
