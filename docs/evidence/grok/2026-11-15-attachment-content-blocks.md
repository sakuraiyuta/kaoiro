---
title: Grok prompt content-block measurements (2026-11-15)
description: How Grok Build 1.0.52 handles each ACP prompt content block.
status: measured
last_updated: 2026-11-15
---

# Grok prompt content-block measurements

Measured for [issue #1127](https://github.com/sakuraiyuta/kaoiro/issues/1127)
(parent [issue #628](https://github.com/sakuraiyuta/kaoiro/issues/628)) on
2026-11-15. The current contract is in the
[Grok engine reference][reference]. Raw logs remain private. This page keeps
only observations that a retained probe output shows; a claim of the private
report without such an output is listed under [Not measured](#not-measured).

[reference]:
  ../../reference/engines/grok-acp.md#prompt-content-blocks-and-attachments

## Target and method

- Grok Build: `1.0.52 (0920c8169e27) [stable]`. The wire probes sent
  `grok-4.6` and the live probes ran `grok-4.7`, as each probe recorded.
- `@agentclientprotocol/sdk` `1.8.0`.
- kaoiro source: `0ba15295c13e43cdd39dfc6799cc470a0acfa8ce`.
- Private report SHA-256:
  `dbb814cc1a47d4da2b6625a5f15763dc57ef8c933ee9ee1c718c0b62ca58fc77`.
- The report records neither the Grok binary hash nor the Node version.

Every probe is a small ACP client talking to the installed `grok` over stdio.
It does not use the wrapper.

- **Wire probes** (cases A to E, one session, one prompt per case): Grok's model
  API base URL pointed at a local stub that answers every request with HTTP 400.
  The probe stored the last non-system input item of each `POST /responses`
  and the update notifications. The model never answered, so these show what
  Grok sends, not how the model reads it. Every case except audio ended with
  the stub's 400 as an internal error.
- **Live probes** (cases L0 to L4): the real API, a new session per case, an
  empty working directory and a prompt that asked for no tool calls (L4 allowed
  them). The code words are random strings that appear in no prompt text or URI.
  A probe recorded the assistant text, tool calls and permission requests.
- **Fixtures**: a 600×200 PNG rendering a code word, a 1×1 PNG, 64×64 JPEG,
  WebP and GIF files, a one-page PDF, a 19-byte text file, and the bytes
  `not-a-png` labelled `image/png`.

## Observations

`initialize` returned `promptCapabilities` `image: false`, `audio: false` and
`embeddedContext: true`.

| Block | Cases | Observed |
| --- | --- | --- |
| `text` | A | The text is wrapped in `<user_query>`. |
| `image`, PNG 600×200 | B1, L0, L1 | Accepted despite `image: false`. The request holds an `input_image` item (`detail: "auto"`, `data:image/png;base64,...`) and a text note that names a path under the session's `assets` directory. Live, the model returned the code word with 0 tool calls and 0 permission requests. The same prompt without the image (negative control L0) returned `NO_IMAGE`. |
| `image`, PNG 1×1 | B2 | The prompt is not rejected. Grok sends an `image_dropped` update on `_x.ai/session_notification` and puts a model-visible notice in the text: `images must be at least 8×8 pixels`. No `input_image` is sent. Only 1×1 was tried. |
| `image`, corrupt bytes | B3 | Same shape: `image_dropped` and a notice (`unsupported or unrecognised image format`); the RPC does not fail. |
| `image`, WebP and GIF at 64×64 | MIME probe | Both reach the request as `input_image`. WebP keeps `data:image/webp`. GIF is sent as `data:image/png` and the saved asset has a `.png` name. |
| `image`, JPEG at 64×64 | MIME probe | Not established. The capture holds the user text only, with no `input_image` and no `image_dropped` update; WebP and GIF in the same run show the image. Whether Grok dropped it silently or the capture missed it was not determined. |
| `resource`, text (`text`) | C1, C1b, C1c, L2 | The text is inlined from memory into `<attached_files>` as `<file_contents path=... isFullFile="true">`, each line prefixed with a 1-based number and an arrow. A `file://` URI to a directory that does not exist (C1b) still inlines the supplied text. The path shown drops `file://` (C1b) and keeps an `attachment:///` URI as given (C1c). Live (L2), the model returned the code word with 0 tool calls. |
| `resource`, binary (`blob`) | C2, C3, C4, L3, L4 | The bytes are written under `/tmp/grok-test-sessions-<pid>/attachments/` as `<8 hex>-<basename>`, where `<pid>` is the `grok` process id in the unsandboxed run. The request holds only `<file_contents type="binary" path=... mime_type=... size=.../>`; the size equals the blob's byte length and nothing is inlined, for `text/plain` and `image/png` too. The three files were listed during the run and still listed after the probe sent `SIGTERM` to `grok`. Live without tools (L3), the model saw only the tag. Live with tools (L4), the model called `read_file` on that path with 0 permission requests; the result was one page rendered as an image (JPEG data URL), and the model returned the code word. |
| `resource_link` | D1 to D4 | `@<path>` is appended to the user text and a `Referenced resources` reminder is added. For an existing text file (D1) the file content is also inlined; the probe supplied no text, so it came from disk. For an existing image (D2) and PDF (D3) only the reminder appears: no content, no `input_image`. For a missing path (D4) the result matches D2 and D3, without an error. |
| `audio` | E | Rejected before any model request with JSON-RPC `-32602`, `unsupported content block in prompt`. |

The wire probe's retained update log holds each accepted prompt block as a
`user_message_chunk` update of type `text`, `resource`, `resource_link` or
`image`. The rejected audio prompt left no chunk, text block included.

## Interpretation and limits

Inferred, not directly measured:

- Grok 1.0.52 does not enforce `promptCapabilities.image: false` for an
  `image` block. A later version may; a client must not rely on it.
- Of the four kaoiro attachment categories, the measured block carriers are
  `image` for images, `resource` with `text` for text, and `resource` with
  `blob` for a PDF, where the model must call `read_file` to see it. This
  depends on tool access and on the model choosing to call it.
- No Office document was sent. Any conversion to text would happen before the
  prompt and would then travel as text.

## Not measured

The private report states the following without a retained probe output, so
this page does not.

- How several `text` blocks in one prompt are joined.
- The `GROK_SANDBOX` read-only profile, and where `TMPDIR` places the blob
  directory.
- File modes of the blob directory and its files, and the origin of the 8-hex
  prefix.
- File modes of the `assets` directory, and any `read_file` page limits.
- JPEG delivery as an `image` block (see the table).
- Image sizes between 1 and 63 pixels, several attachments in one prompt, size
  limits, and other Grok versions.
- A `session/load` replay of a session that holds these blocks.
