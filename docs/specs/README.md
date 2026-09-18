# Specs

Feature specifications, organized by topic. Each file has `status` and
`related` frontmatter.

## Files

| Slug | Status | Description |
|------|--------|------|
| [overview](../architecture/overview.md) | accepted | kaoiro's purpose, two goals, and intended users |
| [architecture](../architecture/system-overview.md) | accepted | Three-layer architecture and data flow |
| [plugin-model](plugin-model.md) | accepted | Two adapter/filter extension points and their shared boundary |
| [protocol](protocol.md) | accepted | Common events; envelope, state machine, persona, bidirectionality, and authentication |
| [protocol-inter-agent](protocol-inter-agent.md) | provisional | Inter-agent messaging envelope schema, nine kinds, and hard limits |
| [protocol-external-human](protocol-external-human.md) | provisional | External human messaging (Discord), one-way authority, discord-wrapper, and Tier A/B |
| [agent-sdk-events](../reference/engines/claude-events.md) | accepted | Settled Agent SDK event specification and state derivation (Claude edition) |
| [codex-exec-events](../reference/engines/codex-exec-events.md) | accepted | Exec SDK event contract and state derivation; [dated verification](../evidence/codex/exec-contract.md) |
| [codex-model-catalog](../reference/engines/codex-model-catalog.md) | accepted | Catalog contract; [model-change procedures](../operations/codex-model-settings.md) and [dated plan/auth/doctor evidence](../evidence/codex/model-catalog.md) |
| [antigravity-cli-events](antigravity-cli-events.md) | provisional | Measured Antigravity CLI (agy) headless event specification, hooks-as-permission-gate, and state derivation (third engine, ADR-0057) |
| [subagent-tasks](subagent-tasks.md) | provisional | Detection of subagent/workflow tasks and dedicated envelope notifications |
| [file-upload](file-upload.md) | provisional | Render dashboard attachments (images/text/PDF/Office) to the SDK in the wrapper |
| [design](design.md) | accepted | Visual design specification for the dashboard/UI. Uses the DESIGN.md format (YAML tokens + prose) and recognizes `dashboard/src/` as the canonical source |
| [responsive-layout](responsive-layout.md) | provisional | Responsive rules that treat three sizes equally: breakpoint definitions, area-specific layouts, sheet mechanisms, and safe areas |
| [responsive-reachability](responsive-reachability.md) | provisional | Inventory of reachability paths by size: each element's path, scroll owner, and permanently fixed operations |
| [personas](personas.md) | accepted | Design policy, image specification, and generation workflow for persona standing illustrations |
| [persona-pack-schema](../reference/personas/pack-format.md) | accepted | Internal schema of persona packs (zip) and `manifest.json` field definitions |
| [persona-personality-injection](persona-personality-injection.md) | provisional | Mechanism for injecting personality prompts, such as speech style and first-person pronouns, into the Claude Agent SDK |
| [threat-model](../architecture/security-threat-model.md) | accepted | Threats to bidirectional routing and their mitigations |
| [auth-and-authz](../architecture/security-boundaries.md) | accepted | Current map of authentication and authorization boundaries for each node. Starting point for the pre-OSS-release audit (private Gitea issue 91) |
| [setup-wizards](setup-wizards.md) | accepted | Configuration / env generation wizards (runner config and server .env) |
| [deployment](deployment.md) | accepted | Multi-host deployment guide (nginx, env inventory, DETS paths, and wss constraints) |
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
