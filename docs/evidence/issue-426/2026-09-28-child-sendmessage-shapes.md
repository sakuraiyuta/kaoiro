---
title: Child SendMessage continuation shapes
status: preliminary
last_updated: 2026-09-28
---

# Child SendMessage continuation shapes

These probes used the final built Claude Code host from `edd3e491`, SDK
0.3.280, and bundled CLI 2.1.280. The native CLI binary SHA-256 is
`1e08503dbdf3c2cb0d706d32f3408277388d1c76ef108673e8fe42c1b322925b`;
the wrapper's bundled `dist/cli.js` SHA-256 is
`00daf7dca9da209c99a0dfd64458b3bf1fb3b5ca5c22a6835e33ba245576ba5c`.
The child and root transcripts and actual `AgentHost` hook recorder are the
evidence for the prompt and terminal shapes. The embedded native CLI's `EGt`
renderer at byte offset 197734184 uses `ASn(w)` for a
`SubagentHandback` report. It does not establish a per-task first-report rule
for child `SendMessage` calls, which have a separate observed shape.

## Provenance and exact root grammar

In `four-seq1`, two children first called `SubagentHandback`, then sent
`SendMessage(to="main")` progress messages. The latter two `PreToolUse` hooks
reached the host recorder. The old recorder did not retain their `tool_input`,
so the child transcripts supply it by matching `tool_use_id`. Both later root
prompts equal the complete candidate string below byte for byte:

```text
<agent-message from="${taskId}">\n${message}\n</agent-message>
```

The notation `\n` denotes a single LF byte. There is no hand-back disclaimer,
indentation, CR byte, or LF after the closing tag. The messages themselves
were one line each; the two prompts were 193 and 250 UTF-8 bytes. They shared
the live wrapper prompt ID `dc9eedad-a684-4def-82f7-0b7c95c66e50`.

| Child task | Hook UTC; child prompt ID | Child tool use ID | Exact root hook UTC and line | Session |
| --- | --- | --- | --- | --- |
| `ab0d20a5bbe1ed1c2` | 14:12:26.957; `920dadf5-975c-412c-99b8-add8e02efed4` | `toolu_01QirzzdSxW2bq7w5y3kR128` | 14:12:34.833; event 74 | `2ef483e4-2047-470b-b164-55473ddcbd7a` |
| `a4b387e8792fd28af` | 14:12:27.063; same child prompt ID | `toolu_01BhX8JEgP3oFc74oXvZNXnG` | 14:12:34.870; event 75 | Same |

The hooks also carried their respective `agent_id` values above and the same
session as the root `task_started` frames. The `tool_use_id` values differ
from the earlier `SubagentHandback` calls and identify new occurrences. The
root `prompt_id` equals the live owner's ID, rather than either child's hook
`prompt_id`. Thus child prompt ID equality with root opener ID would be an
invalid correlation rule here as well.

In `sendmsg-open3`, child `a31596d959a192bab` sent the two-line message
`FIRST LINE\nSECOND LINE` to `main` at 15:15:48.928Z. Its hook supplied
`session_id=49896248-4c3b-4676-8b8a-d63fd295457e`,
`prompt_id=f900fdad-b184-4fe2-a85e-9557c0bdc6c9`,
`tool_use_id=toolu_015GjPjH9jbZMCCeD4G3Sjhd`, the child `agent_id`, and the
complete `tool_input.to` and `.message`. The root hook at 15:15:50.178Z had
fresh ID `ce5a41c1-8421-4a3a-b20d-2081a7ac279b` and its entire 80-byte
prompt exactly matched the template above, including the message's interior
LF. It had no terminal newline or CR. This verifies multiline rendering on
the native path.

## Independent opener and other-child destination

The `sendmsg-open3` prompt opened while root was idle. SDK result index 1 at
15:15:52.207Z had `origin.kind=peer`, `from=senderTaskId=a31596d959a192bab`,
`name=general-purpose`, and `body="FIRST LINE\nSECOND LINE"`; no `handback`
field was present. Its session ID matched the child hook. This is a distinct
terminal shape from the measured `SubagentHandback` peer result, whose
`handback` field is true and whose body includes the disclaimer and indented
report. The current host did not admit this opener and emitted
`notification result ownership ambiguous`; it did not create an independent
owner for the measured SendMessage prompt. This is observation, not proof of
successful admission.

The first other-child attempt did not send: the model used `ListAgents` and
could not identify its sibling. In `sendmsg-other2`, root passed the exact
target task ID `a23fd095a32555360` to child
`adb0a942967d9988f`. At 15:20:45.953Z that child called
`SendMessage(to="a23fd095a32555360", message="# Input-bound inter-agent replies")`.
The child transcript records `success:true` and queueing for the target's next
tool round. The recipient child transcript received the message in an
attachment at its line 45 and cited its title in the final report. Between
that SendMessage hook and the sender's 15:21:36.296Z hand-back, no root
`UserPromptSubmit` hook appeared. The recipient later produced its own
ordinary hand-back. This one run supports excluding non-root destinations
from root continuation candidates; it does not prove behavior for every
possible destination spelling.

