---
title: Convert the dashboard to an equal three-size responsive layout
status: accepted
date: 2026-08-09
opened: 2026-08-09
supersedes: []
superseded_by: null
related_specs: [design, responsive-layout, responsive-reachability]
related_adrs: [12]
---

# ADR-0052 — Convert the dashboard to an equal three-size responsive layout

## Status

Accepted

## Context

The Responsive section of [design.md](../specs/design.md) stated that “mobile /
narrow widths are not first-class, but must not break.” The implementation followed
this with only two `@media (max-width: 640px)` rules and no systematic breakpoint
design.

**“Must not break” is already untrue.** On 2026-07-24 the wide gate
(`min-width: 1600px`) for the response timeline was removed, so the timeline is
now displayed at full width in operator sessions. The policy at that time was “do
not hide panes at narrow widths; make tiles smaller and accept them,” but measuring
the current CSS in Chromium shows that at a 640px viewport only 136px remains for
the grid, making three-column tiles about 32.5px. This falls far below the 240px
lower bound of `minmax(15rem, 1fr)`, so the layout is not viable.

AgentDetail's narrow-width behavior has also reached its limit. The `.status`
sidebar contains 15 or more `cc-row` elements (model switching / permission mode /
context meter / rate limit / resume) and scrolls internally with `.status-scroll`,
but the current 640px media query only changes `.body` to `column`. This creates
outer and inner scrolling together and prevents reaching the conversation log.

In addition, explicitly defining the dashboard as a PWA
([#196](https://github.com/sakuraiyuta/kaoiro/issues/196)) creates a requirement
that it work as a practical home-screen-launched app at all three sizes. The
premise that “narrow widths are not first-class” must itself be reconsidered.

## Decision

Make the dashboard **equally viable at PC / tablet / smartphone sizes**. This ADR
withdraws design.md's statement that “mobile / narrow widths are not first-class.”
The dimensions and rules are canonical in
[responsive-layout.md](../specs/responsive-layout.md), and the complete reachability
table is in [responsive-reachability.md](../specs/responsive-reachability.md).

- **F1**: At smartphone widths, move the lobby response timeline into a bottom
  sheet in the same screen and make the grid full-width.
- **F2**: At tablet widths and below, move AgentDetail's `.status` into a bottom
  sheet that can be pulled out with a handle.
- **F3**: Open bottom sheets only through explicit user action, and place them in
  front of AgentDetail dock elements (behind global dialogs / drawers). However,
  **even while a sheet is expanded, show indicators that reveal pending
  permission / question items and other agents requiring action, and make the
  attention badge on the handle itself the action for “return to the list”; this
  is MUST** — ADR-0012 F8 decided not only that a blind-spot indicator is always
  shown, but also that clicking it returns to the list, so merely making the user
  notice it does not satisfy that decision.
- **F4**: For the time being, keep Tasklist float and question-dock collapse /
  detail behavior the same as desktop (provisional).
- **F5**: Change the response timeline track from `minmax(22rem, 26rem)` to a
  fixed **`22rem`**, and derive breakpoints from kaoiro's implementation dimensions
  rather than framework convention values (desktop lower bound 1199px / tablet
  lower bound 940px / short height 500px).
- **F6**: Center layout switching on CSS media queries and keep the DOM structure
  common to all sizes. Store only sheet open/closed state in Svelte state.
- **F7**: At tablet widths (940–1198px), retain the lobby timeline side by side.
  **Portrait iPad (768px) and landscape smartphone (844px) belong to the
  smartphone band** — at these widths, a side-by-side timeline makes tiles
  122–160px, which cannot even reserve the 128px of a standalone sprite.
- **F8**: Treat `short` at heights of 500px or less as an override orthogonal to
  width tokens, and handle **vertical compression only** (header vertical padding /
  composer initial height / height limits for in-flow docks / dialog and drawer
  `max-block-size`). Do not change horizontal layout (timeline placement, status
  placement, or grid column count) or the sheet's maximum height, which is constant
  regardless of width. **Do not change dock expanded state** — the implementation
  has a contract to clear collapsed state for each new `request_id` (do not hide a
  pending decision behind an old collapsed state), and changing initial state based
  on viewport would violate F6.

“Equal” means **all features and all information are reachable**; it is acceptable
for the route to differ by size. Smartphone must support confirmation, sending an
instruction, and approving permission, including reaching the composer while the
software keyboard is visible.

## Consequences

### Positive

- Agents can actually be operated from a smartphone, aligning the motivation and
  practical benefit of making the dashboard a PWA.
- AgentDetail's double scrolling is removed, making the conversation log primary
  even at narrow widths.
- Breakpoint values have derivations and rationale, making the locations to
  recalculate explicit when tile or timeline widths change.
- Keeping the DOM common to all sizes (F6) preserves in-progress composer text and
  log scroll position during screen rotation.

### Negative

- Fixing the timeline track at `22rem` lowers timeline display density on wide
  screens (352px instead of at most 416px).
- The bottom-sheet mechanism must be newly implemented and becomes a dependency
  for both the lobby and AgentDetail.
- Because portrait iPad belongs to the smartphone band, the name “tablet” and the
  actual device mapping can feel unintuitive.
- The validation targets grow to two real-device families: iOS/iPadOS Safari and
  Android Chrome.

### Neutral

- design.md narrows its responsibility to visual design (colors, typography,
  motion), while responsive-layout.md owns dimensions and layout switching.
- design.md has `format: stitch-design-md` and the character of “ratifying the
  implementation as the canonical source,” but until phase-31 completes its
  description is target state based on this ADR. Resynchronize it with the
  implementation after implementation completes.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Stack the timeline vertically below the grid at narrow widths | It cannot be reached without scrolling and loses the value of continuous observation. With many agents it is effectively unreachable |
| Hide the timeline at narrow widths (restore the wide gate) | Directly contradicts the premise that all features and information must be reachable |
| Switch AgentDetail exclusively between conversation/status tabs | The log and context meter cannot be viewed at the same time |
| Make AgentDetail's vertical stack collapsible | Double scrolling remains when expanded, and collapsing still consumes header height |
| Use framework convention breakpoints (768/1024/1280) | They do not match physical dimensions and break at boundaries. Measurement shows a 768px tile is only 122px |
| Keep the current timeline track and place the boundary at 1263px | Raises the desktop lower bound too far and makes 1200px-class windows fall into tablet |
| Also classify by input method (`pointer: coarse`) in addition to width | Creates two decision axes, allowing two layouts at the same width and doubling validation combinations |
| Branch the DOM by size with `matchMedia` + `{#if}` | Remounting on rotation loses composer input and scroll position |
| Center on container queries | Many elements (header / sheet / safe area) are decided by the viewport as a whole, so the benefit does not apply |
| Split the tablet band at 940px into two and create four tiers | Increases the number of decisions to four and expands implementation/test combinations |
| Fix approval UI in front of the sheet | Since a sheet opens only by explicit action, it overrides the immediately preceding intent. Make the indicator MUST instead |
| Move the lobby timeline to a sheet for `short` | With the width lower bound at 940px, short devices (844×390, etc.) are already in the smartphone band based on width. At desktop/tablet widths, short layouts work side by side, and moving the timeline would instead narrow it to at most 300px (500×60%) |
| Replace the blind-spot indicator with a badge only | ADR-0012 F8 decided the click action that returns to the list too; merely announcing its existence does not satisfy the decision |
