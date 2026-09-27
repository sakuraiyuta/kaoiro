---
title: Wrapper input markup classification probe
status: preliminary
last_updated: 2026-09-28
---

# Wrapper input markup classification probe

The native `sendmsg-open2` run used the built Claude Code host from commit
`edd3e491` with SDK 0.3.280 and bundled CLI 2.1.280. Its first ordinary wrapper
input asked a background Agent to send a progress note containing the literal
`<agent-message>` string. The host failed admission before any child message
arrived. This is a counterexample to the [accepted admission rule](../../plans/issue-426-agent-handback-admission.md#exact-prompt-and-owner-decision)
that markup inside an exact wrapper input does not by itself become a foreign
SDK continuation.

## Exact input comparison

| Surface | Observed value |
| --- | --- |
| Driver's `sendMessageOpenerInstruction` argument to `runClaudeCli` | 536 UTF-8 bytes, SHA-256 `d92cb572fa0f2a5628e274bdb977e216bf4d6593fa1ea39d8cb0eb6d771efb16` |
| CLI root transcript, user entry line 4, `promptSource=sdk` | Same 536 bytes and SHA-256 |
| `UserPromptSubmit` hook's `prompt`, `prompt_id=b44d2bb8-2a20-462c-92e3-09d5341ac9ff` | Same 536 bytes and SHA-256 |

The driver string, transcript content, and complete hook prompt compare equal
byte for byte. The hook recorder did not truncate this mode's prompt. The
transcript establishes the content the CLI received; `AgentHost.#input()` yields
the queued `SDKUserMessage` without changing its content unless `prepareInput`
supplies replacement text (`host.ts:4222-4250`). This run supplied no such
replacement. No trim, escaping, or newline change explains the failure.

The trace contains one root prompt, a `task_started` frame, and result index 0
with `session_id=3d5a52d0-c0a5-4383-8860-e64c913bd666` and no `origin`.
There was no child `SubagentHandback` or `SendMessage` hook before that result.
The host emitted `notification result ownership ambiguous` and one admission
fail-stop instead of settling the ordinary wrapper turn.

## Host path and existing control

The quoted markup makes `handbackShape` true through substring fallback
(`host.ts:2131-2132`). Before the exact wrapper match is admitted, the host adds
the live prompt ID to `unresolvedForeignPromptIds` (`host.ts:2150-2152`). The
wrapper-match branch records its owner but does not remove that ID
(`host.ts:2153-2156`). The originless result therefore reaches the foreign-ID
fail-stop (`host.ts:2587-2589`). The input and hook bytes are equal, so this is
a host classification error, not a CLI text transformation.

The focused test named `keeps an existing wrapper owner and taints a changed
hand-back` (`test/handback_admission.test.ts:340-369`) yields plain `launch` as
the wrapper input. It then injects a *separate* changed hand-back prompt with
the same prompt ID and checks that a later tool call is unbound. That control
pins rejection of a forged continuation, but does not put markup in the
wrapper input itself. No focused test currently pins the plan's gate 4(h)
exact-wrapper-input case.

## Raw artifacts

| Artifact | SHA-256 |
| --- | --- |
| `tmp/fuji-426/native-sendmsg-open2-events.jsonl` | `584ad59da13ba127650fd129ed0c65b4f6337ad49a1b6060caa3c230b5fbf74e` |
| `tmp/fuji-426/native-sendmsg-open2.stdout` | `50dddcc0820e9f574d254c6c41d82a37caa8b0fea0dc9158baf2fb62d9274212` |
| `tmp/fuji-426/native-sendmsg-open2.stderr` | `a2a1cf75093a9186b5482968386f9e288109f0c37c5c910081a517db5e8ae27e` |
| `~/.claude/projects/-home-yuta-git-kaoiro-tmp-fuji-426-native-cwd/3d5a52d0-c0a5-4383-8860-e64c913bd666.jsonl` | `31d49878ff6a97edbdc4ebb222726c153f589624b35a3e47fcba465267c38388` |
| `tmp/fuji-426/native-run.mjs` | `b7f5a17286f17d88ff85098d3889c3f82b654937dac8b6261feb53e0e87c2fab` |

The first `sendmsg-open1` attempt did not reach root startup: the loopback
server had stopped, and peer join timed out. It is not evidence about prompt
classification. The server was restarted for `sendmsg-open2`.
