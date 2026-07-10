// EngineAdapter — the engine-agnostic operational surface every concrete
// engine host implements (ADR-0017 / ADR-0032 F1). Promoted in phase-13 from
// the de-facto shape of the Claude AgentHost (@kaoiro/claude-code); the codex
// adapter (@kaoiro/codex) implements the same surface in phase-14. The
// wrapper composition (cli.ts) drives an engine through this interface plus
// the brokers in this package.

import type {
  KaoiroState,
  PendingPermissionExt,
  PendingQuestionExt,
  PermissionMode,
} from "./types.js";

export interface EngineAdapter {
  /** Current coarse kaoiro state (protocol.md state set). */
  readonly state: KaoiroState;
  /** Opens the engine session and resolves when the wrapper shuts down.
   *  `prompt`, when given, is the first turn (one-off dogfooding). */
  run(prompt?: string): Promise<void>;
  /** Queues one operator instruction (optionally with uploaded
   *  attachments, file-upload spec / ADR-0025). */
  send(text: string, attachmentIds?: string[]): Promise<void>;
  /** Gracefully stops the current turn (protocol.md #51). */
  interrupt(): Promise<void>;
  /** Releases the engine session; run() resolves afterwards. */
  close(): void;
  /** Applies an operator model switch for subsequent turns (#54).
   *  Engines without runtime model switching may reject. */
  setModel(value: string): Promise<void>;
  /** Applies an operator effort switch for subsequent turns (#54). */
  setEffort(level: string): Promise<void>;
  /** Applies an operator permission change (#58). Engines with launch-fixed
   *  permissions (codex, ADR-0033 F3) may reject mid-session changes. */
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /** Stamps the authoritative pending-permission record onto the next
   *  state_change's ext (ADR-0022); null clears it. */
  setPendingPermission(pending: PendingPermissionExt | null): void;
  /** Question-side twin of setPendingPermission (ADR-0027). */
  setPendingQuestion(pending: PendingQuestionExt | null): void;
}
