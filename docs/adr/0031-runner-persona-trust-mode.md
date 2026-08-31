---
title: persona accepts two modes of allowlist/blacklist
status: accepted
date: 2026-07-07
opened: 2026-07-07
supersedes: []
superseded_by: null
related_specs: [personas, persona-pack-schema, protocol]
related_adrs: [23, 29]
---

# ADR-0031 —  ’s persona accepts two modes of allowlist/blacklist

## Status

Accepted (completed 2026) — — [phase-12] (../plans/phase-12-phase-persona-trust-mode.md),
`/my-code-review-cycle` 1 round clean convergence, 2 in dev dogfooding
Jason encode / setPermissionMode race

## Context

[ADR-0029] (0029-persona- -sot-and-pack- bution.md)
server SoT + zip pack is integrated to distribute, but can be launched with the host
`personas[]`
(。list) left the structure. This produces two types of friction:

1. **allowlist**: Even if the new pack is placed on the server, the host
If `runner.config.json` is not added by hand, it will not appear in dashboard "+ Start".
fuji addedpack(2026 -05)Although pack is ingested,  
recursive papercuts in the same form that fuji cannot be started because the allowlist is used.
`scripts/dev.sh` gitignored
`git pull`
2. **Fixed mode**: Only allowlist can be selected, so that you can use it as a laboratory.
Redundant double-management in the use of "All basics left in  "
On the other hand, "This pack on a specific host" is distributed and shared server outside the laboratory.
opt-out, such as "not used, can be expressed in the first place (pack only removed)


"How far does Apache believe in the server's persona catalog?"
The reason is that the trust policy can only be expressed in a single value. **config the trust axis
If you select the option explicitly, you can solve the friction of small scale operation and make large scale operation.
You can get the base of expressive power at the same time.

**Trust axis scope**: This ADR treats**→ server direction trust**
Only one axis (where  server accepts the server's persona group).
reverse direction (how far   returns, spawn on per-token)
WS authentication/cwd  serverlist
ADR is not scoped.
Handles as a separate ADR (see Non-Goals) when the expression is required in real operation.

## Decision

### F1: Select from two modes, both modes mutual ex 

`runner/runner.config.json`
`blocked_personas` config
rejected by fail-loud at startup.

- **`allowed_personas: string[]`**— allowlist mode. enumerated id
spawn only (currently `personas[]` equivalent).
- **`blocked_personas: string[]`**— blacklist. server
persona group (`PersonaAssets` ingested + reservation `default`)
spawn is possible to remove the enumerated id.
- **Both fields omitted**— accept-all (same as blacklist). Small
As the default of operation, the new host is the persona declaration zero, and the whole persona is
Accept

id is perfect with persona pack `manifest.json` id. Version
(e.g. `fuji@1.0.0`), wildcards, namespaces are not supported
(Extension at the time required in the future).

### F2: `default`Does not treat persona

Reservation persona id `default`(ADR-0029, #35, HostRegistry.inject default/1)
`allowed_personas` / `blocked_personas`
`HostRegistry.inject_default/1`'s "injection" logic is removed,
"The declaration set contains default (blacklist) / not included (blacklist)
Change to "injection only if".

If `default` is blocked and other pack is not enumerated/uningested,
spawnable sets may be empty, but canary/preparation
assumes a legal state as host. dashboard is explicitly UX with empty picker
display (not handling exceptions).

This adoptJapanese term**id space consistency**`inject_default/1`
HostRegistry simplification** by removal of the program. The default is unique in the future
"default-specific injects when shake in the direction with personality pack
Functions as a base of tion counter s (but the current default is common)
footer only does not have personality, so footer-derived inject
For mitigation to the tion — common to all persona. footer side
ifrequired is required).

### F3: Completed on the server side

`blocked_personas` when blacklist mode
`PersonaAssets`
Determines the set except blocked from the set (+ default reservation). For this design
re-registration even if new pack is ingested on the running server
ADR-0029


allowlist mode continues with `HostRegistry`'s personas reference.
`AgentsChannel.resolve_persona/2`
`attrs`

### F4: Existing`personas[]`Field backward compatibility

`runner.config.json`
If you have a format, the following one release cycle is as the ** list mode:
passive** and depre  warning to stderr. name /
sprite set prioritizes the server-side manifest (host local display name)
Overwrite is removed and matched with the SoT policy of ADR-0029).

