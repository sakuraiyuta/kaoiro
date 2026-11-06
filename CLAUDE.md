# CLAUDE.md

## Project

kaoiro — a system that visualizes the state of multiple CLI AI agents as characters.

## Stack

- Wrapper: TypeScript packages per engine. Claude Code uses the Claude Agent
  SDK, Codex uses app-server JSON-RPC, Antigravity hosts its CLI, and Grok Build
  hosts resident ACP. The six packages are `core`, `agent-common`,
  `claude-code`, `codex`, `antigravity` and `grok` (ADR-0017/0032/0057).
- Server: Elixir / OTP + Phoenix.
- Client: Web (TypeScript). The bundled dashboard uses Svelte 5 + Vite
  (`dashboard/`, a separate root with its own lockfile, outside the pnpm workspace).
- Runner: TypeScript / Node (`@kaoiro/runner`, the host-resident supervision
  layer — ADR-0023). The TS side uses a pnpm workspace (shared types in
  `@kaoiro/protocol`).

## Documentation

- Entry points: [docs/README.md](docs/README.md) (navigation by role) and
  [docs/architecture/overview.md](docs/architecture/overview.md).
- [docs/architecture/](docs/architecture/) — current structure and rationale, by topic.
- [docs/reference/](docs/reference/) — the source of truth for current contracts
  (protocol / configuration / engines / inter-agent / security / ui / storage / deployment).
- [docs/operations/](docs/operations/) — operator runbooks. Before changing
  the runner startup path or the wrapper turn lifecycle, check
  [high-risk-change-release.md](docs/operations/high-risk-change-release.md)
  to determine whether the change is high risk.
- [docs/release/](docs/release/README.md) — one note per production release;
  whoever prepares a production release writes it.
- [docs/evidence/](docs/evidence/) — dated measurement records.
- [docs/contributing/](docs/contributing/) — change procedures. For document
  placement, see [documentation.md](docs/contributing/documentation.md).
  For the rule requiring issue numbers in documents to link to their GitHub
  issues, follow [Documentation writing rules](docs/contributing/documentation.md#writing-rules).
- [docs/specs/](docs/specs/) — old specs. The retained pages are personas /
  agent-operations / protocol-external-human (provisional); the others are
  stubs pointing to their new locations
  ([ADR-0060](docs/adr/0060-documentation-taxonomy-and-migration.md)).
- [docs/plans/](docs/plans/) — implementation plans by phase.
- [docs/open-questions/](docs/open-questions/) — unresolved questions.
- [docs/adr/](docs/adr/) — architecture decision records.
- [docs/reference/engines/claude-events.md](docs/reference/engines/claude-events.md#commands-for-manual-verification-canusetool-firing-boundary)
  — the boundary of the commands usable for manual verification of the broker path.

## Commands

- wrapper (TypeScript): `cd wrapper && pnpm test` / `pnpm typecheck` /
  `pnpm build` (fan-out shim for six packages).
- runner (TypeScript): `cd runner && pnpm test` / `pnpm typecheck` /
  `pnpm build`.
- dashboard (Svelte): `cd dashboard && pnpm test` / `pnpm check` /
  `pnpm build` (run `pnpm install` separately because it is outside the workspace).
- server (Elixir/Phoenix): `cd server && mix test` / `mix format` /
  `mix phx.server`.
- Start all layers for development: `./scripts/dev.sh`.

## Branch strategy

Introduced in [issue #213](https://github.com/sakuraiyuta/kaoiro/issues/213).
Use the integration branch `develop` because agents' permission gates
block Git operations targeting `main`.

| Branch | Role | Who may update it |
|---|---|---|
| `main` | Release / stable branch; default branch | **Operator only** |
| `develop` | Integration branch; CI runs here too | Agents allowed |
| `issue-NNN-*` | feature branch | Agents allowed |

- Create feature branches from `develop` and merge them back into `develop`
  with a **fast-forward merge**. Agents may automate these steps.
- The **operator manually** merges `develop` → `main` at each milestone.
- Use `develop` as the worktree base.

### Remotes

GitHub (`origin`) is the source of truth. Preserve the pre-publication
self-hosted Gitea repository as a read-only archive, unchanged (operator
decision, 2026-09-01). If a clone still has a `gitea` remote, do not remove
it or push to it. Branches from the old lineage are incompatible with the
current history; do not mix fetch sources.

## Language

As a rule, write artifacts that remain in this repository in **English**
(because it is read in English as OSS): commit messages (subject:
`type(scope): summary`, body also in English), issue / PR titles, bodies,
and comments, specs / plans / ADRs under `docs/`, code comments, test names,
and log messages. When editing an existing Japanese document, you may
translate the sections you change into English; a full rewrite is not
required. Exceptions are places where Japanese itself is the specification,
such as `docs/specs/personas.md`. Conversations with the operator and
inter-agent messages follow the session's language setting (do not switch
these to English).

## Workflow rules

- Perform Git operations with user approval (operations on `develop` and
  its feature branches may be automated within the Branch strategy above).
- When updating task tables or progress in docs/plans/, also update
  `status` / `last_updated` in the frontmatter at the same time (to prevent
  status drift and recurrence of the three inconsistencies found on 2026-07-03).

## Multi-agent workflow

[docs/specs/agent-operations.md](docs/specs/agent-operations.md) is the source
of truth for operating rules when multiple agents work concurrently in the
same work tree (both implementers and dispatchers), regardless of engine.
The entry point for Codex agents is [AGENTS.md](AGENTS.md).
