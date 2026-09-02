---
title: Adopt one lockstep CalVer project version and explicit build channels
status: accepted
date: 2026-09-01
opened: 2026-09-01
supersedes: []
superseded_by: null
related_specs: [deployment, protocol]
related_adrs: [53]
---

# ADR-0056 — Adopt one lockstep CalVer project version and explicit build channels

## Status

Accepted (2026-09-01, operator decision for issue #288).

## Context

The existing build identity records a git revision and dirty state, but it
does not give an operator a stable project version or distinguish a tagged
release from a development artifact. That makes it difficult to tell whether
the server, dashboard, runner, or wrapper on screen is the intended build.

The monorepo is deployed as one lockstep project: the components advance from
the same source revision and do not have independent compatibility promises.
The existing `protocol_version` remains the wire-shape compatibility stamp;
it is not an application version.

## Decision

Use one root `VERSION` file as the project version source of truth. Its value
is `YYYY.M.PATCH` without a leading `v`; the initial value is `2026.9.0`.
Display formatting adds the leading `v`, for example `v2026.9.0`.

Extend the build identity computation in
[`scripts/build-identity.mjs`](../../scripts/build-identity.mjs) to read that
version and derive a channel. The channel is `release` only for a clean,
non-shallow checkout with an attached local `main` branch and the exact
matching `v<VERSION>` tag. Every other artifact, including `develop`, dirty,
detached, shallow, and unknown builds, is unconditionally `dev`. Component
build paths consume this single computation or its build-time outputs; they do
not reimplement the version or channel rules.

Expose the version and channel next to the existing revision and dirty fields
in the server health response. Bake the same values into the dashboard at
Vite build time. Human-facing labels use:

`kaoiro {channel} {component} vYYYY.M.PATCH / <short-hash>`

The server and client labels are shown below the dashboard title. Runner and
wrapper labels are separate follow-up stages because the runner host payload
and wrapper connection protocol have distinct ownership and compatibility
work.

## Consequences

- Operators can distinguish release and development artifacts and compare all
  components against one project version.
- A clean main commit without its matching tag remains visibly `dev`; a tag
  cannot accidentally turn a dirty checkout into a release.
- The server and dashboard need the build identity values at image/build time;
  missing values degrade to `unknown` / `dev` rather than claiming a release.
- Runner display is added in Stage 2 and wrapper reporting in Stage 3 of issue
  #288. The wrapper change requires a separate wire-schema decision.

## Related decisions

This extends the revision/dirty identity established by
[ADR-0053](0053-build-identity.md) without changing the wire protocol version
or its compatibility semantics.
