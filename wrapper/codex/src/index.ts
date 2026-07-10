// @kaoiro/codex — Codex CLI engine adapter scaffold (ADR-0032 F1 / F10).
// Phase-13 ships only this unimplemented stub so the package boundary and
// the EngineAdapter conformance exist; the real @openai/codex-sdk wiring
// lands in phase-14 (docs/plans/phase-14-codex-adapter.md,
// docs/specs/codex-sdk-events.md).

import type {
  EngineAdapter,
  KaoiroState,
  PendingPermissionExt,
  PendingQuestionExt,
  PermissionMode,
} from "@kaoiro/agent-common";

const NOT_IMPLEMENTED = "@kaoiro/codex: not implemented until phase-14";

export class CodexHost implements EngineAdapter {
  get state(): KaoiroState {
    throw new Error(NOT_IMPLEMENTED);
  }
  run(_prompt?: string): Promise<void> {
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }
  send(_text: string, _attachmentIds?: string[]): Promise<void> {
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }
  interrupt(): Promise<void> {
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }
  close(): void {
    throw new Error(NOT_IMPLEMENTED);
  }
  setModel(_value: string): Promise<void> {
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }
  setEffort(_level: string): Promise<void> {
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }
  setPermissionMode(_mode: PermissionMode): Promise<void> {
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }
  setPendingPermission(_pending: PendingPermissionExt | null): void {
    throw new Error(NOT_IMPLEMENTED);
  }
  setPendingQuestion(_pending: PendingQuestionExt | null): void {
    throw new Error(NOT_IMPLEMENTED);
  }
}
