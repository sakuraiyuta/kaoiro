---
title: "Codex sandbox lifetime: cgroup alternative evaluation"
status: evaluated
last_updated: 2026-10-03
---

# Codex sandbox lifetime: cgroup alternative evaluation

For [issue #481](https://github.com/sakuraiyuta/kaoiro/issues/481), following
the director's request to compare a kaoiro-owned cgroup solution (C) with
upstream adoption (A) and an isolated patched native dependency (B).
Baseline: `36a5b2bd332cd0fc69b5cd865f0dd74af85dc8f2`; product source remains
at `2b221fffc51be8c5645276efcb442198cc7ce78a`.
The [native proposal](issue-481-sandbox-startup-lifetime.md) is unchanged.
This evaluation does not select an implementation. See the
[measurements](../evidence/issue-481/2026-10-03-cgroup-alternative.md).

## Finding

**C works on the current Linux/systemd user-service host.** In the controlled
before-command close, a dedicated scope's explicit stop removed the already
orphaned namespace child in 3/3 exec and 3/3 app-server runs, including the
restored controls. A dedicated service with `Type=exec`, default
`ExitType=main`, `KillMode=mixed`, and `SendSIGKILL=yes` automatically removed
the remaining sandbox when its wrapper exited: 2/2 per backend. Real SIGTERM
to the service's main process also passed, including a restored exec control.
These are bounded containment measurements, not production incident rates.

A scope alone is insufficient. Removing its stop made the survivor assertion
fail for each backend. Killing only the spawned `systemd-run --pipe --wait`
proxy left six tagged processes alive, including the wrapper. A runner
adapter therefore cannot retain its current direct-child kill contract merely
by changing the executable to `systemd-run`.

`setsid()` and the measured bubblewrap PID namespace did not change the
children's cgroup membership. However, C is a lifecycle mechanism, **not a
guarantee against deliberate cgroup migration or use of a service-manager
socket**. The host's same-user cgroup directory and migration files were
writable in read-only permission checks, despite `Delegate=no` on the runner.
No migration or production-cgroup write was attempted. The
[kernel documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html#delegation-containment)
defines migration permissions separately from fork inheritance.

## Candidate C boundary and integration requirements

Prefer a **Codex wrapper lifetime** service, rather than a unit per exec turn.
Exec starts a native process per turn; ending such a service at normal turn
completion could terminate work intended to continue within the session.
One service per wrapper also covers its app-server and startup telemetry
children. The following requirements need a separate implementation design:

- Start the wrapper in its unit before it can start native children. Use
  unique generation names and retain the exact unit/InvocationID. Do not
  recover ownership by matching agent names, process tables, or unit prefixes.
- Forward the selected Node executable, release paths, working directory,
  stdio and required environment explicitly. A transient service is created
  by the user manager and does not inherit the caller's environment; a scope
  does. Keep secrets out of helper command-line arguments. The measurement
  used only a small credential-free environment and isolated tool homes.
- Adapt `makeLauncher`/`ManagedChild` and supervisor termination together.
  Queue stop during unit creation, handle creation failure, and acknowledge
  retirement only after unit termination and descendant cleanup. Proxy exit
  or wrapper main-process exit alone must not permit a replacement owner or
  premature config/tool-home removal. A SIGKILL request must address the
  exact owned unit, not just the proxy PID.
- Use main-process SIGTERM for graceful wrapper shutdown, then group SIGKILL
  for remaining children. Choose a stop deadline compatible with the
  supervisor's reset grace. The probes' one-second stop deadline and
  twelve-second `RuntimeMaxSec` are experimental bounds, not proposed session
  limits. Do not kill the shared runner service to reset one agent.
- Bind each wrapper unit to its owning runner service with a reviewed
  `BindsTo`/`After` relationship, or provide an equally explicit owner-lifetime
  mechanism. Newly created user units are siblings of the runner's cgroup.
  They otherwise survive the runner's termination. The own-unit test pinned
  `BindsTo`: with `After` retained, removing only `BindsTo` left the child
  active; restoring it made the child inactive after its parent stopped.
  A standalone runner needs its own owner-lifetime design rather than a
  hardcoded production service name.
- Specify direct wrapper CLI behavior. A runner-only launcher protects
  runner-supervised Codex wrappers; it does not cover standalone
  `kaoiro-codex` launches. Wrapper bootstrap/re-exec support would widen C.

The existing launcher is synchronous, returns a direct `ChildProcess`
adapter, and removes its config/tool home on that child's exit/error.
These are concrete integration changes, not an installation-only setting.
See `runner/src/spawn.ts` and `runner/src/supervisor.ts` at the bound baseline.

## Environment support and fallback

| Environment | Result or requirement | Fallback assessment |
| --- | --- | --- |
| Current WSL2 Linux host, runner under systemd user service | Measured working on systemd 255 and cgroup v2. User-manager transient units work without changing production `Delegate=no`. | C is available for this deployment. |
| Linux with an accessible user systemd manager, including a manually launched runner | Unit creation is plausible under the same API contract; standalone owner lifetime still needs design. | Require capability/preflight and an owner binding; not established by the production-service test alone. |
| Ordinary Docker/container runner without a user manager or delegated writable cgroup | The measured unprivileged `node:22-slim` container had no `systemd-run` and a read-only cgroup mount, with or without a read-only root filesystem. | This C launcher is unavailable. A container's one shared cgroup cannot provide per-wrapper reset. |
| Container with systemd/user bus and suitable cgroup delegation configured | Conditional possibility, not live-validated here. Manager, UID, filesystem, executable and namespace locality must match. Exposing a host user bus is not a drop-in equivalent; it can start the command on the host. | Requires an explicit container deployment design and tests. Do not silently change isolation to make C work. |
| Linux without systemd | The transient-unit implementation is unavailable. A delegated cgroup v2 helper could instead use `cgroup.kill`, but needs its own creation, pre-exec assignment, ownership, retirement and access-control design. | A second kaoiro implementation, not a free fallback. This helper was not implemented or measured. |
| macOS / launchd | Linux cgroups and this systemd implementation do not apply. kaoiro's macOS service orchestration is itself documented as unverified. | Keep the existing platform backend; do not claim C's guarantee. A launchd-specific substitute needs separate research. This Linux bubblewrap defect was not reproduced on macOS. |

A missing user bus was separately measured: unit launch exited 1 before the
requested command executed. Checking only for a `systemd-run` executable is
therefore insufficient. cgroup v1 and older systemd versions were not tested.

If C is adopted, an explicit required mode should refuse an affected Linux
Codex launch when containment cannot be established. An optional/automatic
mode may retain today's launch path with a clear unsupported/degraded result,
but then the orphan defect remains possible; it must not report the same
guarantee. The operator must choose that availability tradeoff. A native A/B
fix remains the route to the same sandbox lifetime correction on Linux hosts
without this user-manager setup. Disabling the sandbox or adding a process
discovery reaper is not a fallback proposed here.

## A/B/C cost and decision

| Dimension | A: upstream fix and release adoption | B: isolated patched native dependency | C: kaoiro-owned wrapper cgroup |
| --- | --- | --- | --- |
| Time dependency | Maintainer/release timeline; current defect remains while waiting | Can proceed after native design/provenance approval | Independent of upstream once launcher/lifecycle design is reviewed |
| kaoiro changes | Dependency selection and adoption regression | Build/distribution/selection path, native regression | Linux launcher, unit adapter, supervisor retirement, configuration/preflight, deployment and lifecycle docs |
| Continuing maintenance | Track upstream release and confirm actual selected binary | Maintain native patch, architecture builds, licences/provenance and system-vs-bundled selection | Maintain systemd API/version and environment/stdio contracts, unit ownership, stop/restart/error paths and platform fallback |
| Coverage | Native sandbox lifetime boundary for both backends and standalone launches | Same boundary if the fixed artifact is actually selected | Measured on this Linux host for both backends; runner-only integration would leave standalone launches uncovered |
| Behavior scope | Preserve the intended native monitor contract | Same intended contract, with a locally maintained artifact | Terminate every process remaining in the wrapper's cgroup, including deliberately detached background work; broader close semantics |
| Operational dependencies | Compatible upstream native artifact | Verified isolated native artifact; never replace host `/usr/bin/bwrap` globally | Accessible same-user manager and cgroup support, or a separately engineered delegated helper |

**C is a credible immediate Linux deployment option, not a portable or
zero-cost replacement for A/B.** For a near-term fix on the current host,
evaluate C's wrapper-service approach before committing to a native fork;
retain A as the long-term native correction. Choosing C accepts a larger
kaoiro supervision contract and must decide unsupported-host behavior,
standalone coverage and detached-work lifetime. No delivery-time estimate or
claim that C is cheaper than B across all supported environments is established.

Before C implementation, review that lifecycle design and require both
backends' early close, native normal completion, wrapper crash, runner
stop/restart, reset during unit creation, unit-creation failure, unsupported
environment, stale-generation ownership and actual production launcher
tests. Cut the unit stop, group cleanup and owner-lifetime connection
independently. Ownership/target-selection mutations remain fake-only;
live tests may stop only their own exact transient units. Update runner
deployment/termination and Codex lifecycle docs alongside the implementation.
