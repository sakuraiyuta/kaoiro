---
title: Phase 31 — Equal three-tier responsive layout for the dashboard (ADR-0052)
description: Lay the foundation for the timeline-track change and breakpoint / sheet mechanism, and make the lobby / AgentDetail / surrounding UI work at PC / tablet / smartphone sizes.
status: in_progress
phase: 31
depends_on: []
last_updated: 2026-08-09
---

# Phase 31 — Equal three-tier responsive layout for the dashboard (ADR-0052)

## Goal

Implement [ADR-0052](../adr/0052-responsive-three-tier-layout.md): make the
dashboard usable at PC / tablet / smartphone sizes, including confirmation,
instruction sending, and permission approval from a smartphone. The source of
truth for dimensions and rules is [responsive-layout.md](../specs/responsive-layout.md);
display conditions and reachability for each element are in
[responsive-reachability.md](../specs/responsive-reachability.md).

This phase proceeds in 4 stages. The stages live as Stages in this file; do not
split them into files under `plans/`.

## Acceptance Criteria

- [ ] Every element in responsive-reachability.md is reachable from all 3 sizes
      when its display condition holds (Tasklist float rows are excluded until
      the #178 implementation)
- [ ] Elements marked “always” remain in view regardless of scroll position while
      their display condition holds
- [ ] lobby grid columns follow role and timeline placement (`auto-fill` always
      for viewer and offline; fixed columns only for operator when the timeline
      is side-by-side)
- [ ] Confirmation / instruction sending / permission approval work on a
      smartphone
- [ ] The composer input and send operation remain reachable while the software
      keyboard is visible
- [ ] Pending permission / question remains noticeable while a sheet is open,
      and the attention badge on the handle returns to the list (retain ADR-0012
      F8 behavior)
- [ ] The page's main vertical scroll area is not nested. The sheet has exactly
      one vertical-scroll owner, either the wrapper or the content
- [ ] In-progress composer text and log scroll position survive screen rotation
- [ ] When launched as a PWA standalone, header / composer / sheet / handle /
      dialog / drawer do not intrude into the safe area
- [ ] At `short` (height 500px or less), vertical-compression overrides work and
      dialog / drawer / dock do not get clipped even at low height
- [ ] Confirmed on real iOS/iPadOS Safari and Android Chrome (Pixel 6a)
- [ ] No design tokens in `design.md` have changed

## Tasks

### Stage A — foundation + lobby

| # | Task | Owner | Status | Notes |
|---|------|-------|--------|-------|
| 31-1 | Change the timeline track to a fixed `22rem` and define breakpoint tokens | こはく | ✅ | desktop 1199px / tablet 940px / short 500px. The breakdown is the table in responsive-layout.md. Assumes `1rem = 16px`. The token list is in the opening comment of `app.css` |
| 31-2 | Add `viewport-fit=cover` to viewport meta and incorporate the safe area | こはく | ✅ | Applies to header / composer / sheet / handle / fixed dialog / drawer. Treat inset as a floor, not an addition: the floor is each element's existing edge padding (`max(<既存 padding>, env(...))`). For body inline use `max(2rem, env(...))` |
| 31-3 | Make the bottom-sheet mechanism a shared component | こはく | ✅ | The contract (open/close methods, maximum height 60%, single scroll owner, focus, crossing breakpoints, stacking order) is defined by responsive-layout.md. Implementation is `BottomSheet.svelte` (display:contents at non-sheet sizes) |
| 31-4 | Apply all 3 sizes to lobby (AgentGridShell + ResponseTimeline) | こはく | ✅ | On smartphone, move the timeline into a sheet. Fix columns only for operator when the timeline is side-by-side (the smartphone band overrides `.three-cols` to auto-fill) |

**Stage A completion:** lobby works at all 3 sizes and the timeline is reachable /
viewer and offline remain `auto-fill` / viewport meta is reflected and the
standalone view does not intrude into the safe area / the handle appears only at
the sizes where it becomes a sheet.

### Stage B — AgentDetail

| # | Task | Owner | Status | Notes |
|---|------|-------|--------|-------|
| 31-5 | Turn `.status` into a sheet and eliminate double scrolling | こはく | ✅ | Applies at tablet width and below. Inside the sheet, `.status` itself is the single scroll owner and the identity header scrolls with it (splitting into pinned head + `.status-scroll` has effective height 0 in the landscape band — measured in external review). On desktop, `.status-scroll` remains the owner. The sheet panel is an `overflow: hidden` wrapper; cap portrait at 8rem |
| 31-6 | Resolve overlap between the sheet and in-flow docks, and make the attention badge interactive | こはく | ✅ | The badge performs the same “return to list” action as `button.blindspot` (ADR-0052 F3). Make the handle a container and make the open/close toggle and badge sibling `button` elements (avoid nested interactive elements). Also show the current agent's pending lamp on the handle |

**Stage B completion:** all status information and operations are reachable / no
double scrolling / pending remains noticeable while the sheet is open and the
badge returns to the list.

### Stage C — surrounding UI and short

| # | Task | Owner | Status | Notes |
|---|------|-------|--------|-------|
| 31-7 | Support 3 sizes for header / SettingsDrawer / LaunchDialog / offline list | こはく | ✅ | On smartphone, move logout into SettingsDrawer (the drawer row is shown at all sizes; hide the header row with CSS — keep the shared DOM). Share the layer scale as backdrop 40 / panel 41 (`app.css` z-index scale comment) |
| 31-8 | Apply vertical-compression overrides for `short` | こはく | ✅ | Header vertical padding / composer's initial height (1 line, expands on focus) / dock maximum height 45% + internal scroll (permission dock changes to the same shell+scroll structure as question dock) / dialog and drawer `max-block-size` and scroll owner. Do not change horizontal layout, sheet maximum height, or dock expanded state. Collapse `main` block padding to 0.5rem/2.6rem (reserve bottom escape space for the handle) |

**Stage C completion:** header / drawer / dialog / offline behavior matches the
responsive-reachability.md table / dialog, drawer, and dock are not clipped at
low height and scroll internally / at height 390px, an expanded permission dock,
a question dock with many choices, a one-line composer, and the handle coexist,
with nonzero log display height and scrolling / dock minimize and composer send
are not covered by the handle.

### Stage D — verification

| # | Task | Owner | Status | Notes |
|---|------|-------|--------|-------|
| 31-9 | Real-device verification (iOS/iPadOS Safari + Android Chrome) | | ⏳ | Android is Pixel 6a. Be sure to verify composer reachability while the software keyboard is visible. [#198](https://github.com/sakuraiyuta/kaoiro/issues/198) |
| 31-10 | Pin viewport regressions with Playwright | こはく | ✅ | Scenarios below. `dashboard/e2e/` (fixture harness + `pnpm exec playwright test`, no Phoenix required). T1–T10 + landscape reachability regression: 26 tests green |

**Test scenarios** (31-10). List only combinations that work, rather than the
Cartesian product of axes.

| # | Scenario | What is pinned |
|---|---|---|
| T1 | operator / lobby / 939 and 940 | Timeline switches sheet ⇔ side-by-side and grid columns follow |
| T2 | operator / lobby / 1198 and 1199 | 2 columns ⇔ 3 columns switch and tiles do not fall below 240px |
| T3 | viewer / lobby / all bands | Always `auto-fill`; neither timeline nor handle appears |
| T4 | operator / detail / 1198 and 1199 | Status switches sheet ⇔ sidebar (always sheet at tablet and below) |
| T5 | operator / detail / sheet open | Background does not scroll and there is 1 scroll owner |
| T6 | operator / detail / permission arrives (sheet open / closed) | Response path is reachable |
| T7 | operator / detail / question arrives (sheet open / closed) | Same as above |
| T8 | operator / detail / another agent needs action + sheet open | Return to the list from the handle badge |
| T9 | heights 500 and 501 | Header vertical padding / composer initial height / dock maximum height / dialog and drawer `max-block-size` switch (sheet maximum height and horizontal layout stay unchanged) |
| T10 | low height + dialog / drawer open | No clipping; scroll internally |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

- Keep Tasklist float behavior at narrow widths the same as desktop for now
  (ADR-0052 F4 provisional decision). Since [#178](https://github.com/sakuraiyuta/kaoiro/issues/178)
  is not implemented, it is outside this phase's acceptance scope. Reconsider it
  after implementation based on actual behavior
- Fixing the timeline track at `22rem` reduces display density on wide screens.
  If real use reveals a shortfall, consider restoring the upper limit only at the
  top of the desktop band
- Because breakpoints are held in px, they do not follow a browser's default font
  size change. If a break occurs, move them to rem notation

## Open Questions Blocking This Phase

None.

## See Also

- Specs covered: [responsive-layout](../specs/responsive-layout.md),
  [responsive-reachability](../specs/responsive-reachability.md),
  [design](../specs/design.md)
- ADR: [0052-responsive-three-tier-layout](../adr/0052-responsive-three-tier-layout.md)
- Implementation issue: [#197](https://github.com/sakuraiyuta/kaoiro/issues/197)
  (Stage A–C + 31-10 Playwright)
- Real-device verification issue: [#198](https://github.com/sakuraiyuta/kaoiro/issues/198)
  (Stage D 31-9, operator task)
- Previous phase: [phase-30-history-restart-resilience](phase-30-history-restart-resilience.md)
