---
title: Surface the Antigravity CLI version in runner registration
description: Add the runner's agy --version result to RunnerRegister, retain it with the live host, and show it to operators.
status: in_progress
last_updated: 2026-09-26
issue: 410
must_fix_rounds_used: 1
---

# Issue 410 — Surface the Antigravity CLI version in runner registration

## Problem and evidence

[Issue #410](https://github.com/sakuraiyuta/kaoiro/issues/410) splits this work
from [issue #387](https://github.com/sakuraiyuta/kaoiro/issues/387). The
[#387 landing comment](https://github.com/sakuraiyuta/kaoiro/issues/387#issuecomment-5837595372)
records that the runner probes `agy --version` at startup and
reload, but compares it only with the previous value observed by the same
process. A runner restart has no prior value to compare. The completed change
does not carry that result to the server.

The current source confirms the remaining path:

- `runner/src/runner-cli.ts` resolves the CLI version, logs it, and passes
  register data through `buildRegister`; reloads use the same register builder.
- `protocol/src/index.ts` has no Antigravity CLI version member on
  `RunnerRegister`.
- `server/lib/kaoiro_server_web/channels/runner_channel.ex` selects known
  fields from the register. `HostRegistry` stores live host entries in a
  GenServer map and drops an entry when its owning runner channel terminates.
  Its host snapshot is broadcast to operators.
- `dashboard/src/lib/protocol.ts` filters host snapshots into `HostInfo`, and
  `LaunchDialog.svelte` already shows the selected host and its runner build
  identity.

## Proposed decisions for review

### Protocol and compatibility

Add optional `antigravity_cli_version?: string` to `RunnerRegister`. The runner
will pass through the trimmed output of its existing `resolveAgyVersion`
probe without imposing a semantic version grammar on its opaque output.
The accepted wire value is single-line UTF-8 text, 1–256 bytes, with no ASCII
control characters. Include the field only for an enabled Antigravity
capability and a value in that domain; otherwise omit it, preserving the
existing best-effort startup behavior. Measure the 256-byte maximum as UTF-8
bytes (`TextEncoder` in TypeScript and `byte_size/1` in Elixir), and test in
all three layers that a multibyte 256-byte value is accepted while a 257-byte
value is omitted or dropped without rejecting unrelated register data.

This is an additive key under protocol version `0`; do not bump the protocol
version. The versioning policy says receivers ignore unknown keys and that
additive keys keep the same version. New servers accept old runners that omit
the field. Older servers ignore unknown keys, and older dashboards already
filter host snapshots to known fields.

### Server storage and persistence

Validate a present value against the wire domain above, then keep a valid
value on the corresponding `HostRegistry` live entry and include it in the
existing operator-only `hosts` snapshot. For this optional diagnostic field
only, an invalid value is dropped while the rest of a valid register is
accepted; it must not use the register-wide rejection behavior of the other
subparsers. The snapshot omits the field when it was absent or dropped. Do not
log invalid values: this is best-effort CLI output that may change, and
logging each rejected diagnostic value adds noise while the operator-facing
“not reported” state already exposes its absence. Never echo the untrusted
value into logs. The dashboard also validates the value before presenting it.

Do not add durable storage or previous-version history. `HostRegistry` is a
live connection registry: runner termination drops the entry, and a new
runner registers its current observation. Persisting history would require a
separate host identity and retention policy. The existing runner warning
continues to detect changes only within one process; cross-process change
alerts are out of scope. Operators can inspect the current version after each
registration.

### Operator visibility

Extend `HostInfo` parsing and show the selected host's Antigravity CLI version
in `LaunchDialog` when that host advertises the Antigravity capability. If
the capability is present but the value is absent, display “not reported”; it
does not distinguish an older runner from a failed version probe. The
existing operator-only host channel remains the access boundary.

## Scope

Change the runner register builder and its initial/reload call sites; the
protocol type; server register parsing, live host storage, and host snapshots;
dashboard host parsing and the selected-host display; focused tests; and the
protocol/decision documentation listed below.

The runner wiring tests will capture `RunnerLinkOptions.register` and every
`updateRegister` payload from `FakeRunnerLink`. Exercise the production
initial and reload call paths with normal output, whitespace-trimmed output,
empty output, output above 256 UTF-8 bytes, probe failure, and Antigravity
disabled; assert the exact field value or its omission in both payloads.
Use a temporary executable for the trim case so the existing CLI resolver
runs against stdout, rather than testing only `buildRegister` directly.
Also cover `engine_catalog_refresh.ts` rebuilding and sending a register, with
the Antigravity version getter required by `buildRegister`'s type signature.

Out of scope: durable version history, detecting or warning on version changes
across runner process restarts, changes to the `agy --version` probe or its
deadline, launch gating, and a protocol-version bump.

## Verification plan

- Runner: `cd runner && pnpm typecheck` and `cd runner && pnpm test`. Cover
  initial register and reload propagation, disabled Antigravity, and each
  probe result listed above. Assert a multibyte value of exactly 256 UTF-8
  bytes is sent and a 257-byte value is omitted. A legacy register without
  the field remains valid.
- Server: `cd server && mix test`. Cover omission, retention in the host
  snapshot, and valid values. For invalid type, empty text, overlong text, or
  control characters, send a register with otherwise valid fields; assert
  register succeeds and the resulting hosts snapshot omits
  `antigravity_cli_version`. Use multibyte values to cover 256 bytes accepted
  and 257 bytes dropped.
- Dashboard: `cd dashboard && pnpm check` and `cd dashboard && pnpm test`.
  Cover preserving a valid value, dropping malformed input, backward
  compatibility when the field is absent, and the selected-host display. Use
  multibyte values to cover 256 bytes displayed and 257 bytes omitted.
- Negative controls: remove runner propagation and confirm the initial and
  reload wiring assertions fail; bypass server field filtering and confirm
  the accepted-register/snapshot-omission test fails; remove dashboard
  parsing or display wiring and confirm the relevant dashboard test fails.
  Remove each layer's UTF-8 byte-cap guard and confirm its 257-byte assertion
  fails, and omit a `buildRegister` version argument to confirm typecheck fails.
  Restore each mutation before the implementation review.

At completion, report the exit code and any unhandled errors or warnings for
each full runner, server, and dashboard suite separately from its pass count:
runner `pnpm typecheck` / `pnpm test`, server `mix test`, and dashboard
`pnpm check` / `pnpm test`.

## Documentation to update

- `docs/reference/protocol/runner-control.md`: the runner `register` payload
  and operator `hosts` snapshot fields, compatibility, and display behavior.
- `docs/adr/0057-antigravity-adapter.md`: the F6 addendum for reporting the
  current CLI version and the no-history boundary.
- This plan: set `status` and `last_updated` to the accepted implementation
  state when the work lands.
