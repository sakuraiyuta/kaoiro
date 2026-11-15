---
title: Grok attachment delivery routes (2026-11-15)
description: Attachment delivery routes and limits on Grok Build 1.0.52.
status: measured
last_updated: 2026-11-15
---

# Grok attachment delivery routes

Measured for [issue #1143](https://github.com/sakuraiyuta/kaoiro/issues/1143)
on 2026-11-15, after the
[content-block measurements](2026-11-15-attachment-content-blocks.md) of
[issue #1127](https://github.com/sakuraiyuta/kaoiro/issues/1127). Raw logs
remain private. This page keeps what the retained probe outputs show.

## Target and method

- Grok Build `1.0.52 (0920c8169e27) [stable]`, binary SHA-256
  `1668414b047e1050a96d25fe17dfc3efe63190fbf66d8cc1c3de8633caf50d11`.
- `@agentclientprotocol/sdk` `1.8.0`, Node `22.23.4`, kaoiro source
  `5f1f808433a250f133c6ef948925e9b1c6eb018d`.
- Each probe is a small ACP client over stdio, not the wrapper. It starts
  `grok --no-auto-update agent --no-leader stdio` the way `GrokProcess` does:
  its own process group, `GROK_SANDBOX` set to the profile, `KAOIRO_AGENT=1`,
  `GROK_CLAUDE_*_ENABLED` removed. It stops Grok the same way: `SIGTERM` to
  the group, then `SIGKILL` after 3 s. Grok used the operator account's own
  configuration. Every session had `mcpServers: []` and an empty cwd outside
  `/tmp`.
- Profiles are the three the wrapper maps to: `off`, `workspace` and
  `read-only`.
- **Wire probes**: the model API pointed at a local stub that answers every
  request with HTTP 400. The probe kept every non-system input item of every
  `/responses` request, with each image data URL replaced by its MIME type,
  length and SHA-256, matched against the fixtures. Sessions reported
  `grok-4.6`.
- **Live probes**: the real API, a new session per run, sessions reported
  `grok-4.7`. Code words are random (`KX-`, six letters, four digits) and
  appear only inside their fixture, never in a prompt or URI. The runs and
  thresholds were fixed before the first live run: three runs per image
  case, two per Office case, one per PDF route and profile. A permission
  request would have been answered with the first `allow_once` option and
  recorded; none was raised.
- The Office text came from the Claude Code adapter's
  `DefaultOfficeTextExtractor`, run from a local build whose
  `wrapper/claude-code/src/upload.ts` is identical to the one at the source
  revision above.

## Observations

### Images

| Case | Observed |
| --- | --- |
| JPEG 600×200, wire, all three profiles | Sent as `input_image` with `data:image/jpeg`; the base64 equals the fixture's. |
| JPEG 600×200, live | 3 of 3 runs returned the image's code word with 0 tool calls. PNG positive control: 3 of 3. The same prompt without an image (negative control): 0 of 3, each `NO_IMAGE`. |
| Small PNGs, wire | Dropped with an `image_dropped` update and a prompt notice: 7×7, 7×8, 8×7 (`images must be at least 8×8 pixels`); 8×8, 8×63, 16×31 and 22×23 (`images must have at least 512 total pixels`). Sent: 8×64, 64×8, 16×32 and 23×23. The 8×64 to 22×23 cases ran under `workspace` and `read-only`; the rest under all three profiles. |
| Small JPEGs, wire | 7×7 and 8×8 dropped with the same notices. |
| Large PNGs, wire | An 8,674,718-byte and a 20,289,761-byte PNG were sent as JPEG, 1,682,268 and 1,912,820 base64 characters, with no `image_dropped`. The output resolution was not recorded. |
| Stored copies | Each sent image was saved in the session's `assets` directory (directory `0700`, files `0664`). The session's `updates.jsonl` holds the image block with its base64: one line of 15,449 bytes for a 15,084-character image. |

In the wire runs the first prompt of a session caused three model requests:
one with no non-system item, one holding only the user query as plain text,
and one whose last non-system item was a reminder about MCP servers that
were still connecting. The JPEG capture of issue #1127 holds the second and
third shapes; it was the first prompt of its session, and that probe kept
only the last item of each request. Inferred, not measured: this is why the
capture showed no image.

### Office text

A 9,568-byte `.docx` holding a code word was extracted to 42 characters that
contain it. Sent as a `resource` with `text`
(`attachment:///code.docx`, `text/plain`), 2 of 2 live runs returned the code
word with 0 tool calls. The same prompt without the resource: 0 of 2, each
`NO_DOC`.

### PDF

The prompt allowed tools. Each route below returned the PDF's code word in
its single run, through a `read_file` call on the file's path, with 0
permission requests.

| Route | `off` | `workspace` | `read-only` |
| --- | --- | --- | --- |
| `resource` with `blob`, `TMPDIR` set to a `0700` directory | 1 of 1 | 1 of 1 | 1 of 1 |
| `resource_link` to a `0600` file in a `0700` directory under `/tmp`, written by the client | not run | 1 of 1 | 1 of 1 |

The same prompt without an attachment (`workspace`) listed the cwd and
`/tmp` and replied `NO_PDF`.

### Files written for a `blob`

- The path is
  `$TMPDIR/grok-test-sessions-<pid>/attachments/<hash>-<basename of the URI>`,
  where `<hash>` is the first 8 hex digits of the SHA-256 of the bytes. The
  `<pid>` is the spawned process's under `off` and another process's under
  `workspace` and `read-only`.
- Directories are `0775` and the file `0664` (this account's umask), under
  every profile with `TMPDIR` moved and under `workspace` with the default
  `/tmp`.
- Setting `TMPDIR` moved the directory under all three profiles.
- The files were still present after Grok exited on `SIGTERM`.
- After the probe removed `attachments` while Grok ran, the next `blob`
  prompt wrote the file again at the same path.
- Removing the moved `TMPDIR` right after Grok's process group ended failed
  once (`ENOTEMPTY`, `off`) and succeeded in the `workspace` and `read-only`
  runs.

### Grok's descendants inherit `TMPDIR`

With the operator account's configuration, Grok started an MCP server
through `npm exec`, in its own session and process group. In one `off` run
with `TMPDIR` moved:

| Time after the group ended | Server alive | Entries in `TMPDIR` |
| --- | --- | --- |
| before the stop | yes | 2 |
| 0 ms | yes | 156 |
| 500 ms | no | 550 |
| 1 s to 10 s | no | 550 |

Removing `TMPDIR` after 10 s succeeded, and it did not reappear within 5 s.
In the earlier `off` run whose removal failed, the entries left behind were
Node's compile cache (`node-compile-cache/`).

### Message size limits

- Grok accepts an incoming ACP message of at most 67,108,864 bytes. A
  larger one ends the process with exit code 1 (stderr
  `ACP message exceeds 67108864 byte limit`) and closes the connection. Seen
  for one text block of 67,109,000 and of 70,000,000 bytes (a fresh process
  each), and for one image block of a 50,451,814-byte PNG.
- Grok sends `_x.ai/queue/changed` notifications that carry the prompt's
  `text` blocks (in `entries[].text` and then `runningText`). With the SDK's
  default 33,554,432-byte incoming limit, prompts whose text blocks held
  40,000,000 and 60,000,000 bytes failed on the client with
  `Incoming ACP data exceeds the configured 33554432 byte limit`;
  30,000,000 bytes did not. A 5,000,000-byte text `resource`, an image of
  27,053,016 base64 characters and a `blob` of 40,000,000 base64 characters
  caused no incoming line over 1,000,000 bytes.
- A 30,000,000-byte `blob` was written to disk in full.

## Interpretation and limits

Inferred, not directly measured:

- A client has to keep each `session/prompt` under Grok's message limit
  itself; going over it ends the Grok process rather than failing the
  prompt.
- Attachment content sent as `resource` or `image` blocks does not pass
  through `_x.ai/queue/changed`; only `text` blocks do.

Not measured:

- `.xlsx` and `.pptx`, image formats other than PNG, JPEG, WebP and GIF, and
  the resolution Grok re-encodes large images to.
- Image size limits of the xAI API, and `read_file` page limits.
- `session/load` replay of sessions holding these blocks.
- Other MCP configurations, other Grok versions, and repeated PDF runs (one
  run per route and profile is not a reliability figure).
