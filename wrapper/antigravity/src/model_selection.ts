import { RequestError, type SessionConfigOption } from "@agentclientprotocol/sdk";

/** The two `agy` session options a kaoiro model slug maps onto. */
export const MODEL_OPTION = "model";
export const LEVEL_OPTION = "thought_level";

/** The part of an attached ACP session the switch needs. */
export interface ModelSession {
  readonly configOptions: SessionConfigOption[] | undefined;
  setConfigOption(configId: string, value: string): Promise<unknown>;
}

export interface ModelPair {
  model: string;
  level?: string;
}

/** `cause` is the error that ended the switch; `restoreCause` is the
 *  restore's own error, when the restore threw. */
export type ModelSwitchResult =
  | { kind: "applied" }
  /** `agy` refused the first step; nothing was applied. */
  | { kind: "rejected"; reason: "control_rejected"; cause: unknown }
  /** A later step failed; the previous pair was restored and verified. */
  | { kind: "rolled_back"; reason: string; cause: unknown }
  /** The previous pair could not be restored or verified. */
  | { kind: "failed"; detail: string; cause: unknown; restoreCause?: unknown };

function option(session: ModelSession, id: string): SessionConfigOption | undefined {
  return session.configOptions?.find((candidate) => candidate.id === id);
}

function values(entry: SessionConfigOption | undefined): string[] {
  if (entry === undefined || entry.type !== "select") return [];
  const out: string[] = [];
  for (const item of entry.options as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const value = (item as { value?: unknown }).value;
    if (typeof value === "string") out.push(value);
    const nested = (item as { options?: unknown }).options;
    if (Array.isArray(nested)) {
      for (const child of nested) {
        const childValue = (child as { value?: unknown } | null)?.value;
        if (typeof childValue === "string") out.push(childValue);
      }
    }
  }
  return out;
}

function current(session: ModelSession, id: string): string | undefined {
  const entry = option(session, id);
  return entry?.type === "select" && typeof entry.currentValue === "string" ? entry.currentValue : undefined;
}

/** The pair `agy` reports right now. */
export function reportedPair(session: ModelSession): ModelPair {
  const model = current(session, MODEL_OPTION) ?? "";
  const level = current(session, LEVEL_OPTION);
  return level === undefined ? { model } : { model, level };
}

/** Splits a kaoiro slug: the whole slug when it is a `model` value; else
 *  `<base>-<level>` with `<base>` a `model` value; else the whole slug, for
 *  `agy` to judge. */
export function splitSlug(slug: string, session: ModelSession): ModelPair {
  const models = values(option(session, MODEL_OPTION));
  if (models.includes(slug)) return { model: slug };
  const base = models
    .filter((candidate) => slug.startsWith(`${candidate}-`) && slug.length > candidate.length + 1)
    .sort((a, b) => b.length - a.length)[0];
  return base === undefined ? { model: slug } : { model: base, level: slug.slice(base.length + 1) };
}

async function send(session: ModelSession, id: string, value: string): Promise<boolean> {
  await session.setConfigOption(id, value);
  return current(session, id) === value;
}

async function apply(session: ModelSession, pair: ModelPair): Promise<boolean> {
  if (!(await send(session, MODEL_OPTION, pair.model))) return false;
  if (pair.level === undefined) return true;
  if (!values(option(session, LEVEL_OPTION)).includes(pair.level)) return false;
  return send(session, LEVEL_OPTION, pair.level);
}

/** Applies `target` as one switch. On a failure after the first step the
 *  previous pair is restored and verified. */
export async function switchModel(
  session: ModelSession,
  target: ModelPair,
  previous: ModelPair,
): Promise<ModelSwitchResult> {
  try {
    if (!(await send(session, MODEL_OPTION, target.model))) throw new Error("model not verified");
    if (target.level !== undefined) {
      if (!values(option(session, LEVEL_OPTION)).includes(target.level)) throw new Error("level not offered");
      if (!(await send(session, LEVEL_OPTION, target.level))) throw new Error("level not verified");
    }
    return { kind: "applied" };
  } catch (error) {
    // Refused before the model changed: nothing was applied.
    if (current(session, MODEL_OPTION) !== target.model && error instanceof RequestError && error.code === -32602) {
      return { kind: "rejected", reason: "control_rejected", cause: error };
    }
    const reason = error instanceof Error ? error.message : "switch failed";
    let restoreCause: unknown;
    try {
      if (await apply(session, previous)) return { kind: "rolled_back", reason, cause: error };
    } catch (caught) {
      restoreCause = caught;
    }
    return {
      kind: "failed",
      detail: `antigravity_model_restore_failed: ${reason}`,
      cause: error,
      ...(restoreCause === undefined ? {} : { restoreCause }),
    };
  }
}
