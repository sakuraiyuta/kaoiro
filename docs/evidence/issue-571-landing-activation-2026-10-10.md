---
title: Landing-tag activation measurement and real-repository rule
status: recorded
last_updated: 2026-10-10
---

# Issue 571 landing activation

Staged activation follows
[build-identity-and-release-tags.md](../operations/build-identity-and-release-tags.md)
§Automation activation and trust. Control and gates SHA:
`bfc321820dc5ffb5fee5305edcb182b8c251036a`.

## Owned fixture measurement

Repository `sakuraiyuta/kaoiro-fuji571-repair-r3-20261010`. Its control is
byte-identical to the control SHA above for 78 files: both release workflows
and their code and dependencies.

- Ruleset installed with the operator card's exact body: id 24831078. Its
  read-back matched. Update and delete were each refused in all four
  namespaces (8 attempts).
- Push run 38028858027 with landing automation disabled:
  - attempt 1: `original-event` succeeded and `publish` was skipped;
  - attempt 2, after the variables were set, `KAOIRO_LANDING_FIRST_RUN_ID`
    pointed at this run, and `KAOIRO_LANDING_ENABLED=true`: `publish`
    succeeded and created exactly one pair, `v2026.10.10.1` and its claim,
    at the original push time `2026-10-10T05:50:16Z`;
  - attempt 3: `publish` succeeded and the pair was unchanged.
- Fallback: a separate disabled push followed by dispatch run 38029023260
  allocated `v2026.10.10.2`, stamped with the original push time
  `2026-10-10T05:52:48Z`.

Records, kept in the director's review store and not in this repository:

- `activation-fixture-probe-fuji.json`: SHA-256
  `291504ebb7c14f9804dce384953a027f4df02f0028cc6bec9ebd44f2bef2aeed`
- `activation-fixture-probe-fuji.log`: SHA-256
  `35177c0bbb6d6a822e7e3d68f082873b274a19a7940dfc40975a7dd20c5a2961`

## Real repository

The operator installed ruleset 24831689 on `sakuraiyuta/kaoiro`. Read-back:

- `target=tag`, `enforcement=active`;
- the four selectors, with no exclusions;
- `update` and `deletion` rules;
- no bypass actors.

Before installation the repository had no tags. The only existing ruleset
was the branch rule `protect-develop-main`.

The push of this document is the declared activation boundary. Its
develop-landing push run becomes `KAOIRO_LANDING_FIRST_RUN_ID`, and earlier
pushes are never tagged. `KAOIRO_RELEASE_ENABLED` stays false until
production enrollment.
