---
title: "Codex sandbox startup orphan: native lifetime proposal"
status: proposed
last_updated: 2026-10-03
---

# Codex sandbox startup orphan: native lifetime proposal

For [issue #481](https://github.com/sakuraiyuta/kaoiro/issues/481), based on
`develop 2b221fffc51be8c5645276efcb442198cc7ce78a`. This is an investigation
and proposed design, **not an implementation or an approved dependency change**.
See the [dated measurements](../evidence/issue-481/2026-10-03-sandbox-close.md).

## Reproduction and cause

Production `runCodexCli`, its default host/session, real Phoenix transport,
Codex 0.159.3 and an offline Responses provider were used. The command was
`sleep 3`; no survivor was selected for signalling. Wrapper SIGTERM between
bubblewrap creation and command execution left a sandbox/command pair alive
after wrapper exit in **2/5 exec** and **1/3 app-server** runs. Waiting for the
actual command before stopping exec left no survivors in **3/3** runs.

A temporary native measurement gate delayed the namespace child's
`PR_SET_PDEATHSIG(SIGKILL)` for 300 ms. Stopping the wrapper at that gate
reproduced the orphan in **1/1 exec** and **1/1 app-server** runs. Replacing
only the SDK child's SIGTERM with SIGINT still orphaned it in **1/1** gated
runs, despite **0/5** survivors in the ungated SIGINT experiment. Waiting
until the actual command with the same gate left no survivor in **1/1**.
These are contrasting measurements, not estimates of production frequency.

The native child is PID 1 of a new namespace. Bubblewrap's parent-death
signal is installed after namespace setup; a parent death before installation
is not replayed. A post-install `getppid()` comparison cannot identify this
parent: it was **0 both before and after parent death** in a real namespace
probe. An inherited lifetime pipe did change from not-ready to `POLLHUP`.
The measured race therefore belongs at the native parent/child lifetime
boundary, rather than in a TypeScript process-discovery loop.

## Selected policy and alternatives

**Recommend correcting bubblewrap's native lifetime contract upstream first,
then consuming a reviewed fixed dependency.** Do not introduce a kaoiro
process-table reaper or ship the experimental preload gate as a workaround.
The correction covers both backends without changing their protocol or the
commands' namespace visibility. Available bubblewrap 0.13.0 source still has
the same bare parent-death registration; an upgrade alone is not established
as a remedy.

The proposed native contract is:

1. Before the sandbox clone, create a private lifetime pipe. Only the original
   monitor keeps its write end. Every child/intermediate branch closes its
   inherited write end; this must precede any additional clone or exec.
2. Preserve the child's read end through namespace/credential setup and
   descriptor cleanup. Install `PDEATHSIG(SIGKILL)` after changes that clear
   it, then check the lifetime pipe before executing the inner helper.
3. EOF/`POLLHUP`, an invalid descriptor, or inability to establish the guard
   causes the sandbox child to exit itself before command execution. When
   the parent is still alive, close the read end and exec normally; a later
   parent death uses the already installed SIGKILL binding.
4. Keep ownership local to the creating monitor and its inherited descriptor.
   No process-table lookup, descendant PID selection, or group-wide recovery
   signal is involved. A pidfd is an alternative, but the pipe avoids adding
   a Linux 5.3 minimum solely for this correction.

A bounded delay only moves the race. Switching SIGTERM to SIGINT failed the
controlled race. Signalling the wrapper's original process group cannot
reach the separate sandbox session. Wrapping the entire wrapper in another
PID namespace or cgroup changes launch/visibility/background-job contracts
and introduces a separate supervisor; it is not the selected first approach.

## Scope and decision required before implementation

The measured scope is Linux bubblewrap sandbox creation for **both exec and
app-server**, including close before command execution. It excludes arbitrary
processes deliberately detached by a tool, other engines, macOS/Windows,
and termination of a wrapper with SIGKILL before its own close handler runs.
Interrupt uses a related cancellation path but has not been measured here.

The director must decide whether to pursue an upstream correction and wait
for a fixed release, or authorize maintaining an isolated patched native
artifact. **This proposal does not authorize a new native build/vendor path.**
If the latter is chosen, review its architecture/licence/build/provenance and
artifact-selection design before implementation: Codex prefers system
bubblewrap, so replacing only its bundled copy would not prove adoption.
Never replace `/usr/bin/bwrap` on the shared host. Any fixed binary must be
selected only for this engine's own children and be verified by content hash
through production composition, including startup telemetry children.

## Verification and documentation plan

- Keep a production-composition Linux regression for each backend: default
  host/session/transport, isolated HOME/CODEX_HOME, real pinned native CLI,
  a bounded command and a before-command native gate. Assert the gate is
  reached and the command has not begun. After wrapper SIGTERM, assert its
  successful exit and absence of tagged live sandbox/command processes;
  observe survivors read-only and let the bounded command finish on failure.
- Pair early-close with actual-command-started close, normal completion, and
  operator interrupt. Require the actual command's ownership tag as a
  positive observation for started-command controls.
- At the native boundary, exercise parent loss before registration, between
  registration and the liveness check, and after a live check; cover a living
  parent, descriptor setup failure, intermediate branches, and FD cleanup.
  The process-table/recovery alternatives, if reconsidered, are fake-only.
- Remove only the post-registration lifetime check: the controlled early
  case must fail through a survivor assertion, not a timeout. Separately cut
  descriptor preservation and parent-only write-end ownership; their tests
  must fail. Keep every experiment's signal targets as held positive own
  spawn PIDs. Repeat after restoring the final production-selected artifact.
- Prove binary selection from the built wrapper and a runner launch, then
  substitute the current unfixed native binary: the same gate invocation
  must exit nonzero. A test that merely exercises the bundled copy is not
  evidence when the production resolver selects a system copy.
- Run affected package typechecks/builds and suites separately; Codex's full
  suite uses `env -u CODEX_HOME`. Include runner typecheck/test for runtime
  assets and any launch change. Report exit codes and warnings/errors.
- Update the Codex exec/app-server lifecycle references, adapter termination
  contract, packaging/provenance documentation if applicable, and the dated
  evidence. Keep this issue open until a reviewed fixed artifact passes the
  production-selection regression. No product source changed in this phase.
