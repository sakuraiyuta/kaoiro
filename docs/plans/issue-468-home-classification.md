---
title: Production Codex home classification correction
status: proposed
last_updated: 2026-10-01
---

# Production Codex home classification correction

Baseline: `b4770ee07628b25144ae34be39e396fe8efc39d3`.
Branch: `issue-468-classify-home-links`. Design review precedes code edits.
The director reports production top-level names and three instruction symlinks;
the implementer has not inspected production. The director confirmed 33 names
(correcting the original count of 34), with no omitted name: memories_1.sqlite
has no sidecars; goals_1/logs_2/queue_1/state_5/thread_history_1 each have the
main DB plus -shm and -wal. The fixture will assert exactly that topology.

## Problem and decision

The metadata classifier refuses `agents` before reaching the other four known
but omitted entries. This is a safe pre-stop refusal, but prevents the approved
state-aware update. Add exactly five root names to the existing categories:

| Root name | Category | Reason |
| --- | --- | --- |
| `agents`, `hooks`, `model-profiles` | state | The production-home runbook explicitly creates these instruction links. |
| `plugins` | state | Installed bundles, persisted installation identity and plugin data must survive restore, even though one subtree is named cache. |
| `cache` | disposable | Upstream stores re-fetchable connector/plugin metadata and generated/downloaded TUI pet assets here. |

Preserving all five as state would avoid cache reconstruction, but would copy
re-fetchable, identity-scoped catalog data unnecessarily. Discarding plugins
would lose local installations and plugin data; that option is rejected.
Use exact-name sets, with no prefix, wildcard or unknown-entry exemption.
Existing state-subtree recursion applies to plugins, including its `cache/`;
only the distinct home-root `cache` is disposable. This distinction is tested.

Existing inventory/copy/restore already record link text and use lstat/readlink
and symlink creation without traversing link targets. Keep that mechanism.
Instruction links (and AGENTS.md) are preserved as links; the external
ai-settings content itself is not backed up or frozen. Restoring the link does
not roll back changes to that external repository. Ordinary directories under
these exact state names use the existing recursive state semantics too.

Credential exclusion remains the exact upstream-owned root set: auth.json,
.credentials.json, secrets and mcp-oauth-locks. Plugin manifests/user plugin data
can themselves contain sensitive values; as already documented for arbitrary
configuration/rollouts, this is not a general secret scrubber. Snapshots must
remain private, outside synchronization and external backups. Do not infer
absence of plugin-specific secrets from the absence of root credentials.

## Upstream evidence inspected

Tag `rust-v0.159.3` resolves to commit
`01fc69f4026735edfdf6789820549727a4867b11` (annotated tag object
`8e46774a94a745ffdf676bd7a8aa36466bbd4f99`). Sources were downloaded into owned
scratch, with no native execution and no authenticated home access.

- [Plugin store](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/core-plugins/src/store.rs#L24): plugins/cache and plugins/data roots (lines 24–25, 84–96), per-plugin data roots (118–144), and persisted installation metadata (197–232).
- [Installed identity](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/core-plugin-common/src/installed.rs#L10): installed-version selection and remote installation identity.
- [Plugin catalog cache](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/core-plugins/src/remote/catalog_cache.rs#L17): cache/remote_plugin_catalog, TTL, missing/invalid cache returning no cached value (85–121).
- [Connector directory](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/connectors/src/directory_cache.rs#L13): cache/codex_app_directory, Missing/Invalid handling; connectors/src/lib.rs (172–206) fetches the directory when cache is not usable.
- [Connector runtime](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/connectors/src/connector_runtime/persistence.rs#L30): cache/codex_apps_tools and cache/codex_apps_server_info; optional reads and serialized tools/server information (56–112).
- [Pet asset cache](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/pets/asset_pack.rs#L28): cache/tui-pets, validated CDN re-download on missing/invalid asset (35–80); pets/ambient.rs (157–164) builds generated frame caches there.

The runbook explicitly creates auth.json, config.toml and the four links
AGENTS.md/agents/hooks/model-profiles. The first two and AGENTS.md already have
categories. Runtime DBs, sessions, locks and other already-listed entries retain
their current categories; no production content or attributes were sampled.

## Scope and verification

Change only the snapshot classification constants, the focused snapshot tests,
and relevant documentation/evidence. No native pin, credential rule, updater
state-machine, production file, installed release or unit changes. The former
negative fixture named `plugins` becomes another truly unknown root; retaining
that case unchanged would contradict the newly authorized classification.

1. Build an owned fixture from the director-confirmed complete root-name list.
   Use actual SQLite DBs/sidecars for the DB names (Node child process), isolated
   fake instruction targets, installed-plugin metadata/data and root cache
   sentinels. Assert the exact sorted root list/count before classification.
2. Run the actual classify CLI: baseline must reject before snapshot or other
   mutation. After the fix it must classify the complete topology. Snapshot and
   restore must preserve link type/target and plugin bytes; root cache and root
   credentials must not be in payload. Refreshed credentials remain current.
3. Explicitly check external link targets are not copied or traversed, and that
   restoring links does not mutate their targets. Existing link restrictions
   (session/DB links and credential links) remain refusals.
4. Unknown roots and credential-looking unknown sidecars must still fail before
   creating snapshot staging. Removing each added classification must break its
   test; removing unknown-root refusal must break the refusal test. Include a
   plugin-cache versus root-cache control to prevent category conflation.
5. Build wrapper prerequisites; run Runner full suite and typecheck with inherited
   CODEX_HOME removed and an isolated HOME. Capture counts, exits and warnings.
   No live turn, production classify, production read or systemd action is needed.
6. Verify the packaged classifier from the new release (strict deploy manifest),
   against the same owned fixture and an unknown-entry negative; bind the evidence
   to the final source/artifact hashes. The native pin remains unchanged.

Update codex-home.md and the backup design's classification paragraph to explain
link preservation, plugin state and disposable root cache. Add a dated evidence
record with source links/hashes, baseline failure, positive tests and mutation
results. Keep the production plan's pre-stop refusal gate; revise its target
only after review/landing supplies the actual deploy commit. Until then the old
plan must not be interpreted as authorizing an allowlist bypass.
