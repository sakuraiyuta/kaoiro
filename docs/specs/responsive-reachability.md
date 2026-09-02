---
title: Responsive reachability-path inventory
description: Exhaustive display conditions, size-specific reachability paths, and scroll owners for each UI element, making the equal-three-sizes requirement that all functionality and information be reachable verifiable.
status: provisional
related: [responsive-layout, design]
---

# Responsive reachability-path inventory

## Purpose

[responsive-layout.md](responsive-layout.md) requires all functionality and
information to be reachable from every size, but that principle is not
verifiable on its own. This specification makes it verifiable by enumerating UI
elements and settling their reachability paths per size. The acceptance criteria
of [phase-31](../plans/phase-31-responsive-ui.md) refer to this table.

Terminology:

- **Display condition** — conditions under which the element is in the DOM
  (role / view / state / capability). Its absence when they are not met is
  correct, not a missing element.
- **Always** — visible without an operation while its display condition holds.
- **Reachability path** — user operations required to bring the element into view.

## Definition

### app chrome

| Element | Display condition | desktop / tablet | smartphone |
|---|---|---|---|
| Title (`h1`) | Always (also on the login screen) | Always | Always (may reduce to logo only) |
| Agent-list chips (`nav.agent-strip`) | Authenticated, in detail view, and two or more agents | Always | Always (horizontal scroll) |
| Connection state (`p.conn`) | Authenticated | Always | Always (may reduce to a dot only) |
| Settings (`button.settings-toggle`) | Authenticated | Always | Always |
| Launch (`button.launch`) | Authenticated, operator, and connected | Always | Always |
| Logout (`button.logout`) | Authenticated | Always | May move into SettingsDrawer |
| Spawn notice (`p.spawn-notice`) | Authenticated and a notice exists | Always | Always |
| Login screen | Unauthenticated | Always | Always (one vertical column) |

### lobby

Grid-column control **depends on role and timeline placement**. Columns are
fixed only when the timeline is side by side; otherwise `auto-fill` is correct.

| Grid | Display condition | Columns |
|---|---|---|
| live grid (side-by-side timeline) | operator at desktop / tablet width | three desktop columns / two tablet columns |
| live grid (timeline sheet) | operator at smartphone width | `auto-fill` |
| live grid | viewer | full-width `auto-fill` (no timeline) |
| offline grid (within `details.offline`) | operator and offline agents exist | always `auto-fill` |

| Element | Display condition | desktop / tablet | smartphone |
|---|---|---|---|
| Card → open detail | Not directory-only (directory-only is `disabled`) | Card itself | Same |
| Card state display | Always | Always | Always |
| Card attention display | Depends on state / pending | Always | Always |
| Card stats display | At least one usable `ext` value for stats and `settings.agentCardStatsEnabled` | Always | Always |
| Card stop / restore | Agent state + connection | On card | Same |
| Card interrupt / delete | Agent state + connection | On card | Same |
| Response timeline | Operator | Always (right pane) | handle → sheet |
| Timeline read operation | Operator and a readable entry exists | Always | Within sheet |
| Offline list (`details.offline`) | Operator and offline agents exist | Expand disclosure | Same |
| Bulk restore / bulk delete | Same as above | After expanding offline | Same |

### AgentDetail

