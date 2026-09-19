# Specs

The pre-taxonomy specification folder. [ADR-0060](../adr/0060-documentation-taxonomy-and-migration.md)
dissolved it into `architecture/` (how it is built and why), `reference/`
(exact contracts), `operations/` (runbooks), `evidence/` (dated measurements)
and `contributing/`; the role-based entry is [docs/README.md](../README.md).
Every other file here is a stub that keeps its original headings so old
`#fragment` links resolve and points at each new location. Do not edit a stub;
edit the page it points at.

## Pages that stay here

| Slug | Status | Why it stays |
|------|--------|------|
| [personas](personas.md) | accepted | Japanese-language design policy for persona illustrations; the Japanese text is the specification |
| [agent-operations](agent-operations.md) | accepted | Working rules for agents sharing one work tree; the entry named by [AGENTS.md](../../AGENTS.md) and [CLAUDE.md](../../CLAUDE.md) |
| [protocol-external-human](protocol-external-human.md) | provisional | Unimplemented Discord design; moves once accepted (marker at the top of the page) |

## Where each former spec lives now

| Slug | Status | Description |
|------|--------|------|
| [overview](../architecture/overview.md) | accepted | kaoiro's purpose, two goals, and intended users |
| [architecture](../architecture/system-overview.md) | accepted | Three-layer architecture and data flow |
| [plugin-model](../architecture/extensions.md) | accepted | Two adapter/filter extension points and their shared boundary |
| [protocol](../architecture/message-topology.md) | accepted | Why the common envelope has the shape it does, and the design intent behind its outer/payload split |
| [protocol-inter-agent](../architecture/inter-agent-messaging.md) | provisional | Inter-agent messaging and its boundaries |
| [protocol-external-human](protocol-external-human.md) | provisional | External human messaging (Discord), one-way authority, discord-wrapper, and Tier A/B |
| [agent-sdk-events](../reference/engines/claude-events.md) | accepted | Settled Agent SDK event specification and state derivation (Claude edition) |
| [codex-exec-events](../reference/engines/codex-exec-events.md) | accepted | Exec SDK event contract and state derivation; [dated verification](../evidence/codex/exec-contract.md) |
| [codex-model-catalog](../reference/engines/codex-model-catalog.md) | accepted | Catalog contract; [model-change procedures](../operations/codex-model-settings.md) and [dated plan/auth/doctor evidence](../evidence/codex/model-catalog.md) |
| [antigravity-cli-events](../architecture/antigravity-adapter.md) | provisional | Measured Antigravity CLI (agy) headless event specification, hooks-as-permission-gate, and state derivation (third engine, ADR-0057) |
| [subagent-tasks](../architecture/subagent-visibility.md) | provisional | Detection of subagent/workflow tasks and dedicated envelope notifications |
| [file-upload](../architecture/attachments.md) | accepted | Render dashboard attachments (images/text/PDF/Office) to the SDK in the wrapper |
| [design](../reference/ui/design.md) | accepted | Visual design specification for the dashboard/UI. Written in DESIGN.md format (YAML tokens + prose), affirming the existing implementation (dashboard/src/) as the canonical source |
| [responsive-layout](../reference/ui/responsive-layout.md) | provisional | Breakpoint definitions, area-specific layout rules, sheet mechanism, and safe-area handling that make the dashboard equally viable at PC, tablet, and smartphone sizes |
| [responsive-reachability](../reference/ui/responsive-reachability.md) | provisional | Inventory of reachability paths by size: each element's path, scroll owner, and permanently fixed operations |
| [personas](personas.md) | accepted | Design policy, image specification, and generation workflow for persona standing illustrations |
| [persona-pack-schema](../reference/personas/pack-format.md) | accepted | Internal schema of persona packs (zip) and `manifest.json` field definitions |
| [persona-personality-injection](../architecture/personality-injection.md) | provisional | Mechanism for injecting personality prompts, such as speech style and first-person pronouns, into the Claude Agent SDK |
| [threat-model](../architecture/security-threat-model.md) | accepted | Threats to bidirectional routing and their mitigations |
| [auth-and-authz](../architecture/security-boundaries.md) | accepted | Current map of authentication and authorization boundaries for each node. Starting point for the pre-OSS-release audit (private Gitea issue 91) |
| [setup-wizards](../reference/configuration/setup-wizards.md) | accepted | Exact contract for the interactive wizards that generate the server .env and runner configuration (runner.config.json / runner.env); design intent in [architecture/deployment.md](../architecture/deployment.md#setup-wizards) |
| [deployment](../architecture/deployment.md) | accepted | Why deployment is shaped as one server plus any number of runner hosts behind nginx, and the stop-boundary constraint an in-place build imposes on checkout-direct hosts |
| [agent-operations](agent-operations.md) | accepted | Operating rules for multiple agents working concurrently in the same work tree (implementation and director sides). Engine-independent and referenced by both CLAUDE.md and AGENTS.md |
| [non-goals](../architecture/scope.md) | accepted | Out of scope |
| [glossary](../reference/glossary.md) | accepted | Glossary |

## Status legend

- **accepted** — settled; implementations follow it
- **provisional** — temporary; unresolved questions remain in `../open-questions/`
- **deferred** — deferred to a later phase

## Conventions

- Slugs use lowercase hyphenation; one topic per file; ≤200 lines.
- Diagrams use Mermaid (no ASCII art); cross-references use relative paths.
