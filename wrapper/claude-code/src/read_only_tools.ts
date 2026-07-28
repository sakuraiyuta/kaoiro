// The wrapper's auto-allow default: tools the SDK may run without a
// permission_broker round-trip when the config names no explicit
// `allowed_tools`. Membership here is a security decision, not a
// convenience one — a tool NOT listed is what makes it 都度承認
// (ADR-0028 D4, #168 決定 P2).
//
// Split out of cli.ts (which runs main() on import) purely so tests can
// assert the membership directly (phase-28 BR S1).

import { LIST_AGENTS_TOOL_FQN, WHOAMI_TOOL_FQN } from "@kaoiro/agent-common";

export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "NotebookRead",
  // Companion tools for inter-agent messaging (protocol-inter-agent). Both
  // are server-round-trip or local-state read with no side effects, so the
  // operator's permission dialog adds no safety — only friction. Keep them
  // auto-allowed so the model can resolve peer names and self-narrate
  // without a broker round-trip per call. Use the exported FQN constants so
  // a rename in inter_agent.ts cannot silently desync the auto-allow set.
  LIST_AGENTS_TOOL_FQN,
  WHOAMI_TOOL_FQN,
  // NOTE: mcp__kaoiro__request_compact is deliberately absent — its absence
  // is the whole approval gate for phase-28 B2. Do not add it.
]);
