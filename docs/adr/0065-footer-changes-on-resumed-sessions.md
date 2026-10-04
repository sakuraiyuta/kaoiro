---
title: Footer changes do not reach resumed sessions, by design
status: accepted
date: 2026-10-04
opened: 2026-10-04
supersedes: []
superseded_by: null
related_specs: [persona-personality-injection]
related_adrs: [29, 45]
---

# ADR-0065 — Footer changes do not reach resumed sessions, by design

## Status

Accepted. The operator decided on 2026-10-04 not to force a changed
personality prompt or common footer into a session that is resumed. A
changed footer takes effect at the next new session or compaction. The
investigation is Kogane's report of 2026-10-04 (local review artifact
`tmp/reviews/footer-resume/investigation-kogane.md`, SHA-256
`32ee263e…`).

## Context

The server composes the personality and the common footer at prompt time
([ADR-0045](0045-footer-file-externalization.md)), and the wrapper receives
that text on every launch, including a resume
([ADR-0029](0029-persona-server-sot-and-pack-distribution.md) F9). On
2026-10-04 the server and runner were updated to d561cd09, whose footer adds
three instructions: write the closed conversation id in the first message of
a new thread, the `delivery_intent` guidance (issue #508), and the
`set_status_line` guidance (issue #482). Every peer then came back by resume.

What each engine did with the new text:

| Engine | Effect of the new footer after a resume | Why |
|---|---|---|
| Claude Code | Not used. The model keeps the footer of the session's first request. | Agent SDK 0.3.284 records the rendered system prompt in the transcript by default (`systemPrompt.snapshot`, default true) and sends the record on every later request and `resume`. A different `append` passed on a later launch is ignored until compaction or a new session (`sdk.d.ts`, the `snapshot` documentation). Tool descriptions already in the record are also kept; tools added since then arrive with their current descriptions. |
| Codex (app-server) | Not used, as far as the rollout shows. | The wrapper passes the new developer instructions on `thread/resume`, but the resumed thread records no new developer message; the persona and footer appear only at thread start and in compaction records. |
| Antigravity | Used. | The wrapper rewrites the rules file on launch and `agy` reads it on every start; rules are not stored in the conversation history. |

Setting `snapshot: false` on the Claude `systemPrompt` would render the
prompt fresh on every request. The SDK documents the cost: when the prompt
actually changes, the prompt-cache prefix is invalidated and, with extended
thinking, the model's earlier reasoning is discarded. Codex would need its own
design to re-send the instructions when their hash changes.

## Decision

- **D1: Do not force footer changes into resumed sessions.** The wrapper keeps
  the SDK default (`snapshot` omitted) for Claude Code, and no re-injection is
  added for Codex. A changed personality prompt or footer reaches an agent at
  its next new session or compaction (Claude: compaction or a new session;
  Codex: a new thread or compaction; Antigravity: the next launch).
- **D2: Deliver an urgent instruction by message.** When a footer change must
  take effect before the agents' next compaction or new session, the director
  or the operator sends its gist to the running agents as an ordinary
  message, or the operator resets the sessions that should pick it up.
- **D3: Documentation states when a change takes effect per engine**, so that
  "the next connecting wrapper" is not read as "the next resume".

## Consequences

- The prompt-cache prefix stays stable across runner updates and restarts, so
  a resume does not pay a full uncached prompt, and extended-thinking context
  survives the restart. The operator judged that the extra token use of
  re-rendering would hurt the user experience more than a delayed footer.
- After a server update that changes the footer, the agents run on mixed
  footer versions until each compacts or starts a new session. Checking
  whether an agent follows a new footer instruction is only meaningful for an
  agent that has started a session or compacted since the update.
- Tool behaviour always follows the deployed wrapper and server; only the
  model-facing text (system prompt and recorded tool descriptions) can lag.
- If the SDK's recording default or Codex's resume behaviour changes, revisit
  this decision with a fresh measurement.
