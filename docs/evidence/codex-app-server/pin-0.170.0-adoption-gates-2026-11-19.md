---
title: Codex 0.170.0 adoption evidence
status: accepted
last_updated: 2026-11-19
---

# Codex 0.170.0 adoption evidence

The CLI and SDK are pinned together to 0.170.0. The production path uses
app-server JSON-RPC; the old SDK exec reader patch was removed before this
upgrade. Historical fixtures and adoption records remain unchanged.

## Catalog and authenticated turns

A signed-in ChatGPT catalog returned the two public rows in
[the capture](../../../wrapper/codex/test/fixtures/models_62_remote_2026-11-19.json).
It did not declare a minimum client version. Short direct CLI turns succeeded
for both 6.2 models at 0.170.0, and both were rejected with `model_not_found`
at 0.164.0. Versions 0.165.0–0.169.x were not tested.

The app-server wrapper's production entry also completed a short turn for each
model on a measurement-only build. An observer recorded the spawned native's
version and SHA-256, and each `thread/start` response reported the requested
model. This observation does not establish entitlement for other accounts.

## Approval capture

The pinned native was run with a credential-free loopback Responses provider,
workspace-write and on-request approval. It requested approval for a command
outside the workspace; a decline led to a resolved notification, a declined
command and a completed turn, and the outside file remained absent. The
[JSONL fixture](../../../wrapper/codex/test/fixtures/app_server_approval_decline_0.170.0.jsonl)
and [metadata](../../../wrapper/codex/test/fixtures/app_server_approval_decline_0.170.0.metadata.json)
preserve the public fields with the temporary prefix normalized. Capture used
experimental capabilities; production keeps its existing capability settings.
A separate credential-free local-provider capture with experimental capabilities
disabled did not contain `humanCommand` in the observed approval request. This
one capture does not prove the field cannot occur in other conditions.

## State and compatibility limits

A credential-free 0.164.0 home with a nonempty thread was backed up, opened
and resumed with 0.170.0, then restored and resumed on 0.164.0 through the
app-server path. In a separate CLI experiment, the `state_5` database gained
migration 62 and 0.164.0 could still open the modified state. That observation
does not change the state guard or remove the snapshot restore requirement.

A release-shaped install resolved different native hashes for 0.164.0 and
0.170.0. A switch to a different native was refused by the existing state guard;
the isolated experiment used the development-only `--allow-dirty` option.
The separate production release procedure must validate the real updater,
backup and restore under systemd, and must classify the production home.

The app-server schema adds moderation display instructions. The operator
chose to preserve the existing text display and history behavior and emit a
fixed diagnostic classification for completed items. If that diagnostic appears
once, ask the operator to reconsider the handling. The diagnostic does not
include message text, reason or item ID. Journal delivery uses the existing
wrapper stderr path; the new line has not been observed from a real moderated
response. No model was prompted to produce moderation metadata.
