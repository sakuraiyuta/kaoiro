---
title: Choose between two runner persona acceptance modes: allowlist or blacklist
status: accepted
date: 2026-07-07
opened: 2026-07-07
supersedes: []
superseded_by: null
related_specs: [personas, persona-pack-schema, protocol]
related_adrs: [23, 29]
---

# ADR-0031 — Choose between two runner persona acceptance modes: allowlist or blacklist

## Status

Accepted (implementation complete 2026-07-07 — [phase-12](../plans/phase-12-runner-persona-trust-mode.md),
one clean round of `/my-code-review-cycle`, and two secondary bugs (Jason encode /
setPermissionMode race) detected and fixed through dev dogfooding).

## Context

[ADR-0029](0029-persona-server-sot-and-pack-distribution.md) integrated personas
with server SoT + zip-pack distribution, but the final decision about which
“personas can be launched on this host” remained with `personas[]` (allowlist) in
`runner/runner.config.json`. In operation, this creates two kinds of friction:

1. **Allowlist synchronization omissions**: even after placing a new pack on the
   server, it does not appear in the dashboard “+ Launch” until it is manually
   added to the active host’s `runner.config.json`. Immediately after fuji was
   added (2026-07-05), the same papercut recurred: the pack had been ingested,
   but it could not launch because fuji was absent from the runner allowlist.
   `scripts/dev.sh` generates the gitignored file “only on first use” and does
   not overwrite it thereafter, so `git pull` does not resolve this either.
2. **The mode is fixed**: because only an allowlist can be selected, it creates
   redundant double management for lab-scale use cases where “everything placed
   on the server is basically allowed”. Conversely, distribution outside the
   lab or a shared server has no way to express an opt-out such as “do not allow
   this pack on a particular host” (other than deleting the pack).

These issues result from being able to express the trust policy “how far the
runner trusts the server’s persona catalog” only as one value. Making the trust
axis explicitly selectable in config addresses small-scale operational friction
and lays the foundation for the expressiveness needed at larger scale.

**Scope of the trust axis**: This ADR covers only **trust from runner → server**
(how much of the server’s persona set the runner accepts). The reverse direction
(how much the server trusts the runner’s declaration, such as restricting
spawnable personas per token) belongs to other layers such as WS authentication,
server-side cwd_allowlist validation, and per-token persona ACLs, and is outside
this ADR’s scope. Treat it as a separate ADR when operational use requires that
expressiveness (see Non-Goals).

## Decision

### F1: Choose one of two mutually exclusive modes

`runner/runner.config.json` may contain **either `allowed_personas` or
`blocked_personas`**. A config containing both is rejected fail-loud at startup
(do not leave the semantics ambiguous).

- **`allowed_personas: string[]`** — allowlist mode. Only the listed ids may be
  spawned (equivalent to the current `personas[]`).
- **`blocked_personas: string[]`** — blacklist mode. The spawnable set is the
  server’s persona set (ingested into `PersonaAssets` + the reserved `default`)
  with the listed ids removed.
- **Both fields omitted** — accept-all (equivalent to an empty blacklist).
  **The default for small-scale operation** is that a new host accepts every
  persona without declaring any personas.

Ids must exactly match the ids in a persona pack’s `manifest.json`. Versioning
(`fuji@1.0.0`, etc.), wildcards, and namespaces are not supported (extend this
when they become necessary in the future).

### F2: Do not treat the `default` persona specially

