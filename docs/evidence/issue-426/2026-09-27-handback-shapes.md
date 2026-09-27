---
title: Issue 426 background Agent hand-back shapes
description: Native CLI and production transcript observations used for the admission design.
status: preliminary
last_updated: 2026-09-27
---

# Background Agent hand-back shapes

## Provenance and limits

The incident and its operator confirmation are in [issue #426](https://github.com/sakuraiyuta/kaoiro/issues/426). The production transcript at `~/.claude/projects/-home-yuta-git-kaoiro/a9769dab-2ced-4850-9aa8-208e1fed00e8.jsonl` (SHA-256 `fb68741cabd36775d2d566567595479fbfedb3712c7bdc482420de062e8c0f58`, 3,842,222 bytes) was read without mutation. It contains four background Agent task IDs. For each, one `<agent-message>` hand-back and one `<task-notification>` user input are visible. Three hand-backs preceded their notifications; for task `a26361f2e2dce1a98`, the notification at 04:00:28.910Z preceded its hand-back at 04:01:29.525Z. The transcript does not expose the host's hook `prompt_id` or prove how a future repeated notification would be represented. The issue's `unbound_tool_call` was observed in the actual-host incident; none of the local recorder probes below is an actual-host admission test.

The local runs used installed `@anthropic-ai/claude-agent-sdk` 0.3.280 (`sdk.mjs` SHA-256 `ef4c2c0fc286d8c7dab7771516cf95206f9f670e99e74dc62f245b7fc8224955`) and its bundled Claude CLI 2.1.280 (binary SHA-256 `1e08503dbdf3c2cb0d706d32f3408277388d1c76ef108673e8fe42c1b322925b`). The global `claude --version` was 2.1.281. The direct CLI runs invoked the bundled binary with `-p`, `--output-format stream-json`, `--include-hook-events`, isolated cwd, a local command hook recorder, and a local dummy MCP server. The dummy records calls but sends no inter-agent message. Command-hook settings, MCP server, and recorder script are temporary files under `tmp/fuji-426/`, bound below; they are not the production `runClaudeCli` composition. A separate minimal SDK `query()` run did not emit a hand-back in its chosen composition; that absence does not establish a CLI version boundary.

| Temporary raw log under `tmp/fuji-426/` | SHA-256 | Observed result |
| --- | --- | --- |
| `agent-mcp-r2-run.jsonl` | `332b7cf0e14d894f10381cadfc5e253c3616d4c7c5292f1824dee5140a220d46` | One Agent; root hand-back and notification hooks shared `prompt_id=2c272a05-8756-4217-8925-1442054036a0`; root MCP hook ran once. Results: index 0 without origin, index 1 with `origin.kind=peer`, `senderTaskId=a7b9caa1c6cbab6b5`, `handback=true`, and report body. Exit 0. |
| `agent-bundled-run.jsonl` | `5a2c7b8f18685d916a77020f85e2e985d14b6af1eb4cb682cfd8819986aada86` | One Agent; separate result indices 1 `peer` and 2 `task-notification` after originless index 0. Exit 0. |
| `agent-four-run.jsonl` | `01e146c4e5b895e0f1661de9ac4518dd5837ea561d1bacf6cc206c5bc8f4b5c6` | Four task starts, four child hand-backs, four root hand-back hooks and four root notification hooks, one root MCP hook. Launch and eight continuation hooks shared `prompt_id=696d9e39-33be-4eee-9922-34205ca0df39`; one originless terminal result index 0. Exit 0. This is a live-wrapper fold, not the incident's separate-prompt schedule. |
| `bash-mcp-run.jsonl` | `7c26db56581db7987c0fd77652ea6c5550b6ca2adf4e24f7fdc7b2e4c5345a88` | Background Bash control: notification hook and root MCP hook, no Agent hand-back hook. Results: originless index 0 and `task-notification` index 1. Exit 0. |
| `agent-run.jsonl` | `7b62d099bdf938f0d25cde60d2a357267b486dc8580197fbf497dc2707981d4c` | Global CLI 2.1.281 also emitted `peer` and `task-notification` results. Direct CLI only. Exit 0. |
| `native-agent-events.jsonl` | `7660dde29d43f3a1de87188eb02f5024e7f7196a605d5fa8c693686e062d963b` | Minimal SDK `query()` recorder projected one originless result and one `originKind=task-notification` result, with no hand-back. It used a different composition from the direct CLI and production wrapper. Exit 0. |
| `hook-events.jsonl` | `0d9df624f2c003cbbf51e00146b573c2b44c26bbc6e2ffdbaa0992babdd6e53f` | Appended hook records across local runs; includes exact root prompt text for the second Agent probe and child `SubagentHandback` input. |

The temporary recorder inputs were `hook-capture.py` (`613661c9e0f12d9063d45d6fd381d03ae2ab6dc20efa6f8773b3645fec756d06`), `mcp-server.mjs` (`f524af59abaa88fb13d3122471745fedc5e05c5278c9e719a8aac9dd25de0eaa`), `settings.json` (`8879485f61c37169ef2ae4e49b42bc5881901df09fce593d4d316a3e3297ad32`), and `mcp-config.json` (`baa5fd5a31a5bd28755f6a521064ad69d497e518f35920539abcb221875e375f`). `mcp-calls.jsonl` (`fb5498c96afb8cbcf9f4e236e4b5c13ebc697d112e3e2ca2908ee44b761aced9`) records one local dummy callback in each MCP probe. All hashes above were measured after the four-Agent run completed. The scratch files will be deleted after the issue work closes; this record retains the relevant event counts, identifiers, and terminal fields.

## Frame relationship

In the single-Agent run, the child `PreToolUse:SubagentHandback` hook had `agent_id=a7b9caa1c6cbab6b5` and `tool_input.message="READY"`. A root `UserPromptSubmit` then carried exactly one `<agent-message from="a7b9caa1c6cbab6b5">` envelope. Its report section was prefixed by the CLI's fixed warning, then `The report follows:\n  READY\n</agent-message>`. The task-notification hook and root MCP `PreToolUse` shared that root `prompt_id`. The SDK result `origin.kind=peer` is observed in the direct CLI output; the production transcript does not show the SDK result origin for its rejected send.

The first single-Agent run supplied a multiline child report with an empty line; the root prompt indented that empty line as `\n  \n`. Three production hand-back frames ended with that indented empty line before `</agent-message>`, while one ended after a nonempty line. This supports line-by-line two-space indentation for LF-separated report text. CRLF input, a trailing newline, a report line shaped like an envelope delimiter, and multiple `<agent-message>` envelopes were not independently measured in the local hook recorder. The admission design must reject an unmeasured rendering shape rather than normalize it by guess.

The four-Agent direct CLI result was originless because all continuations joined the still-live launching prompt. The one-Agent direct CLI result with a fresh prompt ID carried `origin.kind=peer`. These are two measured terminal shapes; neither proves the terminal shape of every possible same-ID fold or a notification-first, separate-prompt continuation. A final built `runClaudeCli` gate with real `AgentHost`, `InterAgentTool`, server comparison, and negative controls remains required before implementation is accepted.
