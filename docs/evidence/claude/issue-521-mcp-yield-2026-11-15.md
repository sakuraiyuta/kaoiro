---
title: Claude root MCP results across a director yield
status: measured
last_updated: 2026-11-15
---

# Claude root MCP results across a director yield

[Issue 521](https://github.com/sakuraiyuta/kaoiro/issues/521) restores the
root MCP completion boundary described in [delivery](../../reference/inter-agent/delivery.md).
The pre-fix baseline `52c63e202897f041976d5431b53f2c7ffdc2467f`
reproduces the interrupted result for a waiting send. Its normal SDK-result
boundary control retains the reply.

The native regressions use `runClaudeCli`, the real Host/ServerLink, SDK MCP
registration, and native Agent SDK 0.3.321 / Claude Code 2.1.321, with
`claude-haiku-4-5-20251001` as model ID. Phoenix and Messages API endpoints
are disposable loopback peers. Paid inference calls are zero. The stdio
case also runs an external MCP process. No production service is involved.

| Native condition | Observed result |
|---|---|
| Running send, director yield, delayed peer reply | One outbound send; completed SDK callback; reply retained as the call's tool result; one cut |
| Permission wait, yield, late allow | No send or handler; definite permission-aborted result; one cut |
| Approval without yield | One send; normal reply tool result |
| External stdio slow call plus a second permission wait | Slow handler starts/completes once; second external handler never starts and receives permission-aborted result; one cut |
| Running send with execution fence removed | Regression fails: interrupted/indefinite tool result returns |

These observations distinguish a wrapper send from final callback completion
and actual model input. They do not establish delivery through a real OTP
server to another live agent, or model retry decisions. A user-added
PreToolUse hook deliberately waiting for the same cut can form a dependency
cycle; this probe does not add a general hook-dependency resolver. Existing
operator interruption and inactivity-watchdog behavior remain available.

The source identity measured by the focused regressions is:

| Source | SHA-256 |
|---|---|
| `wrapper/claude-code/src/host.ts` | `bc5adb04cf43db88141ee98f02d71a27a7a7ff5dc3c7cc04867b20e083a84c22` |
| `wrapper/claude-code/src/cli.ts` | `cea88974909ac31b29f27b859ef825113febbac605d8e62a001cc963ac9c4176` |

Reproduce with `pnpm exec vitest run test/cli_mcp_yield_native.test.ts` in
`wrapper/claude-code` after building workspace runtime assets. Use the
repository's test isolation environment and normal candidate CI procedure.
The adjacent host/composition regressions cover reservation liveness,
parallel calls, permission exclusion, result-boundary wakeup, receipt
expiry, and queued early input. Targeted mutations check the corresponding
regressions; redundant fast paths and cleanup are distinguished in the
implementation review record. The intentional leaked-old-reservation
control still permits the next owner's fold and yield.
