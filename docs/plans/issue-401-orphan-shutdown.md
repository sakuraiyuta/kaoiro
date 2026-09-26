---
title: Bound Claude CLI shutdown before runner reset escalation
status: approved
last_updated: 2026-09-26
---

# Bound Claude CLI shutdown before runner reset escalation

## Problem and measured evidence

Issue [#401](https://github.com/sakuraiyuta/kaoiro/issues/401) separates three
risks left after [#391](https://github.com/sakuraiyuta/kaoiro/issues/391).
`runClaudeCli` handles `SIGTERM` by closing `AgentHost`; the host aborts the
SDK Query. In the installed `@anthropic-ai/claude-agent-sdk` 0.3.280,
`ProcessTransport.close()` waits about 2 seconds before `SIGTERM` and another
5 seconds before `SIGKILL`. Runner reset kills the wrapper after 5 seconds.
An external controller also applied `SIGKILL` to the recorded direct child
4 seconds after wrapper `SIGTERM`: wrapper and child were both gone by the
5-second boundary in 3/3 runs. That is a feasibility check for the proposed
deadline, not proof of the as-yet-unimplemented host wiring.

| Item | Measurement on this Linux host | Decision |
| --- | --- | --- |
| Claude CLI child ignores stdin EOF and `SIGTERM` | A real `runClaudeCli` wrapper, real SDK transport, and PID-recording CLI fixture were driven through runner's exact 5-second `SIGTERM`/`SIGKILL` sequence. In 3/3 runs the wrapper and child were both alive at the 5-second boundary; the child remained alive after wrapper `SIGKILL` (elapsed 5153–5156 ms). The controller then killed only the exact fixture PID it had spawned. | Close with a wrapper-owned child handle and an earlier `SIGKILL` deadline. |
| Claude CLI Bash-tool descendants | The SDK's native Claude CLI 2.1.280 was run against a loopback Messages API that returned a genuine Bash `tool_use`. Just before CLI `SIGTERM`, the shell and its child were alive in all runs. With a normal `sleep 90`, shell and sleep were gone after CLI exit in 3/3 runs. With a Node child that handled and ignored `SIGTERM`, the shell was gone but the Node descendant remained alive in 3/3 runs. The controller killed only the recorded descendant PID after observation. | Accept as a documented limit for arbitrary tool descendants; the SDK's direct-child handle cannot identify or safely reap processes spawned by the tool. |
| Codex tool descendants on macOS | The prior Linux loopback experiment in #391 saw `codex exec` and `sleep 77` both exit within about 50 ms after `SIGTERM` in `workspace-write` and `danger-full-access` (2/2 each). This host is Linux (`uname -s`); it cannot execute the macOS seatbelt path. The director confirmed that no macOS execution host is available. | Accept the platform measurement gap as a named limit outside this delivery's judgment. Linux behavior does not establish a macOS result. |

The Bash experiment deliberately used the SDK's native CLI rather than a
stand-in process. Its mock server sent a single streaming Bash tool call; the
CLI emitted a `tool_result` with exit code 137 when it handled `SIGTERM`.
The results describe native CLI 2.1.280 on Linux, not every CLI version or
every descendant type. All signaled PIDs were recorded from processes started
by the experiment; no process-name selection or process-group signaling was
used. The measurement harnesses are
[`controller.mjs`](../evidence/claude/issue-401/controller.mjs),
[`wrapper.mjs`](../evidence/claude/issue-401/wrapper.mjs), and
[`claude-loopback.mjs`](../evidence/claude/issue-401/claude-loopback.mjs).

## Reproduction commands and observations

Run from this worktree after `pnpm install --frozen-lockfile` and
`pnpm -C wrapper build`. The controller starts a real `runClaudeCli` process
with a real SDK transport and an EOF/SIGTERM-ignoring CLI fixture. It sends
`SIGTERM` to that wrapper's recorded PID, then applies runner's 5-second
`SIGKILL` boundary. `FUJI401_ROOT` is a disposable path that the controller
removes. The two examples below are the negative and proposed-deadline
feasibility controls; the latter sends `SIGKILL` to the recorded direct child
after 4 seconds from the controller, so it does not claim production wiring.

```sh
FUJI401_REPO="$PWD" FUJI401_ROOT=/tmp/fuji401-orphan-measure/repro-base \
  node docs/evidence/claude/issue-401/controller.mjs
FUJI401_REPO="$PWD" FUJI401_ROOT=/tmp/fuji401-orphan-measure/repro-kill4 \
  FUJI401_DIRECT_KILL_MS=4000 \
  node docs/evidence/claude/issue-401/controller.mjs
```

The current harness's baseline three runs returned `wrapperAtGrace="S"` and
`childAfterReset="S"`, with elapsed times 5156, 5155, and 5152 ms
(wrapper PIDs 2193446, 2193481, 2193518; direct-child PIDs 2193457,
2193492, 2193529).
The 4-second direct-child control returned `"gone"` for both states in
3/3 runs (5152, 5152, and 5151 ms at the 5-second observation point;
wrapper PIDs 2193692, 2193860, 2193943; direct-child PIDs 2193703,
2193871, 2193954).
The baseline also emitted the installed SDK's existing
`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning; `wrapperError` was null in all
six runs. The controller cleaned up its own exact recorded PIDs.

The second harness starts the SDK-bundled native Claude CLI 2.1.280 in an
isolated temporary cwd/config, serves a streaming Bash `tool_use` from a
local-only Messages API, and sends `SIGTERM` to the CLI's recorded PID after
the tool shell and child have both appeared. It observes both PIDs through
`/proc` and then cleans up any survivor by exact recorded PID. `sleep` is the
cooperative child; `stubborn` is a Node child that ignores `SIGTERM`.

```sh
cli=node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-x64@0.3.280/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude
for mode in sleep stubborn; do
  for run in 1 2 3; do
    node docs/evidence/claude/issue-401/claude-loopback.mjs "$cli" "$mode"
  done
done
```

All six native CLI runs returned `shellSeen=true`, `beforeSignal` states
`S/S`, CLI exit code 143, and a Bash tool result with exit code 137. The
shell was gone in all six. In the `sleep` mode its child was gone in 3/3;
in the `stubborn` mode its child was still `S` in 3/3. The current
harness recorded CLI PIDs 2194007, 2194108, 2194199, 2194289, 2194397,
2194493 and descendant PIDs 2194088, 2194179, 2194269, 2194359,
2194467, 2194563 in that order. No external API call or process-group
signal was used. After adding an executable-existence precheck to the
harness, one further `sleep`/`stubborn` pair repeated the two outcomes
(CLI PIDs 2194966/2195066; descendants 2195046/2195136).

## Options and choice

For the direct Claude child, increasing runner's reset grace to more than the
SDK's seven seconds would slow every reset and still couple our guarantee to
the SDK's private timer sequence. Killing a process group could terminate
unrelated processes unless the CLI and every descendant were deliberately
isolated; the native CLI experiment shows a stubborn tool descendant can
outlive its shell, and no cross-platform group contract is available here.

Use the SDK's public `Options.spawnClaudeCodeProcess` hook to hold the direct
CLI `SpawnedProcess`. Preserve the SDK's `SpawnOptions` command, arguments,
working directory, environment, and delayed abort signal. On the host's own
abort (`AgentHost.#abort`, not the SDK's forwarded signal), arm a single
4-second `SIGKILL` deadline for that exact child. Keep this timer **ref'ed**:
otherwise the wrapper can exit before it fires, and the SDK's process-exit
handler sends only `SIGTERM` to the orphan. Clear the timer on child exit.
An uncooperative child can therefore keep the wrapper alive for up to four
seconds after host close; this is within runner reset's five-second grace.
Expose `AgentHostOptions.childKillDeadlineMs` with default 4000 and `null`
to disable only this extra deadline in tests. The SDK retains its stdin EOF
and approximately 2-second `SIGTERM` opportunity; our deadline only advances
the final escalation to before runner's 5-second reset boundary. Do not call `process.exit()` or
create an operator `interrupted` settlement. Guard repeated `close()` calls
and a child that has already exited. Account for `ChildProcess.killed` meaning
"signal sent," not "exit observed"; use exit code/signal or an exit event
for the final liveness decision.

The SDK's default local spawner drains stderr and retains a 2 KiB tail for
exit errors, and delays its exit event until stderr closes (with a 200 ms
grace); a custom spawner emits plain process exit. The replacement
must drain stderr to avoid backpressure, relay a caller-supplied stderr
callback when present, and keep a bounded, redacted diagnostic path for
unexpected child exits. It must leave ordinary stdout/stdin and query event
delivery unchanged. Keep the existing caller-supplied spawner seam usable in
tests; production currently supplies none. Custom spawning also stops the
SDK's environment-derived automatic `--debug-file` argument. Kaoiro does
not use that argument, so accept the difference. The default spawner checks
the executable before spawning; custom spawning instead reports an absent
binary as a spawn error. Preserve the `spawn_failed` classification while
allowing the error wording to differ.

For tool descendants, do not claim the direct-child fix contains them.
Process-group killing or an OS-specific job/cgroup could be a separate
containment project with an ownership and cross-platform design. This issue
will state the measured `SIGTERM`-ignoring descendant limit in the engine
contract. For Codex macOS, do not generalize the Linux result or change Codex
code without a macOS measurement. This delivery accepts the absence of a
macOS host as a named verification limit, not as evidence of safe behavior.

## Scope

Change the Claude host's production Query spawn and shutdown path, focused
real-SDK tests, and engine process-termination documentation. Runner's
5-second reset policy, Codex, Antigravity, permission behavior, and the
Claude probe child are outside the code change. The existing probe client
already owns a separate SIGTERM-to-SIGKILL escalation; it is not the
long-lived production Query child measured here.

## Verification

- Through a real `runClaudeCli` process and real SDK transport, start a CLI
  fixture that ignores EOF and `SIGTERM`, send wrapper `SIGTERM`, apply the
  runner's 5-second reset sequence, and assert the direct CLI PID is gone
  before wrapper reset completion. Confirm the wrapper settles without an
  unhandled error. Retain a cooperative fixture to prove the SDK's graceful
  opportunity remains intact.
- Keep a permanent process-boundary negative control using
  `childKillDeadlineMs: null`: at the runner's five-second boundary the
  direct child must still be alive. Separately disconnect the production
  deadline in a one-step mutation check, require the corresponding positive
  test to fail, and restore it. Also test that a child that exits early
  receives no late `SIGKILL`, and that stderr is consumed without exposing
  raw text through the wrapper's error channel.
- Pin the installed SDK's ordering: a cooperative child must exit by
  `SIGTERM`, before the host's four-second kill deadline; the custom spawner's
  `SpawnOptions.signal` must abort after host abort, approximately 1.5–4
  seconds later. Assert that a late `ChildProcess.kill("SIGKILL")` call on an
  already-exited child does not throw. These checks make an SDK upgrade that
  changes the shutdown assumptions visible in CI.
- Repeat the native CLI loopback Bash experiment after the change. Expect
  normal `sleep` to terminate and the signal-ignoring descendant to remain;
  document this accepted limit rather than misreporting a direct-child test
  as a subtree guarantee. If a macOS runner becomes available, run the Codex
  loopback experiment in both sandbox modes with recorded direct PIDs.
- Run `pnpm typecheck` and `pnpm test` for the affected Claude wrapper
  package, then the full wrapper and runner suites, recording each exit code
  and any unhandled errors or warnings. Rebuild current artifacts before the
  production-path measurements. The new guard and its test wiring get a
  one-step mutation check.

## Documentation

Update `docs/reference/engines/adapter-contract.md` and
`docs/reference/engines/claude-events.md` with the direct-child bound and
measured descendant limit. Put exact post-change commands, SDK/CLI versions,
PIDs, timings, negative controls, and platform boundary in a dated
`docs/evidence/` record. Record the accepted descendant and unverified
macOS limits in issue #401 when closing the items that can be closed.
