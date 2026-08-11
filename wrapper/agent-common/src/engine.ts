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
  /** Applies a server-pushed display_name sync — `persona_sync` (legacy) or
   *  `display_name_sync` (new), issue #219 D22 dual-emit; both funnel into
   *  this one call (issue #197 段階3, D12/D14, renamed from `renamePersona`
   *  in issue #219 D19/D23 — canonical `persona` data is never mutated by
   *  this call). Renames the live session's display name in place and
   *  re-emits `state_change` immediately. `revision` is a monotonic
   *  per-agent_id counter; a push whose revision is not strictly newer
   *  than the last one applied is a no-op (D15 — guards against an
   *  out-of-order broadcast rolling the name back, and makes applying
   *  BOTH dual-emitted events idempotent). Only `display_name` is
   *  mutable; `persona.id` / `name` / `sprite_set` and the injected
   *  personality prompt stay fixed for the session's lifetime (ADR-0029
   *  F9, ADR-0030 D2 — issue #219 removed the D2 carve-out this call used
   *  to require). */
  renameDisplayName(displayName: string, revision: number): void;
}

/** Merges an incoming display_name sync push into a pre-host-construction
 *  buffer (issue #197 段階3, D15 review follow-up; renamed issue #219
 *  D19/D23). Both `cli.ts` entry points buffer a sync push that arrives
 *  before their `EngineAdapter` is constructed (the after-join sync and a
 *  live `rename_agent` relay can both land in that window, and PubSub
 *  delivery across the two originating server processes has no ordering
 *  guarantee — the same race `EngineAdapter#renameDisplayName` itself
 *  guards against post-construction). A buffer that just OVERWRITES on
 *  every push loses that guarantee: the eventually-applied
 *  `host.renameDisplayName(...)` call runs against a fresh host whose
 *  revision baseline is 0, so whichever push happened to arrive LAST in
 *  the pre-host window always passes that guard, even if an earlier push
 *  in the same window carried a strictly higher revision. This applies
 *  the identical max-revision-wins rule `EngineAdapter#renameDisplayName`
 *  applies, one layer earlier, so the value that survives buffering is
 *  already the newest one seen regardless of arrival order. */
export function mergePendingDisplayNameSync(
  current: { displayName: string; revision: number } | undefined,
  displayName: string,
  revision: number,
): { displayName: string; revision: number } {
  if (current === undefined || revision > current.revision) {
    return { displayName, revision };
  }
  return current;
}
