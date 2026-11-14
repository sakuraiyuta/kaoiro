# Codex reply-authorization guidance measurement — 2026-11-14

Issue: [#551](https://github.com/sakuraiyuta/kaoiro/issues/551).

## Identity and method

- Measured tree: `f1fd8a540cdc72f26a584f92e3d442fe72a4b49d`.
- Codex CLI: `codex-cli 0.164.0`.
- Native SHA-256:
  `b93f6811d3f653f0fb83be4050d857fb9abbb111dfa2ce160563327daff7f306`.
- Measurement script SHA-256:
  `3cecdbef4536cc1b559f087314b96d729856924eac71fffffb569e815acaa403`.
- The production `runCodexCli` composition ran through the host, bridge,
  session, and native app-server using a local Responses provider and a fake
  Phoenix loopback. No real model or credentials were used.
- Four cases covered six wrapper lifecycles and 18 model requests. In all four
  cases, the tool definition reached the model as an `exec` lookup result;
  top-level `tools` were absent from all 18 requests.

## Four cases

`Current` is the product definition with `in_reply_to` and `reply_ticket`.
`Old` is a synthetic prior definition without either field.

| Case | First shown | Fields | Lookup |
| --- | --- | --- | --- |
| fresh-current | Request 2: current | present / present | Current |
| fresh-old | Request 2: old | absent / absent | Old |
| resume-O-to-C | Request 1: old | absent / absent | Current (2) |
| resume-O-to-O | Request 1: old | absent / absent | Old (2) |

## Observation and limits

On resume under the current wrapper, the first model request replayed the old
lookup result from history. A fresh lookup in that session returned the current
definition. The comparison control accepted current metadata against current
metadata and rejected old metadata against the current definition.

This supports the inference that the stale definition was in model-visible
history, not in the bridge registry. The measurement does not establish that a
real model would trust the stale text or omit the fields, and it covers only
Codex 0.164.0. Other versions and authenticated providers were not measured.
