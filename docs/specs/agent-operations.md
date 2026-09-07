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
  are lost the moment a rerun is green, and ExUnit does not hand them back:
  the seed appears only in the run's header (`Running ExUnit with seed: <N>,
  max_cases: <M>`), and a failing run ends with the counts alone — no seed,
  no reproduction command (measured on Elixir 1.20.1). Keeping the tail of
  the output therefore drops the seed. Use `scripts/mix-test.sh`, which tees
  the whole run to a file and keeps it whenever the run does not pass.
- A completion report states, for every gate command, the exit code and
  whether unhandled errors or warnings were emitted, not the pass count
  alone. A suite can report every test green and still exit non-zero
  (vitest unhandled errors, ExUnit `--warnings-as-errors`); a count-only
  report hides exactly the failure CI will surface (2026-09-06, issue #307).
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

## Shared-host process discipline

- Send signals (`kill`, `docker stop`, `systemctl stop`, ...) only to processes
  you spawned yourself and whose PID you kept from the spawn. Never select a
  target by pattern (`pgrep -f`, `pkill -f`, `killall`, `docker ps | grep`):
  on a shared host the first match is as likely to be another agent's test
  run, a peer's verification BEAM, or the runner supervising every session.
- When a probe needs to kill a process (crash / SIGKILL durability tests),
  start that process from the test itself and hold its PID or port; assert
  the identity before signalling.
- Cleanup follows the same rule: remove only scratch directories, worktrees
  and containers you created, named so that ownership is visible. When two
  sessions share a persona name, put the display name (`kuroe-sub`, not
  `kuroe`) in the scratch name; a reviewer must be able to tell whose
  28 MB repo copy under `/tmp` is still live without asking.
- Why: a `pgrep -f beam.smp | head -1` followed by `kill -9` during a review
  probe could not be confirmed to have hit the reviewer's own child
  (2026-09-06, issue #305 B round 2). Nothing in production was affected,
  but on this host the same pattern can match a peer's `mix test` or the
  kaoiro runner.

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
- The round budget is a process rule, and this document is where it lives. The
  server also detects a long rally structurally and shows the operator a
  notice — counted per agent PAIR across conversations, because opening a
  fresh `conversation_id` does not reset a review loop. That notice is
  advisory: it never closes a conversation and never messages an agent. See
  [protocol-inter-agent](protocol-inter-agent.md) "Review-quagmire detection".
- The threshold that notice fires on is the operator's to set, from the
  dashboard settings drawer, without a server restart. Director-style
  operation holds several long review loops at once, so the shipped default
  can put a permanent banner on every active pair. Raise it, or turn rally
  detection off (∞), rather than reading past banners that never clear —
  a notice nobody acts on is worth nothing. The threshold is
  deployment-wide, not per director.
