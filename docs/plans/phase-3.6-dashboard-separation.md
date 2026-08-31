---
title: Phase 3.6 — Dashboard Directory Separation + Bundling Cleanup
description: Move the reference dashboard from server/assets to the top-level dashboard/ and organize it to be bundled during release builds. Complete.
status: done
phase: 3.6
depends_on: [phase-3.5-response-display]
last_updated: 2026-07-25
---

# Phase 3.6 — Dashboard Directory Separation + Bundling Cleanup

## Goal

Move the reference implementation dashboard (Svelte 5 + Vite, formerly
`server/assets/`) from under server into an independent directory, and organize the
build so its artifacts are bundled during build/release. Separate its dependencies,
build, and CI from the server itself as groundwork for future external-client
separation ([ADR-0007](../adr/0007-client-separation-reference-dashboard.md))
(tracking issue: #44).

## Acceptance Criteria

- [x] Move the dashboard to an independent directory outside server (top-level `dashboard/`) with a self-contained `package.json`
- [x] Keep server delivery while bundling only build artifacts (`DashboardStatic` /
      `Plug.Static` delivery of `/` and `/assets` is unchanged)
- [x] Establish the release path that runs the bundled build (`server/Dockerfile` node
      stage; intentionally excluded from `mix setup` — see D-2 below)
- [x] CI: decouple dashboard build failures from the server build
- [x] Preserve the behavior of disabling static delivery with `:serve_dashboard`

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| D-1 | Confirm and move the destination directory (`server/assets/` → `dashboard/`) | ✅ | Preserve history with `git mv`. Set `vite.config.ts` `outDir` to `../server/priv/static` |
| D-2 | Review the assets aliases in `mix.exs` | ✅ | `assets.setup` / `assets.build` → `dashboard.setup` / `dashboard.build` (`--cd ../dashboard`). Exclude them from `setup` to remove the server build's Node dependency |
| D-3 | Confirm delivery paths and preserve `DashboardStatic` | ✅ | In the production image, `/assets/*` and `/favicon.ico` = 200, `/` = 302 (existing RootRedirect). `:serve_dashboard` off remains green in `dashboard_toggle_test.exs` |
| D-4 | Separate CI (dashboard build and server build) | ✅ | Change only the `dashboard` job's `working-directory` / cache path (already a separate job). A new `dashboard/pnpm-workspace.yaml` makes standalone install work |
| D-5 | Update documentation (align with [ADR-0007](../adr/0007-client-separation-reference-dashboard.md)) | ✅ | Add the location and bundling method to ADR-0007 Neutral. Update path references in README / server README / docs |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Decisions

- **Destination**: Top-level `dashboard/`. It matches the existing CI job name,
  and a `clients/` hierarchy is not introduced because multiple external clients
  are not expected in the near term (2026-07-25, #44 comment).
- **Bundling method**: Run the build at release time. Keep the multi-stage
  `server/Dockerfile` (build in the node stage → copy to `priv/static`) and do not
  commit prebuilt artifacts (same source).
- **The Docker build context is the repository root**. Since `dashboard/` moved
  outside server/, `docker-compose.yaml` specifies `context: ..` + `dockerfile:
  server/Dockerfile`, and `.dockerignore` moves to the root (whitelist mode includes
  only `server/` and `dashboard/`). Run a plain `docker build` from the root with
  `-f server/Dockerfile .`.
- **Add `dashboard/pnpm-workspace.yaml` (`packages: []`)**. Without it, pnpm walks
  up to the root `pnpm-workspace.yaml` and installs the root workspace instead of
  the non-member dashboard, leaving `dashboard/node_modules` empty (the same trap
  existed before the move, and the CI dashboard job was in the same state).

## Followups (in-phase but unfinished)

- Complete separation into another repository (the final form in [ADR-0007](../adr/0007-client-separation-reference-dashboard.md))
  is out of scope for this phase. This phase only moves it within the same repository.

## See Also

- ADRs: [0007](../adr/0007-client-separation-reference-dashboard.md),
  [0012](../adr/0012-response-display-and-dashboard-scope.md)
- Previous: [phase-3.5-response-display](phase-3.5-response-display.md)
