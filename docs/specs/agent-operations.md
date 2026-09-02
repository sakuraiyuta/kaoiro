---
title: Agent operations (multi-agent workflow)
description: Operating rules for multiple agents working concurrently in the same work tree. Applies to both implementation and dispatch (director) sides, regardless of engine.
status: accepted
related: [protocol-inter-agent, personas]
---

# Agent operations (multi-agent workflow)

## Purpose

Multiple agents work through kaoiro's backlog concurrently in the same work
tree. This file is the **source of truth** for the operating rules that apply
then, **regardless of engine**. Claude Code users are directed here from
[CLAUDE.md](../../CLAUDE.md), and Codex users from [AGENTS.md](../../AGENTS.md).

This file contains only rules that arise from multiple agents operating at the
same time. CLAUDE.md is the source of truth for project structure, commands,
and branch operation; [protocol-inter-agent](protocol-inter-agent.md) is the
source of truth for the inter-agent messaging protocol (envelope schema, hard
limits, and the turn-number contract).

## Implementation side

- Do not decide independently on points identified as requiring judgment, or on
  discrepancies found while implementing that change the task's actual scope;
  send a query to the dispatch source. Hold the exchange **before
  implementation**. Raising it only with the completion report leaves the
  recipient no opportunity to decide.
- A defect introduced by your change is in scope. Ask: “Would reverting my diff
  remove this defect?” If so, fix and report it (a query would only add an
  exchange; nothing remains for the director to decide). If not, query first.
  If the fix would leave the assigned subdirectory, however, prioritize the
  subdirectory rule below and query.
- Do not touch outside the assigned subdirectory. Report problems found there
  only.
- Do not revert or stage another agent's uncommitted changes. Treat an
  unexpected diff outside your scope as work in progress and report only its
  presence.
- Git: do not amend a pushed commit. Do not use `git add -A`; explicitly add
  only files you changed. Do not insert a commit into the same branch while a
  peer's Git operation is pending.
- Treat a peer's working clone or worktree like the shared work tree. Restrict
  yourself to read-only Git operations (`show` / `log` / `diff` / `cat-file` /
  `for-each-ref`); only its owner may run state-changing operations such as
  `checkout` / `fetch` / `branch` / `stash`. Moving the owner's HEAD can leave
  an unmerged commit behind on a detached HEAD, and the owner may not notice it
  was lost until following the reflog. Ask the owner whether uncommitted changes
  exist—`status` writes stat data back to the index, so it is not an operation
  to run from outside.
- A conversation ends only after both parties have sent `done=true`. Send it
  yourself even if the other party sent it first.
- Save flaky-test output before rerunning. The test name, stack trace, and seed
  are lost the moment a rerun is green (on failure, ExUnit prints a
  `mix test --seed <N>` reproduction command).
- Confirm for each artifact where an agreed fix landed. When one agreement has
  multiple destinations (code / ADR / issue body / proposal text), do not check
  one and infer the rest.

## Worktree isolation for implementers

- Do implementation work (assignments that edit files) in a dedicated Git
  worktree at `<repo>/worktrees/<persona>[-<issue>]/`, never directly in the
  shared work tree. Example:
  `git worktree add worktrees/momo-210 -b issue-210-topic develop`. For
  concurrent work, create one worktree per task using this `-<issue>` path
  suffix, then remove it with `git worktree remove` when closed. `/worktrees/`
  is gitignored.
- The worktree resides inside the repository because an agent sandbox may write
  only beneath its session cwd. An external path or separate clone would fail
  on permissions.
- Follow CLAUDE.md's branch strategy: create an `issue-NNN-*` branch from
  develop, then fast-forward it back to develop when finished. Because Git
  rejects a branch being checked out twice, worktree isolation entails branch
  isolation.
- Treat the shared work tree (repository root) as an integration, review, and
  director-reading surface; do not introduce uncommitted implementation hunks.