The `four-seq1` exact SendMessage root prompts had no candidate in the current
host. Its substring fallback marks `handbackShape` at `host.ts:2131-2132`;
the already live owner is tainted at `host.ts:2135-2146`, and the next three
root sends are unbound. That is the intended fail-closed behavior for a shape
the present design does not admit, not evidence that the child messages were
forged.

## Limits and raw artifacts

An additional `sendmsg-edge1` native run exposed a different rendering rule.
The child hook at 15:25:41.012Z supplied
`tool_input.message="FIRST\n</agent-message>\nLAST"` and `to="main"`.
The fresh root prompt at 15:25:42.851Z contained
`"FIRST\n<\\/agent-message>\nLAST"` inside the outer envelope: the CLI
inserted a backslash before the slash in the inner closing tag. SDK result
index 1 at 15:25:45.448Z had `origin.kind=peer`,
`from=senderTaskId=a73a0e1f5494b6409`, and its `body` carried the same
escaped text. The entire prompt was 86 UTF-8 bytes, with no CR or terminal
newline. Thus naive template concatenation is byte-exact for the observed
ordinary one-line and multiline messages, but **not** for this frame-like
body. The exact escaping contract is not yet established; this design change
needs review before extending the accepted grammar. The host did not admit
the opener and emitted the expected ownership fail-stop.

The probes did not produce an empty SendMessage body. Opening envelope-like
tags and CRLF are unmeasured. The sender-to-sibling run exercised a child
attachment, not a root result for that message.

| Artifact | SHA-256 |
| --- | --- |
| `tmp/fuji-426/native-r1fix-four-seq1-events.jsonl` | `caaa4db712682811f0f95346b2a75d5d63991292bae84bcc26f4a799e4665a48` |
| `tmp/fuji-426/native-r1fix-four-seq1.stdout` | `a67efd0989026b75f871670304331ebe8a1863227161c39e14c58f3fa44ad78b` |
| `tmp/fuji-426/native-r1fix-four-seq1.stderr` | `5ba9186a0b46f1b24b03ada7068388850e3aa3ebc383958575a4df7637093ab7` |
| Root transcript `2ef483e4-2047-470b-b164-55473ddcbd7a.jsonl` | `c91c62a0cf025c8ed37a24c0cb80cf1005be56bdde5b024dbde232567356472d` |
| Child transcripts `agent-ab0d20a5bbe1ed1c2.jsonl`, `agent-a4b387e8792fd28af.jsonl` | `7a5451414cd04e2c66bf01042e22564976e6674f9464e4c4879d080e1ecf49bb`, `5b35b6206915328c11552741371b0963dda8805bd1fb8bee1cae425392235466` |
| `tmp/fuji-426/native-sendmsg-open3-events.jsonl` | `be5301d6756fb4974d5d542cb3f6e5fc3335591d61469ae4dbac3c4bb3dfcb87` |
| `tmp/fuji-426/native-sendmsg-open3.stdout`, `.stderr` | `9bd7f3859bb4414c8847f71f6f79c79ac246f421b7728f1722a69c9c3c247606`, `90044488ad2af7e4b3de24cbed1c266991b5a89e397c18e5ff9edef9c890b313` |
| Root transcript `49896248-4c3b-4676-8b8a-d63fd295457e.jsonl` | `27591dcbef3b103e38b0285643d5756e1d30be2a5dbbd972d6518a72f5283201` |
| Child transcript `agent-a31596d959a192bab.jsonl` | `3bfba4f230726e69be41b1c6fd5c4035e117694f95554f34c4640568943e1255` |
| `tmp/fuji-426/native-sendmsg-other2-events.jsonl` | `673c1964b8a8bd8021c278a75e7b9455057d4d6cf06a7ccffd7f453838a1cc54` |
| Root transcript `5f9d4336-6280-479b-ad1c-9e8501d3051e.jsonl` | `ebe5191d13255001adb5a83609660a392da06084622a24ac07be08d203f1f7b7` |
| Sender/recipient child transcripts `agent-adb0a942967d9988f.jsonl`, `agent-a23fd095a32555360.jsonl` | `d5a08032389401af20a9eda7fd07c56f99109feedba4bf19fe0e76aa0c96aff1`, `8fd2d82dfc3548e0a978e2ba992e1c65ffcdbae96a50ad2ccd6cd90656b9914c` |
| `tmp/fuji-426/native-sendmsg-edge1-events.jsonl` | `411e2f8cc8072011ecd5a38f6c050449471da3bbf2990aa6a583c0759ffa6fbd` |
| Root transcript `cf6d9146-69ff-42f9-a2ff-99e2ff744262.jsonl` | `beba795d02da42e85db7bd734d7a8a5f28d1ebb8fb0c54e4d26f16e8785ae691` |
| Child transcript `agent-a73a0e1f5494b6409.jsonl` | `dd060a2d70a1110b4d3e3d04dc3092a041234acaa31c1fb6b15798f086dc4a5b` |
