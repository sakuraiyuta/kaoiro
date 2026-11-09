---
title: Agent SDK bump checklist
status: accepted
last_updated: 2026-11-10
description: The steps for raising @anthropic-ai/claude-agent-sdk in wrapper/claude-code, including the changelog reads and the input-folding re-measurement each bump must record.
---

# Agent SDK bump checklist

This checklist covers a change to `@anthropic-ai/claude-agent-sdk` in
`wrapper/claude-code`. Record each step in one dated evidence file under
[docs/evidence/claude/](../evidence/claude/), bound to the SDK and CLI
versions and the commit it was measured on.

1. **Choose the version.** Name the target version and the reason. The
   default is the latest published version; an earlier version needs a
   measured reason.
2. **Read the SDK changelog** between the old and the new version in full,
   including the parity-only releases. Record the range read, and for each
   change that touches kaoiro, the code path it was checked against.
3. **Read the bundled CLI changelog** for every CLI version between the old
   and the new bundled CLI (the version in the installed manifest and the
   native executable). The public changelog is
   [anthropics/claude-code `CHANGELOG.md`](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).
   Cite each relevant entry with its CLI version, quoted verbatim. Relevant
   means folding and queued input, permissions, hooks, or model switching.
4. **Re-measure the input-folding premises E1 to E4** on the new SDK, with the
   same premises and checks as the
   [2026-09-28 fold measurements](../evidence/issue-429/2026-09-28-claude-fold-measurements.md).
   Do not carry a verdict forward from an earlier bump; a premise that was not
   re-measured is recorded as not re-measured.
5. **Update the lockfile**, then re-pin the guards on the installed artifact.
   Search the whole tracked tree outside `docs/` and the lockfile for the
   outgoing SDK version, the outgoing CLI version and the outgoing artifact
   hashes, and move every assertion that is bound to the installed artifact.
   Do not stop at the files a failing test names: one guard can sit behind
   another that fails first. The same search must then find each new value.
   Run the wrapper, runner, server and dashboard suites and both typechecks.
   The commands are in [CLAUDE.md](../../CLAUDE.md#commands).
6. **Write the evidence file**: the versions, the date, the commit, the
   changelog ranges and citations, the E1 to E4 verdicts, and the limits of
   the measurement.
