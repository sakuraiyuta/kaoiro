---
title: Turn dashboard into three-size responsive layouts
status: accepted
date: 2026-08-09
opened: 2026-08-09
supersedes: []
superseded_by: null
related_specs: [design, responsive-layout, responsive-reachability]
related_adrs: [12]
---

# ADR 2 — switch dashboard to responsive layout for three sizes

## Status

Accepted

## Context

[design.md](../specs/design.md)
It was not first-class, but it was not broken.、
The systematic breakpoint design is just two `@media (max-width: 640px)`
Not existed.

**This "not broken" is already true.**2026 response-24
The wide gate (`min-width: 1600px`) is removed and the operator session is fully
timeline is now displayed. The policy at that time is "not to hide pine in narrow width,
"I want to accept tiles with small size, but if I measure the currentTiles withiumium,
In viewport 640px, the grid remains only 136px, and the three-row tile is 32.5px.
`minmax(15rem, 1fr)` The lower limit is 240px.
Not established.

AgentDetail has reached its limit. `.status` Sidebar
15 or more `cc-row` (model switch permission / mode / context meter /
rate limit / resume) scroll in with `.status-scroll`, but current
640px media query only makes `.body` `column`, so scroll outside and
I can't reach the conversation log.

Work to define dashboard as explicit PWA
(https://github.com/sakuraiyuta/kaoiro/issues/196))
Requests to be established in 3 sizes as a practical application launched from the home screen
"Narrow width is not first-class" is the premise itself.

## Decision

Dashboard**PC / tablet / smartphone**。
design.md's "mobile/narrow is not first-class" with this ADR
Details of dimensions and rules
[responsive-layout.md](../specs/responsive-layout.md)
[responsive-reachability.md](../specs/responsive-reachability.md) is canonical.

- **F1**: In the smartphone width, the lobby response timeline is the same screen bottom
Remove the sheet and complete the grid
- **F2**: The `.status` of the AgentDetail is removed from the bottom sheet.
Pull out with handle
- **F3**: The bottom sheet only opens with the user's explicit operation, and the AgentDetail docks
global on the front (back from global dialog / drawer). However, the sheet is expanded
pending / question and other agents
Put the indicator and handle on the attention badge itself "Revert to the list"
ADR-0012 F8 is always display of the blind spot indicator
It is not only decided to return to the list by click, but it is only possible to realize
to not meet that decision
- **F4**: Tasklist float and question-dock
same behavior as desktop (tentative)
- **F5**: response timeline track from `minmax(22rem, 26rem)`
  **`22rem` Fixed**breakpoint is not a framework
kaoiro using the reversed value from the mounting dimension (desktop lower limit 1199px / tablet lower limit)
px / low back 500px)
- **F6**: The layout switch is centered on media media query, and theOM structure is all sizes
Keep common. Svelte only opens and closes the sheet
- **F7**: tablet width (11〜1198px) leaves the timeline of the lobby side by side.
  **iPhone 844px** —
When the timeline is lying in this width, the tile is 122 to 160px, and the sprite alone is
128px
- **F8**:CO 500px `short` is an override that is incompatible with a width .
  **Vertical compression only**handle (header vertical padding / composer initial height /
in-flow dock `max-block-size`). 
layout (place timeline, place status, number of columns in grid) and width
The maximum sheet height is not changed. dock**No expansion state**— implementation
A contract to unfold for each new `request_id` (pending judgment old
If you have aview state) and change the initial state by viewport dependency
To counter F6

What is "interest"?**All features and information available**refers to the size of the route
tolerances that are different for each. smartphone on smartphone / Send instruction / permission
composerments to apply until approve, and to composer even during software keyboard display
including what can be reached.

## Consequences

### Positive

- You can turn the agent from your smartphone, and theHome and profit of PWA
Close
- AgentDetail eliminates double scrolling, and the conversation log becomes the main feature even narrower
- breakpointtile with break and base, when changing the tile width and timeline width
where to be recal d
- composer is determined to keep all sizes in common (F6).
The scroll position of text andJapanese term is preserved

### Negative

- The timeline display density on a wide screen is fixed to `22rem`.
(up to 416px → 352px)
- Both lobby and AgentDetail are required as a new implementation
This depends
- "tablet" and "tablet" are called as the actual device because the iPad vertical enters the smartphone band
Intuition and food
- Validated iOS/iPadOS Safari and Android Chrome

### Neutral

- design.md is responsible for visual design (color,Homeography, motion),
Dimensions and layoutJapanese term are divided into shapes responsive-layout.md has
- design.md canonical source
In the target description based on this ADR until the phase-31 is completed
hronize with implementation after implementation completion

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|vertically stacking timeline under grid with narrow width|The value of "always observation" is lost without scrolling. Virtually unreachable if the number of agents is large|
|Leave timeline with narrow width (wide gate revival)|Contrary from the front to the premise that "All functions and information can be reached"|
|Agent AgentDetail with conversation/status tab|Cannot see log and context meter simultaneously|
|Folding AgentDetail vertical loading|Double scrolling remains at the time of deployment, consuming the height of the header even if it is folded|
|adopt framework conventional (768/1024/1280) to breakpoint|Break in the boundary without matching the actual size. 768px tile is only added to 122px|
|Keep timeline track current and return the boundary to 1263px|desktop too low, 1200px class window drops to tablet|
|In addition to width`pointer: coarse`) Also used for judgment|Doubles the test axis and doubles the validation cost because there are two layouts in the same width.|
| `matchMedia` + `{#if}`return  by size|Re-mount when the screen rotates to lose composer input and scroll position|
|container query center|The whole viewport element (header / sheet / safe area) has many advantages|
|Split the tablet band in pxpx and set to 4|The combination of implementation and testing is swelling when the judgment is not 4|
|Fix the approval UI on the front of the sheet|Cover the previous operation intentions, more than the sheet is opened by explicit operation. Alternate with the MUSTization of the indicator|
| `short`Leave the lobby timeline to the sheet|By making the lower limit of the width to 390px, the lower terminal (844×390, etc.) is already in the smartphone belt only with width. desktop / tablet The width of the lower back has a horizontal line, and the reverse is narrowed up to 300px (500×60%)|
|Alternate blind spot indicator with badge display only|ADR-0012 F8 decides to return to the list by click, and the decision is not met just by notifying the existence|