- After creating a worktree, each person runs `pnpm install` / `mix deps.get`
  because dependencies are not copied. Remove an unneeded worktree with
  `git worktree remove`.
- Why: file-level staging while multiple writers' uncommitted hunks coexisted in
  the same file pulled another person's hunks into commits twice (2026-08-28,
  issue #232 / #203 `App.svelte`).

## Dispatch side (director)

- Do not impose a mechanism unavailable to a peer's engine as a completion
  criterion. Claude Code custom skills and hook pipelines (such as
  `/my-code-review-cycle`) are available only to peers with
  `engine: claude-code`. Instead, enumerate concrete checks in the dispatch:
  self-review of the diff, typecheck/tests for the affected scope, proof that a
  bugfix is effective through a mutation or negative control, and external
  review.
- Read the current session's rate-limit utilization from `whoami`'s
  `rate_limits` ([#244](https://github.com/sakuraiyuta/kaoiro/issues/244)).
  Since `list_agents` excludes its caller, this is the only self-observation
  surface. A peer's value can stand in only when a shared quota pool is
  confirmed; matching engine names do not prove sharing. The source of truth
  for interpreting fields (absent means unknown, a snapshot is from the last
  turn, and a value is stale after `resets_at` passes) is the `list_agents` tool
  description, and `whoami` follows the same rules.
- When a delegation instruction includes your technical premise, explicitly
  require the recipient to measure and decide, and to report its decision and
  evidence. Giving only a declarative premise risks implementing it unchanged
  even when it is wrong.
- Name a delegation's deliverable as a **unit of result** (“N items merged with
  the checker green”), and state the review-round budget explicitly. Exceeding
  the budget produces a reporting obligation, not another round.
- Observe the deliverable's progress, not the volume of activity. A rising
  message count while the unit of result stands still is the best available
  signal of a review quagmire.

## Round budget for review cycles

Applies to reviews run between peers, a reviewer and an implementer. Depth
itself has value where it belongs—what is bounded here is how that depth is
allocated and how many round trips it may take, and every trigger is judged by
**something you can simply count**.

| Trigger | Threshold | Obligation on firing |
|---|---|---|
| Cumulative must-fix rounds on one deliverable | more than 3 rounds | Both reviewer and implementer stop and report to the director |
| Findings confined to failure modes of a tool built during the task | 2 consecutive rounds | Stop; the director rules on whether the tool should exist |
| Change of the target or the verifier during a review round | 0 (freeze) | Change only at a round boundary. Evidence from a round that broke the freeze is void |
| Cumulative conversation round trips on one deliverable | 20 round trips | Close the conversation and escalate the judgment to the director with a summary |

- The counter's population is the deliverable, and **the parties cannot reset
  it**. Swapping the artifact, moving the verifier, or reopening the
  conversation does not return it to 0 (a swap at a round boundary is a
  legitimate change, but the count carries over). The director holds the
  running total and states its current value at dispatch and at the start of
  each round. **The ledger holder (the director) dispatches the review rounds
  personally**—once the ledger and the dispatch sit in different hands, the
  accuracy of the total depends on reconciling conversations. Counted per
  artifact, the M18 quagmire, where the verifier moved three times, still read
  as 1: a counter whose population moves is not a valve.
- Reaching a threshold is a valve by design, not anyone's fault. Escalation is
  an obligation, not a defeat. Precise in-round procedure such as permits and
  hash binding is no substitute for the reporting obligation—the better the
  procedure looks, the more legitimate staying inside the loop appears.
- Allocation of verification depth (not subjecting a throwaway tool to
  adversarial review) is governed by each agent's global rules (Claude:
  rules/verification.md “Depth is set by blast radius”; Codex: the verification
  section of AGENTS.md). It is not duplicated here.

Why: during the translation wave for issue #91 on 2026-08-24, must-fix rounds
on a throwaway merge script reached M18 (dozens of round trips, zero
deliverable progress, no escalation). Each round was locally faithful to the
discipline, and the only anomalies observable from outside were the round count
and the stalled result.
