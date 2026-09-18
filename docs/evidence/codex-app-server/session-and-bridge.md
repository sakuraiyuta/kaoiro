---
title: "Codex app-server session and bridge evidence"
status: recorded
last_updated: 2026-09-18
---

# Codex app-server session and bridge evidence

Historical excerpts from [ADR-0058](../../adr/0058-codex-app-server-turn-steer.md). Each increment
retains its original scope and tense; “now”, “above” and “remaining” describe that
record, not a new claim of present implementation or release.

The artifact, binary/schema hashes, reference SDK and initial procedure cited as
“above” are in the [compatibility record](stage1-compatibility.md).

Scratch paths and hashes below identify the recorded experiments, not a promise
that temporary files remain available. Measurement dates are retained per record;
`last_updated` refers to the source text, not a new measurement.

### Stage 1 implementation increment (3): internal session composition

`AppServerSession` now owns the persistent transport, an optional `ToolHost`,
and thread configuration for start/resume. It uses the existing bridge and
`ToolHost.listen` socket construction unchanged. The closed input conversion
accepts text and local-image paths; developer instructions are sent as the
thread's `developerInstructions`, outside user content. Approval remains
`never` / `user`, and `experimentalApi` remains false.

These settings reproduce existing `CodexHost.run` configuration, rather than
introducing new privileges or timeout defaults:

| App-server configuration | Existing exec configuration |
| --- | --- |
| `mcp_servers.kaoiro.default_tools_approval_mode = "approve"` | Same value in `CodexHost.run` |
| `mcp_servers.kaoiro.tool_timeout_sec = 310` | `BRIDGE_TOOL_TIMEOUT_SEC`, allowing the 300-second inter-agent wait to finish |
| `features.multi_agent = internalSubagents ?? true` | `codex_internal_subagents ?? true`, explicitly enabled or disabled |
| MCP command, bridge path, private socket environment | `process.execPath`, `dist/bridge.js`, `ToolHost.listen` |

The stable generated `ThreadStartParams` / `ThreadResumeParams` schemas above
permit `config` and `developerInstructions`; `TurnStartParams.UserInput`
provides `text` and `localImage`. The Python reference's thread start/resume
and local-image conversion map to these same fields. Its default approval
handler is not reused.

The real-CLI session test uses the default executable resolution and the same
pinned 0.153.4 binary recorded above. A local Responses endpoint emits a
code-mode `exec` call invoking the actual kaoiro MCP bridge handler, then a
terminal answer. After closing the first session, a new child resumes the
persisted thread with a new private socket. Both turns execute their handler,
send decoded image data in order between user text, and include exactly one
copy of the developer instruction marker. Both rollout contexts retain
`never` / `user` despite `auto_review` in the isolated host config; no auth file
or approval request is needed. Internal subagents are explicitly true in the
first session and false in the resumed session. No subagent is spawned by this
fixture, so its observation is configuration delivery, not subagent behavior.

The test requires no external model/auth service or network namespace. Analytics
is disabled; outward CLI startup attempts remain possible, as in the original
compatibility gate. This is not a measurement of model reasoning, long-running
inter-agent waits, cancellation/watchdog handling, or non-Linux socket behavior.

This increment is still internal: `CodexHost`, package exports, and normal
launch selection remain on exec. Result/usage/compaction/history projection,
host lifecycle and inter-agent integration, and launch parity acceptance are
separate remaining increments. No steering or external-message input has been
enabled, and this increment does not change the ADR's status.

### CI follow-up: required bridge startup

After (4a), the fixed local response could finish a resumed turn without an MCP
item. CI run 35274497630 attempt 4 captured `TypeError:
tools.mcp__kaoiro__probe is not a function` in the code-mode tool output;
the first turn had called the bridge successfully. The model turn still
completed. This is distinct from a sandbox failure: code-mode executed, but
its tool catalog omitted the bridge.

The same 0.153.4 binary (SHA-256 recorded above) reproduces that failure when
bridge startup is delayed 2.5 seconds. Upstream's
[optional MCP grace schema](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/config.schema.json#L6515)
defaults to 1000 ms; the
[tool catalog](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/codex-mcp/src/connection_manager/tool_catalog.rs#L173)
can omit an optional server still starting at that deadline. Both wrapper
transports had inherited that default.

The fix uses a shared `BRIDGE_MCP_POLICY` in the production exec host and
app-server session: `required = true`, `startup_timeout_sec = 30`. The
[required field](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/config.schema.json#L3211)
is supported by this pin, and 30 seconds explicitly preserves its
[existing startup timeout](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/codex-mcp/src/rmcp_client.rs#L98).
[Required-server validation](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/codex-mcp/src/connection_manager/required.rs#L15)
waits for initialization and rejects startup on failure. No wrapper polling or
global change to other optional MCP servers is needed. Tool approval and the
310-second tool-call timeout are unchanged.

This is also a **normal launch behavior change**: exec now fails the turn if
the kaoiro bridge cannot initialize, instead of silently proceeding without
its tools. The existing `makeResult`/`error_detail` path presents that failure
to the operator; it is not a reason to retry a turn automatically. The
app-server session closes on failed thread opening and cannot submit a turn.
Its bridge-bearing thread/start and thread/resume requests allow 35 seconds
(30-second startup plus 5 seconds for the response); other RPCs retain their
25-second default. Explicit transport timeout overrides remain authoritative.

The real CLI tests use the actual SDK/exec host and app-server session with a
2.5-second delayed entry point into the built bridge. The policy still comes
from production composition. They check successful calls (including app-server
resume), and a shorter test-only startup timeout checks zero model requests
and the operator-visible exec error. Removing required is the negative control.
The 35/25-second boundaries and premature-turn rejection are tested with a
controlled child and fake clocks, rather than timing assertions on CI runners.

A separate observation was `ENOTEMPTY` during home cleanup: external plugin
clone processes could keep writing after the CLI child closed. The isolated
integration configurations now disable plugins as well as analytics.
Upstream [curated repository synchronization](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core-plugins/src/manager.rs#L693)
is gated by plugins_enabled; execve traces with plugins=false contained no
plugins-clone startup, unlike the preceding default-config capture. Production
plugin settings are unchanged. Update checks and other CLI startup traffic
remain possible. CI's PATH-alias and bundled-bubblewrap fallback warnings are
separate observations, not evidence of the missing-tool cause.

## Wrapper test coverage and limits

The following coverage notes were retained from the package README at migration
baseline `81570847`. They do not extend the dated measurements above.

Tests cover protocol faults, request correlation, pre-response notifications,
consumer abandonment, buffered termination, and process shutdown. The real CLI
integration test uses the default constructor and an isolated Codex home with
a local Responses provider. It needs neither external model access nor auth,
but inherits CLI startup traffic and therefore does not assume fast offline
startup. Its isolated configuration disables analytics and plugins; external
plugin clones otherwise write into the temporary home and can outlive child
shutdown, racing cleanup. Other startup traffic, such as update checks, is
still possible. Network namespaces are not required by the test.
The session integration test also executes a real bridge handler, checks image
bytes and developer instructions at the provider, closes the child, then resumes
with a new bridge and repeats those checks. Its attachments come from the real
`materializeLocalImages` function. It verifies transport and tool execution
against a fixed local response, not external model reasoning.
