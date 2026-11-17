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
2. **Change the pin.** Edit the range in `wrapper/claude-code/package.json`
   and run `pnpm install`. Compare the dependency shape of the old and new
   package: `peerDependencies`, `exports`, `engines.node` and the set of
   platform packages. Commit the pin and the lockfile.
3. **Read the changelogs in full.** The SDK changelog between the old and the
   new version, and the bundled CLI changelog
   ([anthropics/claude-code `CHANGELOG.md`](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md))
   for every CLI version in between. Record the ranges read. Quote verbatim,
   with its version, every entry about folding and queued input, permissions,
   hooks or model switching, and every change the operator can see, and name
   the kaoiro code path it reaches. A version without a published section is
   recorded as unread.
4. **Re-measure E1 to E4** on the pin commit with the
   [fold premise harness](../../wrapper/claude-code/test/fold-premises/README.md).
   Do not carry a verdict forward. If the run fails, run it once on the
   previous pin to tell a harness problem from a premise change.
5. **Run the checks.** Pre-landing CI on the candidate
   ([CI before landing](ci-before-landing.md)); in `wrapper/claude-code`,
   `KAOIRO_LIVE_CLAUDE=1 pnpm exec vitest run test/haiku55_native.test.ts`;
   and the catalog probe `node wrapper/claude-code/dist/probe.js` on the base
   commit and on the candidate. Record the catalog rows that differ.
6. **Judge the exit conditions** of ADR-0074 one by one.
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
| E1 to E4 | the run's identity, the four harness hashes (and, if `probe.mjs` changed, the commit), the summary lines |
| Checks | the CI run URL, the `haiku55_native` result, the catalog rows that differ |
| Exit conditions | each condition of ADR-0074: met or not, in one line |
| Release-note candidates | new, removed or moved catalog rows and other changes the operator can see |
| Limits | what this bump did not measure |

## Version strings that stay

After a bump, the old SDK or CLI version may still appear outside `docs/` and
the lockfile only in these places. Anything else is a pin that was missed.

- `wrapper/claude-code/package.json` and `wrapper/codex/package.json`: the
  dependency lines that pnpm reads.
- `wrapper/codex/README.md`: the description of the current Codex pin.
- Captures recorded on a named version and their loaders, which do not assert
  the installed version, such as
  `wrapper/claude-code/test/fixtures/claude-cli-2.1.321-completion-summaries.json`
  and `completion_summaries.ts`.
- `runner/deploy/codex-snapshot.mjs`: the Codex source versions its
  classification was read against.
- The Codex approval capture `app_server_approval_decline_<version>.*`, the
  file names that read it in `app_server_rpc_server_request.test.ts`, and that
  test's stale-version negative control (the `/<version>` user-agent string
  it replaces). It is recaptured on each Codex pin.