The `personas` field is removed at the time of transition completion (the next major),
`allowed_personas: string[]`

### F5: Removal of fetch and cli pro sions at startup

current `scheduleAllowlistCheck` (cli/src/cli.ts, after startup 3s
`/api/personas` and warn the difference between config)
depre 
Removing with this ADR to duplicate warnings.

## Consequences

### Home

- When adding new pack, blacklist mode host does not need to change config automatically
reflected (papercut when fuji is added is structurally disappeared)
- The mana declaration is omitted from the initial setup of  .
Lower initial setup costs
`runner.config.json`
sprite set) disappears and SoT is fully aggregated to manifest.json

### Negative Return/Tradeoff

- **Reliability Transfer**: blacklist mode ingested
pack = execution system prompt on host. Single operator =
server admin does not degrade, but multiple operators/shares
In the case of server, the operator will run the persona prompt
lose an explicit way to review (pack ishanChannel
push to wrapper as persona prompt and prompt from personality.md
injection risk may be pronounced within the allowed tools range). Japanese term
You can choose the mode in config (your policy) to the operator
Home
- Allowlist / blacklist 2 mode
HostRegistry
attrs format, dashboard empty picker UX)
- Allows spawnable zero state in host blocked `default`
dashboard is required to display empty picker as intended empty state
(not an error)

### Change Influence Area

- `runner/src/cli.ts` — add mode to config parse,
`scheduleAllowlistCheck` removal, blacklist mode
Include `blocked_personas` in register payload
- `server/lib/kaoiro_server/host_registry.ex` — mode and
blocked/COed `inject_default/1`
- `server/lib/kaoiro_server_web/channels/runner_channel.ex` —
`parse_register/1` is extended to new fields and `personas`
depre  warning
- `server/lib/kaoiro_server_web/channels/agents_channel.ex` —
`resolve_persona/2`
- `scripts/dev.sh` — new schema (mode omitted)
Accept-all
- `docs/specs/personas.md` —   side persona
2 Rewrite mode
- `wrapper/kaoiro.config.{claude-code,codex}.example.json` — no impact
ADR-0029 F3 filename is phase-15
15-17)

## Non-Goals

The following is not scope of this ADR, and when the required property is displayed in actual operation
Handles as another ADR:

1. **per-token persona  **server
This is a mechanism that has a limitation that only this persona can be launched in this .
This ADR is   → server direction
Handling only trust.
2. **id versioning / wildcard / namespace**— `fuji@1.0.0` Unit
allowance, limiting author units like `sakurai/*`, etc. id Full matching
Start with minimalist semantics.
3. **common footer**— footer-derived prompt injection
mitigation (e.g., footer disable option). Book ADR
`default` does not solve this problem.
4. **Dynamic mode switch**— switch allowlist ↔ blacklist while operating
like UX / API. config Edit +   Not applicable to reboot.
5. **explicit alert for spawnable zero host**— canary
Do not warning to be handled as a legal state (if you like it, issue)


## Migration

1. **`runner.config.json`**(with <CODE1):
Up to the next release, depre  warnings are used as allowlist mode
Contact Us lab admin
- blacklist To be oriented → remove `personas` and start or
`blocked_personas: []`
- `personas: [...]`
`allowed_personas: ["<id>", ...]`(id only string array)
rewrite (name/sprite set is delegated to server-side SoT)
2. **`scripts/dev.sh`**: Accept-all
`blocked_personas: []`
Example) Existing lab generated config does not overwrite the current behavior
Maintenance.
3. **Next major**: Remove the `personas` field and depre  warning.
`HostRegistry` attrs format is also unified as 2 modes.

## Unconfirmed / Reference

- Select by footer version / Not considered disabled. Footer
Handles as a separate ADR when the risk is present.
- The signature validation of pack manifest on the server side (who made pack)
ADR is an independent issue. Ingest Check at the time
ADR-0029
Installed. current extraction cache is out of persona dir by ADR-0046
Relocation
