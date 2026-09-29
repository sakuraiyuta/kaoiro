---
title: Hand-back direction and three-round design review
description: Historical decisions and evidence behind the stage-1 occupancy hotfix and the still-disabled stage-2 admission proposal.
status: reviewed
last_updated: 2026-09-29
---

# Hand-back direction and design-review record

## Status and evidence boundary

On 2026-09-29, the three-round direction review ended with **B: proceed
with stage-1 implementation, subject to three local must conditions**.
The director recorded operator approval to implement the occupancy hotfix
before stage 2. This is a historical design/measurement record for
[issue #426](https://github.com/sakuraiyuta/kaoiro/issues/426), **not evidence
that a fix was implemented, merged or released**.

All three drafts target commit
`1f9ec026f4cc2d94c6424c7afb3247bf44b0b473`, SDK 0.3.284 / CLI 2.1.284.
Kohaku authored the direction drafts, Kogane measured and reviewed, and
Kuroe directed the work and relayed operator decisions. The final
implementation assignment went to Ao, with implementation review by Kogane.
This page records that assignment, not its completion.

The operator selected direction (a): formally admit SDK-started hand-back
turns when their native ownership can be established. The reviews separated
that intended capability from the immediately implementable protection:
**stage 1 tracks occupancy without creating send authority; stage 2 remains
disabled pending a safe native binding and a subsequent design review**.
No ADR text is amended by this publication.

## Evidence that changed the direction

The earlier [CLI-shape report](2026-09-29-cli-2-1-284-shapes.md) did not
observe hand-back in its controlled composition. The
[round-1 measurement](2026-09-29-handback-measurement-r1.md) reproduced it
in auto mode with empty settings. Its bypass-permission control did not
expose the child hand-back tool. Copied user settings/hooks/skills were
therefore not necessary for the observed positive case; no claim covers
all CLI feature gates or production configurations.

Round 1 also reproduced the failure mechanism on the unchanged host:
a native hand-back opens a root turn, the task notification folds under
the same prompt ID, and the terminal retains peer origin. The host had
independently admitted the notification as its owner, so the origin
mismatch closed the SDK and prevented another child from completing.
The root problem was that the host could not represent an SDK root
interval it had not opened itself.

The [round-2 measurement](2026-09-29-handback-measurement-r2.md) added:

- A second child's hand-back can fold under the first root's prompt ID;
  the result still names the opener, including with a notification between
  the reports. Child PreToolUse FIFO is not a reliable root ordering key.
- Same-task SendMessage resume produces new child call IDs with identical
  report text and the same task ID. SDK session resume resets result indices
  under the same persisted session ID; retirement must be run-scoped.
- Replay makes the peer user origin visible before the measured root tool
  hooks, but after the corresponding model request has already begun.
  The echo contains neither the root hook ID nor the child occurrence ID.
- Foreground Agent can also deliver a hand-back. The measured report folds
  into its wrapper-owned turn; this is a scoped positive workaround result,
  not evidence of hand-back absence or universal foreground safety.
- The actual fail-stop path closes input, subsequently refuses the pending
  child's report, and exits the CLI normally after child completion.
  Runner restart and stable manual recovery remain unmeasured.

Those observations support stage 1 and constrain later designs. They do
not establish a complete pre-tool opener/occurrence join. Inconclusive
measurement is **unmeasured**, not proof that every native solution is
unavailable.

## Three review rounds

| Round | Proposed direction | Review outcome and resulting correction |
| --- | --- | --- |
| 1 | Three host states: wrapper, admitted SDK turn, foreign SDK turn. Native task start, child hand-back hook and fresh root hook would admit a turn, with its task identified at the terminal. Immediate mitigation would notice ownerless busy activity. | Request changes: 5 must, 2 should. Pending-task coexistence did not identify the opener before a call; a terminal cannot authorize a call retrospectively. A result naming any folded task was insufficient. Display busy state included child activity and missed the root-hook gap. FIFO/occurrence consumption lacked a proven join. Literal notification-tag prose could poison ordinary wrapper attribution. |
| 2 | Split occupancy from authority. Stage 1 marks ownerless fresh root hooks before return, with root-only frame fallback, conservative drain and wrapper precedence. Stage 2's replay-echo promotion remains disabled. | Request changes: 3 must, 2 should; no structural objection. Reset/session cleanup could silently release a live barrier. Ambiguity did not constrain every owner/terminal case. Wrapper text equality needed to retain simultaneous native-match rejection. Stage-2 first-echo timing was still an unproven join; the measurement allocation needed explicit limits. |
| 3 | Reset and interrupt ACK retain occupancy. Unknown source is separated from ambiguous interval identity. Terminal validation precedes rebind cleanup. Ownerless failure calls the null-capable fail-stop path. Wrapper precedence requires unique recognition; stage 2 is explicitly a join still to prove. | **B: 3 local must, 2 should.** The substantive r2 problems were resolved. Implementation may proceed with the mandatory conditions below. The allocated direction-review cycle ends here; no fourth round was requested. |

The final choice preserved the constraints of
[ADR-0063 D6/D7](../../adr/0063-layered-delivery-authority-and-continuations.md):
immutable call bindings, root/child isolation, opener-owned terminal
identity and request-bound reply basis. It did not infer authority from
a familiar message body or grant authority after the terminal.

## Stage-1 implementation conditions from the final review

These are requirements handed to the implementer, not claims of verified
product behavior.

1. **Complete foreign-state boundaries.** A frame-only occupancy needs the
   same validated drain and queue wakeup as a prompt-identified occupancy.
   A different fresh hook ID remains ambiguous even when it matches a
   pending notification. A first notification hook under a frame-only
   record must not create an independent owner. Distinguish exact retired
   duplicates from conflicting terminal identities and scope retirement
   to the SDK run/generation.
2. **Use one complete unique-wrapper predicate.** Registration and both
   precedence exceptions must consistently require current ownership,
   session, text, source constraints and absence of a simultaneous native
   match. Existing taint/ambiguity remains sticky. A text match must not
   restore a stale or already ambiguous owner.
3. **Make the c2/c3 mutation controls meaningful.** Removing a live-owner
   equality check does not break a valid live-owner duplicate (c2); a stale
   owner negative case must pin that restriction. Skipping a marker only
   when wrapper text matches does not break notification-only c3; c4 pins
   the double-match case. Each claimed guard must be tested by a mutation
   that changes the behavior of its corresponding control.

The rest of the accepted stage-1 scope remained: same-ID notification folds
without an independent turn, conservative input barriers including pushed
receipts, candidate timer pause/rearm, visible ownerless fail-stop, and a
native gate showing preserved second-child work and eventual release.
Foreign occupancy has no admitted-token watchdog and no time-bounded
liveness claim. Its candidate timer must not expire root occupancy into
idle. The existing origin-mismatch `close()` branch is outside this hotfix's
replacement scope.

R02/R04 in round 2 additionally show a wrapper token being allocated before
a different native root hook, while the wrapper input is only consumed
later as a fold. The owned-overlap path matters as well as ownerless
occupancy; receiving an input does not prove it opened the turn.

## Decisions and remaining limits at this boundary

The director recorded operator decisions to proceed with stage 1, approve
the bounded second measurement, retain send-less hand-back turns until
stage 2, and defer replacing `close()` with fail-stop until P10 was assessed.
The final review did not approve that replacement; P10 did not measure the
runner or prove preservation of the child's report.

The operator later authorized this evidence publication. Raw data remains
private and uncommitted. ADR-0063 amendment was explicitly deferred until
the stage-2 design document; the historical freeze wording is not rewritten
here. Implementation, implementation review and rollout remain separate
from this direction-review result.

Stage 2 still needs to distinguish opener from fold and current from old
same-task occurrence before binding a send, with safe outcomes for absent,
delayed or ambiguous evidence. No pre-terminal send-authority test was
performed by the second measurement, and several requested adversarial
native schedules remain unmeasured. The measurements neither remove guards
nor authorize advancing a peer's reply basis.

## Source bindings and publication scope

The drafts and critiques below are retained locally under
`tmp/reviews/issue-426/`. They are provenance pointers, not public download
links. Their complete text is summarized here rather than copied into the
public repository. Each measurement page separately binds its original
report and private raw manifest.

| Source artifact | SHA-256 |
| --- | --- |
| `direction-r1-kohaku.md` | `739f5b401df8c6cd4b3ee250bd8aef9a1194997dfc46839a443e018d9be4f4b0` |
| `direction-r1-review-kogane.md` | `9c2806ab29ea0ff0d045a7eec583e7cd13856b42d7aa19b40605e55545755c46` |
| `direction-r2-kohaku.md` | `db6fa5d59ae2e05347d8530f2996159348a1f0a0757bd750c0646deab09e3cef` |
| `direction-r2-review-kogane.md` | `2968e8a3dd36519ff9738a49fee32d119893613b10dccf721c2e473f57c9e15e` |
| `direction-r3-kohaku.md` | `ec9a833c3c2f732d45723af1cc7b635615048ce6b189c2f9193fb5bfc7b6c73f` |
| `direction-r3-review-kogane.md` | `bdf2ccb07a7c27bf25b35d1d7c0badaa73fa218a8e668ba0bf64b29f71b0891b` |

The public pages retain experiment conditions, outcomes, budgets, failed
controls and uncertainty. They omit private configuration contents,
credentials, raw requests/transcripts and machine-specific absolute paths.
Test-generated task/session identifiers in the measurement pages are
correlation examples, not credentials or production peer identities.
