# External engine startup and declaration checks

The runner bundle built from
`4bb56e8d3ca2c9b6cec9b8e1fd054bc7be137892` had SHA-256
`17f3d053df1cfc179faba50f5000266af45cc6e07e2eaf510ac39eb106fa239f`.
All six [CI jobs](https://github.com/sakuraiyuta/kaoiro/actions/runs/44867190400)
passed on this commit.

The installed and direct-checkout layouts passed the startup check in
[the release runbook](../operations/high-risk-change-release.md) using a
disposable install root and configuration. The source configuration listed
16 external commands. With only Claude Code selected, neither layout ran an
external command. Selecting one of the same commands in a normal start
produced its execution marker. An early exit failed the check. Malformed
configuration exited with status 1 and a retained identity mismatch with 78.

The packaged runner accepted a 16,384-byte declaration and rejected a
16,385-byte declaration. Invalid UTF-8 had its own diagnostic. Malformed
JSON, a nonzero exit, unsupported operations, unexpected keys, duplicate
models and inconsistent effort defaults excluded the affected engine.
A 32-model catalog passed and a 33-model catalog was rejected.

Separate startup runs recorded the owned child PIDs on timeout, excess
output and a leader exiting while its child retained stdout. Each group
was reaped. Interrupting discovery with SIGINT or SIGTERM stopped the runner
before registration. These checks used loopback and disposable credentials.

## Registration, restore and rollback

The packaged entry from `e86712e0f1ecf82e4b7fea6d6cdfcc8b445e1a8b`
had SHA-256 `34802e5be957a251733e3858ac5ea49a2792fc6d07a316e3ba955f67693fbd3a`.
Both startup layouts passed on this candidate. Its complete runner suite
passed 1,952 tests and skipped one native test. Nine isolated mutations
each failed the focused suite; the original and restored controls each
passed 25 checks. All six [CI jobs][candidate-ci] succeeded.

The comparison used the old receiver at `f39e4ca9`, the B-capable
receiver at `ccb257d9`, the old runner at `55e4f710` and the candidate.
Each receiver was started from its Phoenix entry. Connect an operator and
a runner to loopback, register the host and read its broadcast catalog.
Repeat with no external rows, a valid row, and a valid row plus a missing
executable.

| Receiver | Built-in registration | Mixed registration |
|---|---|---|
| Old | Four catalogs and delivery defaults matched; four enumeration replies and a cwd reload succeeded. | Both configurations registered. External spawn was refused; Grok enumeration succeeded. A register with external delivery defaults was refused. |
| B-capable | The old and new runner matched on the same checks. | The valid row handled a challenge and the absent executable was isolated. Another host without the declaration rejected spawn. |

On the B-capable receiver, stop a spawn-only external agent with no saved
session ID. Restore it by ID and send a fresh random instruction. The new
process handled the instruction under the original ID and a new transition.
A batch of two per-ID restores covered a saved model/effort pair and empty
picks. With the same store, the old receiver refused external restore and
relayed restore of an existing Grok session. Switching back allowed the
original external ID to handle another instruction.

For 12 failures of one external entry, the other entry completed a turn and
the built-in Grok engine answered enumeration. These cases covered missing
or non-executable commands, empty or NUL program names, exit failure, timeout,
oversize output, invalid JSON, version, ID, operations and models. Editing the
commands and working-directory allowlist together applied the directory change
but retained the original external commands. Restart selected the replacement
program. A remaining legacy capability string without a declaration could
not launch a child.

The receiver accepted a register whose Erlang external size was exactly
65,536 bytes and refused 65,537 bytes. With 17 external rows, the implicit
capability set registered the four built-ins and the first 16 external IDs.
An explicit list of 17 capabilities was rejected at startup. A declared row
too large for the runner's estimated register budget was omitted from both
capabilities and catalog. A smaller later row still launched. Other controls
covered reserved and duplicate IDs, UTF-8 split inside a multibyte character,
256-byte model values and display names, and 64-byte effort values.

## Real peer exchange

A standalone JavaScript program supplied its own declaration and joined the
wrapper channel using only the launch file. Its first instruction contained a
fresh challenge. A normal inter-agent request to a bundled Codex agent
required the reversed challenge in turn 2 of the same conversation. Success
required receiving the reply in the original external process. With Codex
stopped, the external process received the request instruction but recorded
no matching reply in the 3.5-second observation window.

One of three live candidate exchanges succeeded. In both unsuccessful
attempts the request reached the recipient's Codex session. In one it made
no tool call; in the other it looked up tools and returned the correct
answer in assistant text. Neither called the send tool before completing
the turn. The 120-second receive deadline expired after both turns had
already ended. As a control, the same sender, server, native binary and
measurement program exchanged valid replies with both the pre-change and
candidate bundled Codex runners. This measures an actual exchange, without
a guarantee that the model will follow a tool-use instruction on every turn.

The server's Codex-work observation identified the same runner owner, process,
instance and Codex child before and after the external process ran. During
the overlap, the wire reported unavailable and the server returned
`invalid_runner_observation`.

[candidate-ci]: https://github.com/sakuraiyuta/kaoiro/actions/runs/44868594143
