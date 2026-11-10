---
title: AgentDetail detail tabs keep every item
description: The rendered item set of AgentDetail before and after the engine / kaoiro tab split, per input.
status: accepted
last_updated: 2026-11-11
related: [responsive-reachability]
---

# AgentDetail detail tabs keep every item

Measured on 2026-11-11 for
[issue #1075](https://github.com/sakuraiyuta/kaoiro/issues/1075): splitting the
detail area into an engine tab and a kaoiro tab must not drop, add or duplicate
any item. Both sides were rendered in jsdom (vitest) on a remote test host with
the derived dashboard e2e image.

## Method

- Inputs: `dashboard/test/fixtures/agentDetailTabInputs.ts`. Both sides used
  the same version of that file (sha256 `0d916ae9…7d6d`). The committed file
  differs from it in four places, none of which changes how an input renders:
  the first import loads the package's isolation setup; the fake connection
  stubs `enumerateAgentSessions` instead of `enumerateSessions` (only the
  resume picker calls it; the collector never opens it); input I3d was added
  later for a unit test and is not part of this measurement; and the
  collector's two helpers below were removed from it.
  I0 has a connection and nothing else; I1c is a connected Claude Code agent
  with every kaoiro item; I1r is I1c while running; I1x is a Codex agent with
  the sandbox axes, the three permission switches and a rejected request; I1u
  has the permission-control form with an unknown observation; I1g is a Grok
  agent; I2 is I1c disconnected; I3 is I1c without a connection.
- Collector: a scratch vitest file (not committed) mounts AgentDetail for each
  input in the order I0, I1c, I1r, I1x, I1u, I1g, I2, I3 and records, in the
  whole component, every `dt` text and every marker item, as a multiset. For
  I1x it first opens the sandbox switch and picks a value, which the fake
  rejects. The recorded list per input was:

  ```ts
  const dts = [...target.querySelectorAll("dt")].map((dt) => `dt:${dt.textContent?.trim() ?? ""}`);
  const items = ITEM_SELECTORS.flatMap((sel) =>
    [...target.querySelectorAll(sel)].map(() => `item:${sel}`),
  );
  return [...dts, ...items];
  ```

  with `ITEM_SELECTORS` as exported by the fixture
  (`.session-lifecycle-open`, `.delivery-policy`, `.clear-history`,
  `.resume-swap`, `.terminate`, `.restore`, `.interrupt`, `.remove`).
- Base: `239577e1`. Candidate: `61872767`. The two multisets are compared per
  input.

## Positive control at the base

Before the comparison the base run had to show all 19 row kinds of the status
panel and both forms of the effective write scope (I1x has `ext.permission`,
I1u only the permission control and shows the past observation that only that
form renders). `7day` is the pinned rate-limit gauge: it is not one of the 19
kinds and is left out of the Rows column, but each input's list holds it twice
(one per copy of the pinned area), so every Count below is the listed rows and
items plus 2.

| Input | Rows (`dt`) | Items outside `dl.cc` | Count |
|---|---|---|---|
| I0 | model, effort | `.clear-history`, `.resume-swap`, `.terminate` | 7 |
| I1c | model, effort, switch, cwd, engine, wrapper, resume, 作業意図, fast, IA 配送 | `.session-lifecycle-open`, `.delivery-policy`, `.clear-history`, `.resume-swap`, `.terminate` | 17 |
| I1r | model, effort, switch, cwd, engine, wrapper, resume, 作業意図, fast, IA 配送 | `.session-lifecycle-open`, `.delivery-policy`, `.clear-history`, `.resume-swap`, `.terminate`, `.interrupt` | 18 |
| I1x | model, effort, engine, 実効書込範囲, network_access, sandbox 変更, network 変更, 承認 変更, 権限要求, 権限要求エラー | `.clear-history`, `.resume-swap`, `.terminate` | 15 |
| I1u | model, effort, engine, 実効書込範囲, 過去の観測, network_access, sandbox 変更, network 変更, 承認 変更, 権限要求 | `.clear-history`, `.resume-swap`, `.terminate` | 15 |
| I1g | model, effort, engine, grok policy | `.clear-history`, `.resume-swap`, `.terminate` | 9 |
| I2 | model, effort, switch, cwd, engine, wrapper, resume, 作業意図, fast, IA 配送 | `.session-lifecycle-open`, `.delivery-policy`, `.clear-history`, `.resume-swap`, `.restore`, `.remove` | 18 |
| I3 | model, switch, cwd, engine, wrapper, resume, 作業意図, fast, IA 配送 | `.session-lifecycle-open`, `.delivery-policy` | 13 |

Union of row kinds over the inputs: 19 (IA 配送, cwd, effort, engine, fast, grok policy, model, network 変更, network_access, resume, sandbox 変更, switch, wrapper, 作業意図, 実効書込範囲, 承認 変更, 権限要求, 権限要求エラー, 過去の観測).

## Result

| Input | Base | Candidate | Multisets |
|---|---|---|---|
| I0 | 7 | 7 | equal |
| I1c | 17 | 17 | equal |
| I1r | 18 | 18 | equal |
| I1x | 15 | 15 | equal |
| I1u | 15 | 15 | equal |
| I1g | 9 | 9 | equal |
| I2 | 18 | 18 | equal |
| I3 | 13 | 13 | equal |

The comparison was checked once against a negative control: removing the grok
policy row from the candidate's I1g made exactly I1g differ.

## Viewer session

The real App mounted as a viewer (no operator signal, the same mock as
`appPermissionOperatorGate.integration.test.ts`) with a detail open showed the
tab bar (`engine`, `kaoiro`), the engine panel shown and the kaoiro panel
hidden; the operator-only sandbox switch was absent. App passes `connection` to
AgentDetail for every logged-in session, so a viewer gets the tabs too.
