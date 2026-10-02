---
title: "Codex sandbox startup orphan measurements"
status: measured
last_updated: 2026-10-03
---

# Codex sandbox startup orphan measurements — 2026-10-03 JST

For [issue #481](https://github.com/sakuraiyuta/kaoiro/issues/481).
The body and all comments were read before probing: there were zero comments.
The related [issue #439](https://github.com/sakuraiyuta/kaoiro/issues/439)
body and three comments were also read. Their reported counts were not used
as measurements of this baseline.

## Target and composition

Base `2b221fffc51be8c5645276efcb442198cc7ce78a`; no product source changes.
WSL2 kernel `6.18.33.1-microsoft-standard-WSL2`, Node 24.3.0, native Codex
and SDK 0.159.3, system bubblewrap 0.9.0. The native binary SHA-256 is
`8bf204b36a2f6dd0dab73aa2f639892e67ef9ac8befccb4a05b1496ebf25c479`.
The patched installed SDK SHA-256 is
`72d4e07babc1a3173c1e8efc016f92c42a00056fa62e3b0ecf739f19d7668521`.
All relevant built/native/probe hashes and the captured process identities
are in the [structured evidence](2026-10-03-sandbox-close.json).
The build-info `dirty` flag came from downloaded untracked source files,
subsequently moved to ignored scratch; hashes bind the executed artifacts.

Each wrapper was a held child running the built `runCodexCli` with only its
argument/config entry seams. Host, session, SDK, ServerLink, and the native
sandbox were real. A Phoenix-loopback fixture performed the handshake and
permission sync. An offline Responses provider requested a genuine native
`exec_command` with `sleep 3`; no account credentials were used. HOME and
CODEX_HOME were private directories under the worktree. Nondefault backend
selection was explicit; the exec host otherwise had its production defaults.

All stop signals targeted that own spawned wrapper's retained positive PID.
Process tags and `/proc` were read-only observation. No discovered descendant
was signalled. The command's natural exit removed every observed orphan.
Native runs were wrapped in 45–120 second `timeout` invocations. Namespace
exploration used the repository's outer/inner-setsid namespace wrapper and
saw uid 0; the primary shared-host measurements below used uid 1000.

## Results

A survivor is a tagged live `codex-linux-sandbox`/`sleep 3` pair at about
400 ms after SIGTERM, after the wrapper's `exit` event. All pairs had gone
by the final 4-second observation. Counts are observations, not frequencies.

| Composition and stop boundary | Runs | Orphan pairs after wrapper exit |
| --- | ---: | ---: |
| Shared host, exec, bubblewrap present but command absent | 5 | 2 |
| Shared host, app-server, same boundary | 3 | 1 |
| Shared host, exec, actual command present | 3 | 0 |
| Private PID namespace, exec, outer launcher first observed | 11 | 0 |
| Private PID namespace, exec, bubblewrap present but command absent | 5 | 1 |
| Private PID namespace, exec, actual command present | 1 | 0 |
| Shared host, exec, experimental SDK SIGINT substitution, bubblewrap boundary | 5 | 0 |
| Shared host, exec, native registration gate, ordinary SIGTERM | 1 | 1 |
| Shared host, app-server, native registration gate, ordinary close/EOF | 1 | 1 |
| Shared host, exec, same registration gate and SDK SIGINT substitution | 1 | 1 |
| Shared host, exec, registration gate but actual command present | 1 | 0 |

Exploratory app-server outer-launcher runs were 0/3 at 400 ms, but one had
already reached the command, so they do not establish a before-command gate.
Three traced exec bubblewrap-boundary runs had no sandbox survivor; tracing
lengthened startup and altered scheduling. They are not used to claim the
race's syscall ordering in an untraced run.
Two preliminary invocations failed to observe their requested gate and
exited 1. One used the slower asynchronous process scan; the other had not
installed the native gate's config. They are excluded, not counted green.

## Native boundary evidence and limits

The temporary `LD_PRELOAD` measurement library delayed only the namespace
PID 1's `prctl(PR_SET_PDEATHSIG, SIGKILL)` by 300 ms. It wrote a readiness
marker before waiting and resumed the real call. This was deliberate timing
perturbation, not unchanged-native/default-composition evidence. It was not
installed globally, committed, or proposed for shipping. The default real
runs above independently establish the defect. The gated late control shows
the library alone did not force an orphan after a living-parent registration.

Pinned upstream Codex source
[`launcher.rs`](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/linux-sandbox/src/launcher.rs#L38)
adds `--as-pid-1` when creating a PID namespace. The
[`bubblewrap 0.9.0 registration`](https://github.com/containers/bubblewrap/blob/v0.9.0/bubblewrap.c#L374)
sets the parent-death signal without checking a retained parent lifetime.
The examined [0.13.0 source](https://github.com/containers/bubblewrap/blob/v0.13.0/bubblewrap.c#L367)
retains that shape; 0.13.0 was not built or run, so this is not a claim that
all later versions reproduce.

The [kernel interface manual](https://man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html)
states that parent death preceding registration is not replayed and that
fork clears the binding. The [PID namespace manual](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html)
explains why a namespace init sees `getppid()==0` for its outside parent and
why an unhandled SIGTERM cannot be relied on to stop it. These rules and the
gated contrast support the missed-registration explanation; an untraced
syscall-by-syscall capture of either natural orphan was not obtained.

Two small real OS probes passed (exit 0): a descriptor referring to the
parent process (`pidfd`) and a parent-only lifetime pipe both became ready
on parent exit across a new PID namespace. Before and after exit the child
was PID 1, uid 1000, `getppid()==0`. The pipe returned `POLLHUP` (16); pidfd
returned `POLLIN` (1). In each probe, cutting only the readiness observation
made the same assertion fail (exit 1); no signal target changed. These verify
the proposed descriptor primitive, not a completed bubblewrap correction.

Interrupt, other operating systems, different kernels/bubblewrap builds,
privileged/setuid bubblewrap, nested intermediate branches, and production
incident frequency remain unmeasured. No maintainer issue was posted to an
external upstream repository in this phase.

## Retained artifacts, cleanup, and checks

Raw result JSON, gate markers, probe sources, captured wrapper stderr and
trace logs are retained under
`worktrees/fuji-481/tmp/fuji-481/` until the design/issue no longer needs them.
The structured JSON includes their hashes and the facts needed to assess
this result without depending on scratch. The probe-version mapping records
which disposable generator produced each group. SQLite/cache/skill fixture
contents are removed after recording their results; they are not evidence.
A final read-only scan checked all **45** captured ownership tags and found
**0** live tagged processes. The evidence checker verified raw/artifact
hashes, the principal counts, gate conditions, and final cleanup (exit 0).
Giving that checker a copy with one raw hash corrupted failed its hash
assertion (exit 1); the reviewed JSON was never mutated.

Dependency install and the protocol/core/agent-common/Codex filtered build
both exited 0. Codex's version command emitted a pre-existing temporary-home
PATH-alias warning. The offline wrapper fixtures emitted expected unknown-
auth/legacy-server/recovery warnings, not unhandled exceptions. The two
failed gate experiments and the intentionally red readiness controls are
recorded separately. No full package suite is claimed for this docs-only
research phase; its plan lists the implementation gates.
