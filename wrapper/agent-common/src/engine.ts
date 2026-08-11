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
  /** Applies a server-pushed `persona_sync` (issue #197 段階3, D12/D14):
   *  renames the live session's display name in place and re-emits
   *  `state_change` immediately. `revision` is a monotonic per-agent_id
   *  counter; a push whose revision is not strictly newer than the last
   *  one applied is a no-op (D15 — guards against an out-of-order
   *  broadcast rolling the name back). Only `persona.name` is mutable;
   *  `persona.id` / `sprite_set` and the injected personality prompt
   *  stay fixed for the session's lifetime. */
  renamePersona(name: string, revision: number): void;
}

/** Merges an incoming `persona_sync` push into a pre-host-construction
 *  buffer (issue #197 段階3, D15 review follow-up). Both `cli.ts` entry
 *  points buffer a `persona_sync` that arrives before their `EngineAdapter`
 *  is constructed (the after-join sync and a live `rename_agent` relay can
 *  both land in that window, and PubSub delivery across the two originating
 *  server processes has no ordering guarantee — the same race
 *  `EngineAdapter#renamePersona` itself guards against post-construction).
 *  A buffer that just OVERWRITES on every push loses that guarantee: the
 *  eventually-applied `host.renamePersona(...)` call runs against a fresh
 *  host whose revision baseline is 0, so whichever push happened to arrive
 *  LAST in the pre-host window always passes that guard, even if an
 *  earlier push in the same window carried a strictly higher revision.
 *  This applies the identical max-revision-wins rule
 *  `EngineAdapter#renamePersona` applies, one layer earlier, so the value
 *  that survives buffering is already the newest one seen regardless of
 *  arrival order. */
export function mergePendingPersonaSync(
  current: { name: string; revision: number } | undefined,
  name: string,
  revision: number,
): { name: string; revision: number } {
  if (current === undefined || revision > current.revision) {
    return { name, revision };
  }
  return current;
}
