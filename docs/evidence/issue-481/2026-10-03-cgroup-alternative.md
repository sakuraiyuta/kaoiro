---
title: "Codex sandbox close: cgroup alternative measurements"
status: measured
last_updated: 2026-10-03
---

# Codex sandbox close: cgroup alternative measurements — 2026-10-03 JST

For [issue #481](https://github.com/sakuraiyuta/kaoiro/issues/481). The
[evaluation](../../plans/issue-481-cgroup-alternative.md) compares A/B/C.
The [structured capture](2026-10-03-cgroup-alternative.json) contains sixteen
final native runs, raw hashes, exact unit identities, retained generator
hashes, tool invocation exits and capability/lifecycle controls. The previous
[native measurements](2026-10-03-sandbox-close.md) and their two companion
artifacts were not modified.

## Composition and ownership

The built production `runCodexCli`, default Host/session/transport, patched
SDK and real Codex 0.159.3 binary are unchanged from baseline
`36a5b2bd332cd0fc69b5cd865f0dd74af85dc8f2`. Product source is still based on
`2b221fffc51be8c5645276efcb442198cc7ce78a`. Built/native hashes match the
earlier evidence, including native SHA-256
`8bf204b36a2f6dd0dab73aa2f639892e67ef9ac8befccb4a05b1496ebf25c479`.
This is real native execution with an offline Responses provider and Phoenix
handshake fixture, not an account-backed model request. No account identifiers
or credentials are included.

Each run used an isolated HOME/CODEX_HOME and a unique ownership tag. The
provider requested the real native `exec_command` for finite `sleep 3`.
The temporary native registration gate was the earlier PID-1-only `prctl`
interposer with its pause increased to two seconds. It marks the point before
parent-death registration and resumes the real syscall; it does not signal
or repair a process. This deliberately widens the known race and is not an
estimate of its natural frequency. The gate marker and absence of the actual
command were required before close.

The controller ran inside the actual production runner's cgroup. Each
`systemd-run --user` invocation created a uniquely named `fuji-481-<uuid>`
scope or service. Before action, the probe checked `Transient=yes`, its
InvocationID and its distinct ControlGroup. All systemctl stop/kill actions
addressed those exact own units. No production unit was stopped or changed.
The proxy-only contrast signalled only its held, positive own child PID.
Process-table/cgroup/PID-namespace observations were read-only; no discovered
descendant PID was selected for a signal.

Services used `Type=exec`, `--pipe --wait`, `KillMode=mixed`,
`SendSIGKILL=yes`, explicit working directory and a small credential-free
environment. Scopes used `KillMode=control-group`. Both had
`TimeoutStopSec=1s`, `RuntimeMaxSec=12s` and collection enabled. Those are
experimental bounds. Native invocations had an outer `timeout 45`; the
small unit/container controls had `timeout 20–45`.

For the scope and ordinary service cases, a marker requested that the wrapper
emit its normal SIGTERM event into the existing production close handler;
Host/session constructors were not replaced or injected. The scope controller
waited for both the wrapper's exit receipt and `systemd-run` exit 0 before
checking the orphan and stopping its unit. Separate service cases delivered
a real OS SIGTERM through `systemctl --user kill --kill-whom=main`.

## Final results

| Case | Exec | App-server | Observation |
| --- | --- | --- | --- |
| Early close, wait for wrapper exit, explicitly stop its scope | 3/3 pass | 3/3 pass | One orphaned namespace PID 1 was positively present before each stop; zero tagged processes afterward. Counts include the restored controls. |
| Early close, service automatically retires when wrapper main exits | 2/2 pass | 2/2 pass | Wrapper and proxy exit 0; zero tagged processes after service retirement. |
| Real SIGTERM to service main, same early gate | 2/2 pass | 1/1 pass | Zero tagged processes; exec includes restoration after the proxy contrast. |
| Remove only scope stop | 1/1 red | 1/1 red | Wrapper and proxy exited 0; one live orphaned namespace PID 1 remained. Survivor assertion failed, invocation exit 1. |
| Signal only service launch proxy PID | 1/1 red | Not run | Proxy exited by SIGTERM; six tagged processes, including wrapper/native/sandbox, remained. Survivor assertion failed, invocation exit 1. |

Thus thirteen native containment cases passed and three deliberate negative
cases failed. Each expected positive invocation exited 0, each negative
invocation exited 1, and restoration passed. Scope stops completed in
**1083.6–1200.3 ms** across the six final cases, consistent with the one-second
SIGKILL escalation; they completed before the two-second gate resumed command
execution. The namespace child had a different session and an outside parent,
but stayed in the same dedicated cgroup.

A separate own-parent/own-child service test measured runner-owner lifetime.
With `BindsTo=<own-parent>` and `After=<own-parent>`, parent stop made the child
inactive (exit 0). Removing only `BindsTo`, retaining `After`, left it active
and failed the assertion (exit 1). Restoring the property passed (exit 0).
All those exact own units were stopped and verified inactive in cleanup.
This validates the dependency primitive, not a production-runner restart with
a live native sandbox.

Preliminary 300 ms gate trials are excluded from the final table. When the
probe was tightened to wait for completed wrapper close, two scope-stop
invocations exited 1 because their unit had already emptied and unloaded;
they had no remaining descendants. A negative trial also missed the race.
The gate was widened and the final runs regenerated. Preliminary logs and
the corresponding generator versions remain in scratch; those earlier
results do not support the final guarantee.

## Host and unsupported-environment observations

- Linux WSL2 kernel `6.18.33.1-microsoft-standard-WSL2`, systemd
  `255.4-1ubuntu8.17`, unified cgroup v2. Production runner remained active
  with MainPID `3806914`, `KillMode=control-group`, `Delegate=no`.
- Its cgroup and the new units were siblings below the user manager's
  `app.slice`. No production delegation change was needed for unit creation.
  `Delegate=no` did not make the same-user directory or migration files
  unwritable: permission checks found them writable. No cgroup write or
  attempted escape was performed.
- With a deliberately absent private user-bus socket, `systemd-run --user`
  returned 1 and the requested command's marker was never created. The
  capability assertion itself passed; there was no silent plain-spawn fallback.
- Two own, unprivileged, network-disabled Docker containers using existing
  `node:22-slim` image ID
  `sha256:6e6261159fd399ebe5a3d556b7d89da9c85c873f3f270918aad6c8107da8b411`
  lacked `systemd-run` (`ENOENT`) and had a read-only cgroup v2 mount, both
  with and without a read-only root filesystem. Both capability probes exited
  0, and `--rm` removed their own container IDs. No container/image owned by
  another task was changed. This did not run a full runner or native Codex
  inside Docker.

The measured parent service was not the production runner. macOS, a container
with its own functioning user manager, a direct delegated-cgroup helper,
cgroup v1, older systemd releases, runner restart with a native sandbox and
operator interrupt remain unmeasured. Membership retention through the
observed `setsid`/PID namespace is not evidence against deliberate migration.

## Interpretation sources

[systemd.scope v255](https://github.com/systemd/systemd/blob/v255/man/systemd.scope.xml)
defines scope lifetime by any remaining process, while
[systemd.service v255](https://github.com/systemd/systemd/blob/v255/man/systemd.service.xml)
defines default `ExitType=main`.
[systemd.kill v255](https://github.com/systemd/systemd/blob/v255/man/systemd.kill.xml)
defines mixed-mode main SIGTERM and remaining-group SIGKILL, and
[systemd.unit v255](https://github.com/systemd/systemd/blob/v255/man/systemd.unit.xml)
defines `BindsTo` with `After`.
[systemd-run v255](https://github.com/systemd/systemd/blob/v255/man/systemd-run.xml)
distinguishes scope environment inheritance from service-manager execution.
These sources were opened at the version matching this host.

The [kernel cgroup v2 interface](https://docs.kernel.org/admin-guide/cgroup-v2.html)
defines fork inheritance, migration permissions, populated state and
`cgroup.kill`; the delegated-helper alternative is an inference from that
interface, not a measured implementation. Docker environments with additional
manager/delegation setup are conditional deployment possibilities.
[Apple's launchd guide](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
describes that platform's service manager; no equivalent namespace containment
claim is inferred from it. kaoiro's own
[installation reference](../../operations/runner-install.md#macos-launchd-launchagent)
also marks macOS service orchestration unverified.

## Checks and retained material

The disposable checker verified executed artifact hashes, retained generator
hashes, raw capture/log hashes, gate observations, positive/negative survivor
assertions, exact cgroup membership, own-unit retirement, container removal
and result counts (exit 0). Corrupting one raw capture hash in a copy failed
that check (exit 1); checking the intact final artifact again passed (exit 0).
No product typecheck/build/full suite was run for these documentation-only
changes; the already built production/native artifacts were unchanged.

Final read-only observation found **zero survivors across 25 current and
exploratory ownership tags**, and `systemctl --user list-units fuji-481-*`
returned no loaded own units. The previous forty-five capture tags and
artifact hashes are retained by the earlier investigation. Large fixture
homes were trimmed after termination; raw results, close/gate receipts,
scripts, shared libraries and logs remain at
`worktrees/fuji-481/tmp/fuji-481/cgroup/` for review until issue close.
