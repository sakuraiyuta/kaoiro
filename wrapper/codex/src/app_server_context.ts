import type { DirectoryContext } from "@kaoiro/protocol";
import { appServerUsage } from "./app_server_telemetry.js";

type Owned = { threadId: string; turnId: string; hostTurnToken: string };
export type AppServerContextEvent =
  | { kind: "bound"; threadId: string }
  | { kind: "compaction"; threadId: string; turnId: string; itemId: string; phase: "started" | "completed"; sequence: number }
  | (Owned & { kind: "response"; sequence: number })
  | (Owned & { kind: "usage"; value: unknown; sequence: number });

type Dispatch = {
  token: string; model: string | null; generation: number; turnId?: string;
  response?: number; candidate?: DirectoryContext;
};

/** Publication belongs to the host, after its settings commit (ADR-0040). */
export class AppServerContextMeter {
  #threadId: string | undefined;
  #generation = 0;
  #dispatch: Dispatch | undefined;
  #snapshot: DirectoryContext | undefined;
  #open = new Set<string>();
  #completed = new Set<string>();
  #closed = false;
  #boundarySequence = 0;

  get snapshot(): DirectoryContext | undefined { return this.#snapshot && { ...this.#snapshot }; }

  reset(): void {
    this.#generation++;this.#threadId = undefined;this.#dispatch = undefined;
    this.#snapshot = undefined;this.#open.clear();this.#completed.clear();this.#boundarySequence = 0;
  }

  close(): void { this.reset();this.#closed = true; }

  modelChanged(): void {
    this.#generation++;this.#dispatch = undefined;this.#snapshot = undefined;
  }

  begin(threadId: string, token: string, model: string | null): void {
    if (this.#closed) return;
    if (threadId !== this.#threadId) {
      this.reset();this.#threadId = threadId;
    }
    this.#dispatch = { token, model, generation: this.#generation };
  }

  handoff(identity: Owned): void { this.#owner(identity); }

  /** True only when the outward reading changed, including withdrawal. */
  observe(event: AppServerContextEvent): boolean {
    if (this.#closed) return false;
    if (event.kind === "bound") {
      const changed = this.#snapshot !== undefined;
      this.reset();this.#threadId = event.threadId;return changed;
    }
    if (event.threadId !== this.#threadId) return false;
    if (event.kind === "compaction") {
      const key = JSON.stringify([event.turnId, event.itemId]);
      if (event.phase === "completed") {
        if (!this.#open.delete(key)) return false;
        this.#completed.add(key);
        if (this.#completed.size > 256) this.#completed.delete(this.#completed.values().next().value!);
        this.#boundarySequence = Math.max(this.#boundarySequence, event.sequence);
        if (this.#dispatch) delete this.#dispatch.response;
        return false;
      }
      if (this.#open.has(key) || this.#completed.has(key)) return false;
      this.#open.add(key);
      this.#boundarySequence = Math.max(this.#boundarySequence, event.sequence);
      if (this.#dispatch) { delete this.#dispatch.response;delete this.#dispatch.candidate; }
      return this.#withdraw();
    }
    const owner = this.#owner(event);
    if (!owner) return false;
    if (event.kind === "response") {
      if (this.#open.size === 0 && event.sequence > this.#boundarySequence) owner.response = event.sequence;
      return false;
    }
    if (event.sequence <= this.#boundarySequence) return false;
    delete owner.candidate;
    const usage = appServerUsage(event.value);
    if (usage === null || usage.modelContextWindow === null) return this.#withdraw();
    if (usage.last.inputTokens === 0 || owner.response === undefined || event.sequence <= owner.response || this.#open.size > 0) return false;
    const used_percentage = 100 * (usage.last.totalTokens / usage.modelContextWindow);
    if (!Number.isFinite(used_percentage)) return this.#withdraw();
    owner.candidate = { used_tokens: usage.last.totalTokens, max_tokens: usage.modelContextWindow, used_percentage };
    return false;
  }

  finish(identity: Owned, settingsCommitted: boolean, model: string | null): void {
    const owner = this.#owner(identity);
    // A superseded turn cannot withdraw a newer model's reading either.
    if (!owner) return;
    this.#snapshot = settingsCommitted && owner.model !== null && owner.model === model &&
      owner.generation === this.#generation && this.#open.size === 0 ? owner.candidate : undefined;
    this.#dispatch = undefined;
  }

  fail(token: string): void {
    if (this.#dispatch?.token !== token) return;
    this.#dispatch = undefined;this.#snapshot = undefined;
  }

  #owner(identity: Owned): Dispatch | undefined {
    const owner = this.#dispatch;
    if (this.#closed || identity.threadId !== this.#threadId || !owner ||
      owner.token !== identity.hostTurnToken || owner.generation !== this.#generation ||
      (owner.turnId !== undefined && owner.turnId !== identity.turnId)) return undefined;
    // Transport facts are emitted only after the validated start response;
    // its bounded buffer can flush before runtime.onHandoff is invoked.
    owner.turnId = identity.turnId;
    return owner;
  }

  #withdraw(): boolean {
    const changed = this.#snapshot !== undefined;this.#snapshot = undefined;return changed;
  }
}
