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
