// The wrapper's auto-allow default: tools the SDK may run without a
// permission_broker round-trip when the config names no explicit
// `allowed_tools`. Mostly read-only tools, plus the one self-scoped display
// write below (`set_status_line`, issue 482). Membership here is a security decision, not a
// convenience one — a tool NOT listed is what makes it 都度承認
// (ADR-0028 D4, #158 決定 P2).
//
// Split out of cli.ts (which runs main() on import) purely so tests can
// assert the membership directly (phase-28 BR S1).

import {
  LIST_AGENTS_TOOL_FQN,
  READ_STATUS_LINE_TOOL_FQN,
  SET_STATUS_LINE_TOOL_FQN,
  WHOAMI_TOOL_FQN,
} from "@kaoiro/agent-common";

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
  // Status line tools (issue 482). `read_status_line` is a server-round-trip
  // read like list_agents. `set_status_line` is NOT read-only: it writes this
  // agent's own display line, which every peer's list_agents then shows. The
  // operator accepted that unapproved write as a residual risk (issue 482,
  // decision 2026-10-03) — validation and the "never an instruction" marking in
  // list_agents are its mitigations. It is a separate, deliberate entry, not a
  // precedent for other writes. A peer whose config names an explicit
  // allowed_tools list does not get either automatically.
  SET_STATUS_LINE_TOOL_FQN,
  READ_STATUS_LINE_TOOL_FQN,
  // NOTE: mcp__kaoiro__request_compact (phase-28 B2) and
  // mcp__kaoiro__request_session_reset (C2) are deliberately absent — their
  // absence IS the approval gate. Do not add them.
]);
