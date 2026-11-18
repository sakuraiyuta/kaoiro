---
title: Agent SDK bump checklist
status: accepted
last_updated: 2026-11-18
description: The steps for raising @anthropic-ai/claude-agent-sdk in wrapper/claude-code under the standing design, the short evidence form, and the version strings that stay on purpose.
---

# Agent SDK bump checklist

This checklist covers a change to `@anthropic-ai/claude-agent-sdk` in
`wrapper/claude-code`. It is the standing design of
[ADR-0074](../adr/0074-standing-design-for-engine-pin-bumps.md): a bump that
meets none of that ADR's exit conditions needs no design of its own. It gets
one implementation review by a reviewer of another model family, must 0, and
reaches production only through an operator release
([High-risk change release](../operations/high-risk-change-release.md)).
A bump that meets an exit condition goes back to a full design.

## Steps

1. **Choose the version.** The default is the latest published version
   (`npm view @anthropic-ai/claude-agent-sdk dist-tags --json`). Record the
   version, its publication time, the `dist-tags.latest` value at the time you
   chose, and every skipped version with its reason (for example, never
   published).
2. **Change the pin.** First, on the base commit, build the wrapper and save
   the catalog probe's output (`node wrapper/claude-code/dist/probe.js`) for
   step 5. Then edit the range in `wrapper/claude-code/package.json` and run
   `pnpm install`. Compare the dependency shape of the old and new
   package: `peerDependencies`, `exports`, `engines.node` and the set of
   platform packages. Commit the pin and the lockfile.
3. **Read the changelogs in full.** The SDK changelog between the old and the
   new version, and the bundled CLI changelog
   ([anthropics/claude-code `CHANGELOG.md`](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md))
   for every CLI version in between. Record the ranges read. Quote verbatim,
   with its version, every entry about folding and queued input, permissions,
   hooks or model switching, and every change the operator can see through a
   kaoiro peer, and name the kaoiro code path it reaches. A version without a published section is
   recorded as unread.
4. **Re-measure E1 to E4** on the pin commit with the
   [fold premise harness](../../wrapper/claude-code/test/fold-premises/README.md).
   Do not carry a verdict forward. If the run fails, run it once on the
   previous pin to tell a harness problem from a premise change.
5. **Run the checks** after building the wrapper and the runner on the
   candidate. Pre-landing CI ([CI before landing](ci-before-landing.md)); in
   `wrapper/claude-code`,
   `KAOIRO_LIVE_CLAUDE=1 pnpm exec vitest run test/haiku55_native.test.ts`;
   and the catalog probe, whose rows that differ from the base output of
   step 2 you record.
6. **Judge the exit conditions** of ADR-0074 one by one. X4 is about
   kaoiro's own behaviour: a vendor change that kaoiro only relays to the
   operator, such as most permission changes, is a release-note candidate.
   When an entry reaches kaoiro only under a condition you did not measure,
   name that condition under Limits for the reviewer.
7. **Write the evidence file** in the form below.

## Evidence form

One file under [docs/evidence/claude/](../evidence/claude/), about 60 to 120
lines, bound to the pin commit. Describe how something was measured by
linking the harness README and this page, not in prose.

| Section | Contents |
|---|---|
| Versions | SDK and CLI before and after, the chosen time and `dist-tags.latest`, skipped versions |
| Dependency shape | the four fields of step 2, old and new |
| Changelogs | ranges read, unread versions, the quoted entries with the path each reaches |
| E1 to E4 | the run's identity (its ID, or for a local run its composition: isolation, Node version, uid), the four harness hashes (and, if `probe.mjs` changed, the commit), the summary lines |
| Checks | the CI run URL, the `haiku55_native` result, the catalog rows that differ |
| Exit conditions | each condition of ADR-0074: met or not, in one line |
| Release-note candidates | new, removed or moved catalog rows and other changes the operator can see |
| Limits | what this bump did not measure |

## Version strings that stay

`package.json` and the lockfile are the pin. Outside `docs/` and the lockfile,
an old version string may stay only where it names the version something was
recorded or read on (a capture and its loader, a record, a source
reference) and nothing compares it with the installed version. A string that
a test or guard compares with the installed version, or prose that describes
the current pin, moves with the pin; a search for the outgoing version that
finds one has found a missed pin. A capture whose test requires it to match
the pin, such as the Codex approval capture with its stale-version negative
control, is recaptured with the pin.
