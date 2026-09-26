# Issue #401 post-change process measurements (2026-09-26)

Run from `worktrees/fuji-401` on Linux after `pnpm -C wrapper build`.
The wrapper measurement imports that worktree's built `dist/cli.js` and
`dist/host.js`. The controller signals only the wrapper and direct-child
PIDs it launched, and removes its own `/tmp/fuji401-postchange-*` fixtures.

```sh
for n in 1 2 3; do
  FUJI401_REPO="$PWD" FUJI401_ROOT="/tmp/fuji401-final2-$n" \
    node docs/evidence/claude/issue-401/controller.mjs
done
```

| Run | Wrapper PID | Direct child PID | Wrapper at runner's 5s boundary | Child after boundary | elapsed ms | wrapperError |
|---|---:|---:|---|---|---:|---|
| 1 | 2245062 | 2245073 | gone | gone | 5151 | null |
| 2 | 2245256 | 2245267 | gone | gone | 5152 | null |
| 3 | 2245440 | 2245451 | gone | gone | 5152 | null |

All three runs emitted the pre-existing SDK
`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning. No unhandled error appeared.
The permanent negative control uses `childKillDeadlineMs: null` in
`cli_sigterm_abort_real_process.test.ts`: the direct child was alive at
5.2 seconds and died at the SDK's later escalation (test duration 7048ms).
A separate one-step mutation changed the production default deadline to
`null`; the real wrapper process test failed with exit code 1 because the
wrapper elapsed time was 7084ms, exceeding its 5000ms assertion. The
deadline was restored before the positive tests ran again (exit code 0).

The SDK-bundled native Claude CLI 2.1.280 was retested independently of the
wrapper with a local Messages API loopback and genuine Bash tool use:

```sh
cli=node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-x64@0.3.280/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude
for mode in sleep stubborn; do
  for n in 1 2 3; do
    node docs/evidence/claude/issue-401/claude-loopback.mjs "$cli" "$mode"
  done
done
```

| Mode | CLI PIDs | Tool descendant PIDs | Before CLI SIGTERM | After CLI exit |
|---|---|---|---|---|
| `sleep` | 2204093, 2204193, 2204283 | 2204173, 2204263, 2204354 | shell and child `S` in 3/3 | shell and child gone in 3/3 |
| `stubborn` | 2204374, 2204470, 2204591 | 2204444, 2204540, 2204663 | shell and child `S` in 3/3 | shell gone; SIGTERM-ignoring child `S` in 3/3 |

All six runs exited with code 143, observed Bash result code 137, and had
empty stderr tails. The loopback controller cleaned up each recorded
surviving descendant by its exact PID. This supports only the direct-child
bound; arbitrary tool descendants remain outside it. macOS seatbelt was
not measured because no macOS execution host was available.

Final source gates: `pnpm -C wrapper typecheck`, `pnpm -C wrapper build`,
`pnpm -C wrapper test`, `pnpm -C runner typecheck`, and `pnpm -C runner test`
all exited 0. The wrapper suite passed core 267, agent-common 371,
Claude 518, Codex 814, and Antigravity 386 tests (2 Antigravity skips).
The runner suite passed 740 tests. Neither suite reported an unhandled
error. Claude tests emitted the existing
`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning; the Codex startup-timeout
fixture also logged its expected failed MCP handshake while its test passed.