| Element | Display condition | desktop | tablet | smartphone |
|---|---|---|---|---|
| Back to grid (`button.back`) | Always | Always | Always | Always |
| Blind-spot indicator (`button.blindspot`) | Another agent needs attention | Always | Always | Always (below) |
| Previous/next agent switch | Two or more agents | Always | Always | Always |
| Status (model / effort / permission mode) | Always | Always (left sidebar) | handle → sheet | handle → sheet |
| Context / rate-limit meter | Capability exists | Always (left sidebar) | Within sheet | Within sheet |
| Resume (session resume) | Connected | Always (left sidebar) | Within sheet | Within sheet |
| Stop / restore | Connected + mutually exclusive by agent state | Always (left sidebar) | Within sheet | Within sheet |
| Clear history | Connected | Always (left sidebar) | Within sheet | Within sheet |
| Resume-session candidates (`ul.resume-menu`) | During resume operation | Within sidebar | Within sheet | Within sheet |
| Conversation log | Always | Always | Always | Always |
| In-log disclosure / load earlier / retry | Relevant entry exists | Within log | Same | Same |
| Interrupt / delete | Connected + mutually exclusive by agent state | Between log and composer | Same | Same |
| Composer | Always | Always (fixed to bottom) | Always | Always |
| Attachment / slash menu | From composer | On composer | Same | Same |
| Permission dock / question dock | Pending | Between log and composer | Same | Same |
| Tasklist float | After [#178](https://github.com/sakuraiyuta/kaoiro/issues/178) is implemented | Upper right of log | Same | Same |

`interrupt` / `delete` and the two docks are **in-flow elements** placed between
the log and composer within `.main`, not floating layers. A sheet is in front of
them, so they are covered while it is open.

Because the Tasklist float remains unimplemented in #178, its row is a
conditional target that applies after that issue is implemented and is not part
of phase-31 acceptance.

### Handling the blind-spot indicator

[ADR-0012](../adr/0012-response-display-and-dashboard-scope.md) F8 settles that
other agents needing attention are **always displayed** and that a **click
returns to the list**. Because an open sheet covers `button.blindspot`, **place
an attention badge on the sheet handle and make the badge itself the “return to
list” operation**. Its displayed count and click destination match
`button.blindspot`.

### Overlay layers

| Element | Display condition | Layer |
|---|---|---|
| LaunchDialog / SettingsDrawer (including backdrop) | When open | In front of sheet |
| Sheet handle | Always at sizes where its region is a sheet (also when closed) | In front of docks |
| Sheet panel / backdrop | Above condition and open | Same layer as handle |
| Attention badge on handle | Sheet open and another agent needs attention | Within handle |
| Pending lamp on handle | Sheet open and the view has a pending permission / question (the relevant agent in detail; any agent in lobby) | Within handle (non-interactive display inside open/close toggle) |
| Slash menu / switch menu (from composer) | When open | Page layer (behind sheet) |
| Resume menu (from status) | When open | Above sheet content |

The handle remains visible while closed because it opens the sheet. Put the
attention badge inside the handle, but **do not make the handle itself a
`button` and nest the badge inside it**: that would nest interactive elements.
Use the handle as a container, with the open/close toggle and badge as sibling
`button`s.

The only global overlays are LaunchDialog and SettingsDrawer; their backdrops
also sit in front of the whole sheet. An anchor-relative menu belongs to the
same layer as the element that opened it.

### Scroll owners

| Screen | desktop | tablet | smartphone |
|---|---|---|---|
| Lobby | Grid and timeline independently | Same | Grid only (timeline is within sheet) |
| AgentDetail | Status and log independently | Log only (status is within sheet) | Same as tablet |
| Sheet open | — | Sheet only (background fixed) | Sheet only (background fixed) |

What is prohibited is **nesting the page's principal vertical scrolling areas**.
Local scrolling with a height limit, such as tool-output `pre`, anchor menus,
and scrolling within `question-dock`, is not covered.

For a sheet itself, only either wrapper or content is the vertical scroll owner.
If both own it, the scroll immediately duplicates.

When `.status` enters a sheet, the adopted form makes **`.status` itself the
owner** and scrolls it together with the identity header (`.head`). Do not carry
the desktop split (pinned `.head` plus `.status-scroll` ownership) into a sheet:
in a shallow landscape panel (for example, a 234px panel at 844x390), the pinned
head consumes the owner's viewport, leaving effective scroll height 0 and making
all status operations unreachable (measured in phase-31 external review).

### Operations fixed at all times

While their display condition holds, these must remain reachable regardless of
scroll position.

- Header connection state / settings / launch.
- AgentDetail back-to-grid / blind-spot indicator (on the handle while the sheet
  is open).
- Composer input and send (including while the software keyboard is visible).
- Paths to respond to pending permissions / questions.

## Constraints

- **MUST**: Every element in this table is reachable from every size when its
  display condition holds.
- **MUST**: Elements marked “Always” are visible with no operation while their
  display conditions hold.
- **MUST NOT**: Nest the page's principal vertical scrolling areas. Local
  height-limited scrolls are excluded.
- **MUST**: A sheet has only either wrapper or content as its vertical scroll
  owner.
- **MUST NOT**: Hide the composer or send operation while the software keyboard
  is visible.
- **MUST**: Add a row to this table whenever adding a new UI element.

## Open Questions

None.

## See Also

- Related specs: [responsive-layout](responsive-layout.md),
  [design](design.md)
- ADRs: [0052-responsive-three-tier-layout](../adr/0052-responsive-three-tier-layout.md),
  [0012-response-display-and-dashboard-scope](../adr/0012-response-display-and-dashboard-scope.md)
- Implementation plan: [phase-31-responsive-ui](../plans/phase-31-responsive-ui.md)
