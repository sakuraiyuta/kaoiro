---
title: Release notes
description: One page per production release, listing what changed since the previous production release.
status: accepted
last_updated: 2026-10-28
---

# Release notes

Each page records one **production release**: the changes between the
previous production release and this one, the operator steps the upgrade
needs, and the issues found during or right after it.

Until cutover C of the [issue 709 plan](../plans/issue-709-release-reduction.md),
a version tag was created on every develop landing, so most of those tags never
reached production on their own. Cutover C completed on 2026-10-24: landings no
longer create tags (C3), and [v2026.10.24.1](v2026.10.24.1.md) at
`d0c43ed3c54016df8f5cb520aa6c286890922c16` is the first release tag (C4). Tags
before it mean "landed"; tags from it on mean "released". The release operator
creates one release tag per production release with
`scripts/release-tag.mjs plan`
([Release tags](../operations/build-identity-and-release-tags.md#release-tags)). A release note covers the
whole range of tags that went to production together and is named after the
tag that was deployed: `docs/release/<tag>.md`.

Release notes are historical by nature. Like ADRs, they are exempt from the
rule that documentation describes only the current state: do not rewrite an
old note to match later behaviour, and link to the current contract instead.

## Writing a note

Whoever prepares a production release writes the note and lands it on
develop **before** creating the release tag, and creates the tag on the commit
that contains the note. Checking out a release tag therefore includes the
note that describes it.

1. Plan the tag name with `scripts/release-tag.mjs plan` on the code that will
   be released, and name the note after it. The name depends on the UTC date:
   if the date changes before the tag is created, plan again and rename the
   note.
2. Collect the range with
   `git log --reverse --format='%h %s' <previous tag>..HEAD` and the issues
   the commits reference.
3. Group user-visible changes by area and give each its issue number. Leave
   out test-only and plan-only commits unless they change how the project is
   operated.
4. List the operator steps the upgrade needs (configuration changes, new
   runner capabilities, the release class from
   [High-risk change release](../operations/high-risk-change-release.md)).
5. Add a line to the index below, newest first.
6. Land the note on develop, then plan the tag again on that commit and create
   it there. The note names the tag and the previous release; it does not
   record its own commit SHA, which is only known after the note is committed.
   Read the commit from the tag.

What is only known after the release (the deployment date and times, results
on the operator's hosts) stays in the production run record outside the
repository. Known issues found after the release are added to the note on
develop later; the tagged copy keeps the note as released.

The repository is public. Do not write host names, deployment layout,
per-host results or other details of an operator's environment; keep
production run records outside the repository.

## Releases

| Release | Date | Previous | Highlights |
|---|---|---|---|
| [v2026.11.01.1](v2026.11.01.1.md) | 2026-11-01 | v2026.10.28.2 | OAuth device authorization grant for native clients, environment-consistency checks in the server deploy CLI, read-only observation of runner Codex work, live grid order and grid card faces in the dashboard |
| [v2026.10.28.2](v2026.10.28.2.md) | 2026-10-28 | v2026.10.28.1 | New persona anzu, readable status-line links in the dashboard, a Service column in the Codex state recovery table of the runner runbook |
| [v2026.10.28.1](v2026.10.28.1.md) | 2026-10-28 | v2026.10.26.1 | Codex CLI and SDK 0.164.0 with GPT-6.1 Terra, Codex state classification that recognizes external daemon home entries, preparation tool for the Codex backend default change, pending dialogs kept across later envelopes, delivery binding that survives a ledger restart (v2026.10.27.1 was tagged but never deployed) |
| [v2026.10.26.1](v2026.10.26.1.md) | 2026-10-26 | v2026.10.25.1 | Configurable work-item admission limits with operator controls, Bandit 1.14.0 |
| [v2026.10.25.1](v2026.10.25.1.md) | 2026-10-25 | v2026.10.24.1 | Minimized native Codex state, Codex recovery hints from one table, retired landing tags and release publication, Bandit 1.13.1 and xmldom 0.9.12 |
| [v2026.10.24.1](v2026.10.24.1.md) | 2026-10-24 | v2026.10.22.11 | First schema-2 release tag, Antigravity weekly rate limit and result size, surrogate-safe text cuts, directory names in the remaining dashboard places |
| [v2026.10.22.11](v2026.10.22.11.md) | 2026-10-23 | v2026.10.21.1 | Deploy CLI binds the Compose override to its transactions, build identity reads schema-2 release tags |
| [v2026.10.21.1](v2026.10.21.1.md) | 2026-10-22 | v2026.10.20.5 | Claude Code peers on Agent SDK 0.3.306 (Claude Code 2.1.306) |
| [v2026.10.20.5](v2026.10.20.5.md) | 2026-10-20 | v2026.10.18.1 | Sends from turns started by Monitor notifications, Codex operator steer by delivery policy, a recovery command for every server deploy phase |
| [v2026.10.18.1](v2026.10.18.1.md) | 2026-10-18 | v2026.10.17.1 | Directors reset the session of their assigned peer, operator session lifecycle history in the agent detail view, follow-up sends after an inline-recovery reply |
| [v2026.10.17.1](v2026.10.17.1.md) | 2026-10-17 | v2026.10.15.22 | Claude Code peers own native continuations by default, replies from subagent hand-backs and Monitor or background-task notifications |
| [v2026.10.15.22](v2026.10.15.22.md) | 2026-10-16 | v2026.10.15.17 | Grok peers resumed from a full-access history run again, `whoami` reports the agent's display name |
| [v2026.10.15.17](v2026.10.15.17.md) | 2026-10-16 | v2026.10.15.9 | HTTP/2 off pending a Bandit fix, display names and persona faces in the timeline, personas shirogane and moegi, `list_agents` names that follow renames |
| [v2026.10.15.9](v2026.10.15.9.md) | 2026-10-15 | v2026.10.15.4 | `KAOIRO_AGENT` marker for managed engines, Codex session reset without a dialog under autonomous approval, Antigravity startup and Grok weekly rate limits |
| [v2026.10.15.4](v2026.10.15.4.md) | 2026-10-15 | v2026.10.14.13 | Grok Build work units 3 and 4: cold resume, session discovery, history replay, launch catalog, live model and effort switching, context usage |
| [v2026.10.14.13](v2026.10.14.13.md) | 2026-10-14 | v2026.10.10.2 | Grok Build engine (work units 1 and 2), authenticated HTTP MCP for Grok, permission gate stop in the dashboard |