The reserved persona id `default` (ADR-0029, #35, HostRegistry.inject_default/1)
can be listed in `allowed_personas` / `blocked_personas` like any other id. Remove
the “always inject” logic from `HostRegistry.inject_default/1` and change it to
inject default only when default is included in the declared set (allowlist)
or not included (blacklist).

As a result, a host that blocks `default` while other packs are either not listed
or not ingested can have an empty spawnable set. Treat this as a legal canary /
preparation state rather than an error. The dashboard explicitly displays an
empty picker as UX (do not handle it as an exception).

The main reasons for this decision are **consistency of the id space** and
**simplification of HostRegistry by removing the `inject_default/1` branch**.
Secondarily, it provides groundwork for handling “default-specific injection” if
default later moves toward having its own personality pack (though current
default has only the common footer and no personality, so this does not mitigate
footer-derived injection — it applies to all personas in common. Handle any need
for a footer-side lever in a separate ADR).

### F3: Complete the decision on the server side

In blacklist mode, the runner declares `blocked_personas` during register → the
server’s `AgentsChannel.resolve_persona/2` determines the set by removing blocked
ids from the `PersonaAssets` set (+ the reserved default). This means that when
a new pack is ingested into a running server, the runner does not need to register
again; live propagation by the ADR-0029 watcher naturally reaches the host as well.

Allowlist mode continues to use the `HostRegistry` persona reference as before.
The branch affects only the decision source in `AgentsChannel.resolve_persona/2`
and the form in which `HostRegistry` retains `attrs`.

### F4: Backward compatibility for the existing `personas[]` field

When an existing `runner.config.json` has the form
`personas: [{id, name, sprite_set}, ...]`, accept it as **allowlist mode for the
next one-release cycle** and emit a deprecation warning to stderr. Use only the
ids; prefer the server-side manifest for name / sprite_set (remove host-local
display-name overrides, consistent with ADR-0029’s SoT policy).

At migration completion (the next major), remove the `personas` field and replace
it completely with `allowed_personas: string[]`.

### F5: Remove startup fetch and CLI comparison

The current `scheduleAllowlistCheck` (runner/src/cli.ts, which calls
`/api/personas` three seconds after startup and warns about differences from the
config) is unnecessary in blacklist mode because the decision is completed on
the server, and duplicates the deprecation warning in allowlist mode. Remove it
under this ADR.

## Consequences

### Positive consequences

- When a new pack is added, a blacklist-mode host reflects it automatically with
  no config change (the papercut from adding fuji disappears structurally).
- Persona declarations can be omitted from runner initial setup, reducing the
  initial setup cost for lab-scale deployments.
- Persona display metadata (name / sprite_set) disappears from the
  `runner.config.json` schema, and the manifest becomes the complete SoT.

### Negative consequences / trade-offs

- **A change in the direction of delegated trust**: in blacklist mode, “a pack
  ingested into the server = a system prompt executed on the host”. For a
  single-operator = server-admin lab this is effectively no degradation, but in
  a multi-operator / shared-server setup the operator loses an explicit way to
  review the persona prompt that will run on their machine beforehand (the pack
  is pushed to the wrapper as persona_prompt by WrapperChannel, and
  personality.md-derived prompt injection risks can surface within the scope of
  allowed_tools). Delegate this trade-off to the operator by making the mode
  selectable in config (the second policy).
- The test surface grows for the allowlist / blacklist branches
  (`AgentsChannel.resolve_persona/2` decision branches, HostRegistry attrs form,
  and dashboard empty-picker UX).
- A host that blocks `default` may have zero spawnable personas; the dashboard
  must display this as an intentional empty state, not an error.

### Areas affected

- `runner/src/cli.ts` — add mode selection to config parsing, remove
  `scheduleAllowlistCheck`, and include `blocked_personas` in the register
  payload in blacklist mode
- `server/lib/kaoiro_server/host_registry.ex` — retain mode and blocked/allowed
  sets in attrs, remove `inject_default/1`
- `server/lib/kaoiro_server_web/channels/runner_channel.ex` — extend
  `parse_register/1` for the new fields and warn about legacy `personas`
- `server/lib/kaoiro_server_web/channels/agents_channel.ex` — branch
  `resolve_persona/2` by mode
- `scripts/dev.sh` — update the generated template to the new schema (mode
  omitted means accept-all)
- `docs/specs/personas.md` — rewrite runner-side persona acceptance for the two
  modes
- `wrapper/kaoiro.config.{claude-code,codex}.example.json` — no impact (personas
  come from the server, ADR-0029 F3; filenames are split by engine in phase-15
  15-17)

## Non-Goals

The following are outside this ADR’s scope and should be handled as separate ADRs
when their need becomes apparent in operation:

1. **Per-token persona ACL (trust from server → runner)** — a mechanism for the
   server to restrict a token so that it can launch only specific personas. This
   is needed for organization / shared-server operation, but this ADR covers only
   trust from runner → server.
2. **Id versioning / wildcards / namespaces** — allowing `fuji@1.0.0` units,
   author-based restrictions such as `sakurai/*`, and similar features. Start
   with the minimal semantics of exact id matching.
3. **A lever on the common footer** — mitigation for footer-derived prompt
   injection (selecting footer versions, disabling the footer, etc.). The
   treatment of `default` in this ADR does not solve this problem.
4. **Dynamic mode switching** — UX / API for switching allowlist ↔ blacklist while
   in operation. Config editing + runner restart is sufficient, so it is out of
   scope.
5. **Explicit alerts for hosts with zero spawnable personas** — treat this as a
   legal canary / preparation state, so do not warn (file a separate issue if it
   becomes a concern).

## Migration

1. **Existing lab `runner.config.json`** (with `personas: [...]`): operate in
   allowlist mode with a deprecation warning until the next release. At a
   convenient time, the lab admin can:
   - To adopt blacklist behavior → delete `personas` and start, or explicitly
     set `blocked_personas: []`
   - To retain allowlist behavior → rewrite `personas: [...]` as
     `allowed_personas: ["<id>", ...]` (an id-only string array; delegate
     name/sprite_set to the server-side SoT)
2. **Generated template in `scripts/dev.sh`**: update new generation to
   accept-all (omit both fields; show `blocked_personas: []` as a commented hint).
   Preserve the current behavior of not overwriting config already generated for
   an existing lab.
3. **Next major**: remove the `personas` field and deprecation warning. Unify
  the `HostRegistry` attrs form around the two-mode model.

## Unverified / reference

- Footer version selection / disable levers have not been considered. Handle
  footer-derived injection risk in a separate ADR if it becomes apparent.
- Server-side signature verification for pack manifests (who created a pack) is
  an independent concern. Hash checking at ingest time
  (`server/priv/persona-packs/.cache/`, its location at the time) was already
  introduced by ADR-0029. The current extraction cache has been moved outside
  the persona directory by ADR-0046.
