---
title: Externalizing the common footer — system-footer.md and user-footer.md
status: accepted
date: 2026-08-03
opened: 2026-08-02
supersedes: []
superseded_by: null
related_specs: [persona-personality-injection, persona-pack-schema]
related_adrs: [29, 44, 46]
---

# ADR-0045 — Externalizing the common footer

## Status

Accepted (drafted 2026-08-02, approved by マスター on 2026-08-03).
Partially revises F5 / D5 of
[ADR-0029](0029-persona-server-sot-and-pack-distribution.md) (does not
supersede it).

At drafting time, acceptance required comparison with the **wording** of the
footer being finalized by [#165](https://github.com/sakuraiyuta/kaoiro/issues/165)
(implementation of [ADR-0044](0044-coordination-injection-hitl.md)). However,
trying the wording itself was mutually blocked by the need for the mechanism in
this ADR. The decision therefore separated mechanism and wording and accepted
only the mechanism. The built-in default wording remained current as of drafting;
the coordination-guideline wording was added in the same issue
([ADR-0044](0044-coordination-injection-hitl.md) F1 addendum, Option A finalized).

## Context

Although the common footer is an operational parameter that is always placed at
the end of every agent's system prompt, at drafting time it was hard-coded in an
Elixir module attribute (`@common_footer` in
`server/lib/kaoiro_server/persona_assets.ex`). Even a one-character change
required rebuilding and redeploying the server.

This became a practical problem when finalizing the wording for ADR-0044 F1
(coordination-footer-scope was unresolved at drafting and later settled as
Option A in #165). The natural approach of “prototype short behavioral
principles and measure what is missing” could not work when every trial required a
build.

Meanwhile, the personality description (`personality.md`) was already a file in
the pack and editable by the operator. Only the common footer remained on the
code side.

There are two constraints. The installation directory may be mounted `:ro`, so a
design that assumes the server writes files there is not possible. Also, the
extraction cache of the persona installation directory has been moved outside the
persona dir by [ADR-0046](0046-persona-cache-relocation.md), making the persona
dir mountable as `:ro`. The footer is separated from the persona pack's
operational files by using a dedicated root (F1).

## Decision

### F1: Built-in default plus file priority for the default footer

Embed the default wording in the server binary, and **completely replace** the
built-in version with the contents of `system-footer.md` when it exists in the
footer installation directory. Use the built-in version when the file is absent /
empty (an empty string after trim); do not fail-closed.

Specify the footer installation directory with the new env
`KAOIRO_FOOTER_DIR`. **When it is unset, file priority is disabled** (built-in
only, with no user-footer), and do not place a footer in the persona installation
directory (`KAOIRO_PERSONA_DIR`). There are two reasons for the separation: do not
mix the pack's SoT, whose persona dir can be mounted `:ro`, with operational files;
and avoid operational files entering git / the Docker build context because the
default pack dir is tracked in the repo. In a container, assume a mount such as
`./footers:/etc/kaoiro/footers:ro`, a `:ro` mount. Changes to the env/path take effect after a
server restart (the watcher's monitored root is fixed at startup).

The physical source of the built-in default is not a module attribute but
`server/priv/footers/system-footer.md` (build source, also included in the
release's `priv/`). Track it for recompilation with `@external_resource` and
load it with `File.read!` at compile time. Operators can inspect this file in the
repository or bundled release to confirm the default wording, without a separate
`.example`, duplicated docs, or a dump task (the drafting-time open question
footer-default-visibility is resolved here).

### F2: One `user-footer.md` for the operator's custom footer

Concatenate `user-footer.md` from the footer installation directory (F1) at the
**end** of the footer prompt. The composition order is
`preset + personality → system-footer → user-footer`. Use the same blank-line
separator (`\n\n`) as the existing personality / footer composition. When empty or
absent, collapse to “add nothing.” Handle read_error according to F6 (collapse on
cold start, retain the previous good value while running).
`system-footer.md` / `user-footer.md` are each **one file shared by all personas**;
do not provide a persona-specific overlay (`user-footer.<persona_id>.md`). Express
persona-specific instructions in the pack's `personality.md` as before.

### F3: Do not put the operator footer in the repository

`system-footer.md` / `user-footer.md` are “operational configuration files that
vary by environment,” like env settings, and are not committed to the repository.
Because F1 separates the root and puts the default location outside the repo, no
exclusion lines are needed in `.gitignore` / `.dockerignore` (the drafting-time
proposal to colocate them in the repo-tracked pack dir required both).

### F4: Apply through a watcher from the next connection

Only when `KAOIRO_FOOTER_DIR` is set, monitor the **exact filenames**
`system-footer.md` / `user-footer.md` directly under that directory with a
dedicated watcher (separate from the persona-pack watcher; do not broaden it to
arbitrary `*.md`) and rebuild without restarting the server. If both files are
updated within the debounce window, temporarily mixed old/new snapshots are
allowed; the rebuild immediately afterward converges. Do not apply changes to
wrappers already connected; they take effect from the snapshot of the next
wrapper connection ([ADR-0029](0029-persona-server-sot-and-pack-distribution.md)
F9 remains in force).

Even when `KAOIRO_FOOTER_DIR` is configured, if the directory is missing or
unreadable, start with fail-soft behavior on cold start (built-in only + warn) and
leave the watch disabled. The server does not mkdir (assume `:ro`). Enabling it
after creating the directory requires a restart.

### F5: Always make the composed result visible in rebuild logs

On every rebuild, log at info level for each layer the two axes
`input_state=file|missing|empty|read_error` /
`effective_source=file|built-in|last-known-good|absent`, plus the character count
and short SHA-256 of the effective value (after F6 normalization). For example,
when system is missing, input_state=missing and effective_source=built-in. For
read_error, also log the absolute path and reason at warn level (do not silently
fail). Do not set a length warning threshold (there is no well-founded threshold,
and constant warnings would be ignored). Discoverability of bloat and tracing of
the delivered string from the three-layer composition (the Negative below) are
guaranteed by character count + hash; this settles the length-guarantee question
(the wording question remained as coordination-footer-scope at drafting and was
later fixed as Option A in #165).

### F6: Read semantics

- UTF-8 is required. The effective value is the body normalized in this order:
  **remove BOM → normalize CRLF→LF → trim**. Determine “empty” and the F5
  character count / hash from this effective value. Treat invalid UTF-8 as
  read_error (do not crash the rebuild).
- Read regular files only. Reject symlinks, FIFOs, and other types as read_error
  (to avoid blocking in `File.read` on a FIFO and to avoid the watcher missing
  changes to a target outside the root).
- Treat a cold-start read_error like absence (system → built-in, user → none).
  During operation, retain the **previous good value** on a transient read_error
  (to prevent a short atomic-save or permission-change window from making the
  convention disappear for only new connections). Emit the F5 warning in both
  cases.
- Set no byte limit (explicitly treat this as trusted local input with no
  operational cap).

## Consequences

### Positive

- Trying footer wording no longer requires a rebuild, allowing ADR-0044 F1 wording
  to be finalized by starting with Option A and measuring it (#165).
- The kaoiro default (`system-footer.md`) and operational rules (`user-footer.md`)
  are separated, so custom instructions can be retained while incorporating
  default updates.
- The footer root needs read-only access only and works with a `:ro` mount
  configuration (separated from the `.cache` write problem during pack ingest).
  In containers, the two footer files can be edited persistently without replacing
  bundled packs.

### Negative

- Prompt injection now has three layers (personality / system / user), making the
  actually delivered string harder to trace. F5 rebuild logs (source + character
  count) provide a tracing anchor.
- An operator who places `system-footer.md` no longer receives default updates
  from kaoiro (an intentional override, and the reason `user-footer.md` exists).
- Free-form operator text is consumed as context continuously by every agent.
  Keep no warning threshold (F5); log visibility lets operators notice bloat.

### Neutral

- ADR-0029 F5 (composition is the server's responsibility; the wrapper injects the
  received string unchanged) is unchanged. The only change is whether the wording
  SoT is code or a file.
- Show the actual default wording directly from F1's
  `priv/footers/system-footer.md` file (the drafting-time open question
  footer-default-visibility is resolved and closed here).

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Colocate the footer in the root of the persona installation directory (drafting-time proposal) | `:ro` cannot be guaranteed because pack ingest writes `.cache`, and operational files in the repo-tracked default directory can enter git / the Docker build. A dedicated root (`KAOIRO_FOOTER_DIR`) removes both problems |
| Seed-write the default wording at startup | Does not work in `:ro` mount environments. Once written, updates on the distribution side do not reach existing installations |
| Make `system-footer.md` mandatory (fail-closed) | Existing environments would die immediately on upgrade. Migration would become mandatory, giving the footer a stronger constraint than ADR-0029 F3 |
| Two layers: common + persona-specific user footer | Four injection layers make tracing the actual prompt impractical |
| Persona-specific user footer only | Adding one line of a rule common to all agents would require editing every persona's file |
| Commit footer files to the repository | Their contents vary by environment and would cause conflicts. Treating them like env settings is natural |
| Hot-swap into connected sessions | Conflicts with ADR-0029 F9 (do not introduce uncertainty from changing a persona during a conversation) |
| Apply only on server restart | Does not reduce the cost of trying wording and defeats the main purpose of externalization |
| Distribute `system-footer.md.example` separately to show the default wording | Duplicates the built-in version and the example, allowing drift to cause confusion. Embedding F1's actual `priv/` file shows the actual content |
| Reproduce the full default wording in docs | The copy source becomes a code block in an md file, creating formatting failures and transcription drift |
| Dump it with a mix task to show the default wording | Depends on the execution environment (in container operation, `docker exec`). The actual `priv/` file is sufficient |
| Length guard: warn from the server above a threshold (L2) | There is no basis for the threshold. Constant warnings would be ignored; F5 log visibility is sufficient |
