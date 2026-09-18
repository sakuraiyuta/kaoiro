import { isAbsolute } from "node:path";
import { AppServerRpcError, rpcObject, type RpcObject } from "./app_server_rpc.js";

export interface AppServerTurnSettings {
  cwd?: string;
  model?: string;
  effort?: string;
  resetEffort?: boolean;
  permission?: {
    sandbox: "read-only" | "workspace-write" | "danger-full-access";
    networkAccess: boolean;
  };
}

export class AppServerSettingsError extends Error {
  constructor(readonly reason: "invalid_settings" | "default_effort_unavailable") {
    super(`App-server settings rejected: ${reason}`);
    this.name = "AppServerSettingsError";
  }
}

type Request = (method: string, params: RpcObject) => Promise<unknown>;
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
// A changing but non-terminating catalog cursor must not hold turn admission forever.
const MAX_MODEL_PAGES = 100;

async function defaultEffort(request: Request, model: string, cwd?: string): Promise<string> {
  const unavailable = () => new AppServerSettingsError("default_effort_unavailable");
  try {
    const response = await request("config/read", { ...(cwd === undefined ? {} : { cwd }), includeLayers: false });
    if (!rpcObject(response) || !rpcObject(response.config)) throw unavailable();
    const configured = response.config.model_reasoning_effort;
    if (configured !== undefined && configured !== null) {
      if (!nonempty(configured)) throw unavailable();
      return configured;
    }
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const result = await request("model/list", { includeHidden: true, ...(cursor === undefined ? {} : { cursor }) });
      if (!rpcObject(result) || !Array.isArray(result.data)) throw unavailable();
      const match = result.data.find(item => rpcObject(item) && item.model === model);
      if (match !== undefined) {
        if (!rpcObject(match) || !nonempty(match.defaultReasoningEffort)) throw unavailable();
        return match.defaultReasoningEffort;
      }
      if (result.nextCursor === null) break;
      if (!nonempty(result.nextCursor) || seen.has(result.nextCursor)) throw unavailable();
      cursor = result.nextCursor;
      seen.add(cursor);
    }
    throw unavailable();
  } catch (error) {
    if (error instanceof AppServerRpcError) throw unavailable();
    throw error;
  }
}

export async function appServerTurnSettings(settings: AppServerTurnSettings, request: Request): Promise<RpcObject> {
  const { cwd, model, effort, resetEffort, permission } = settings;
  const invalid = () => new AppServerSettingsError("invalid_settings");
  if ((cwd !== undefined && !isAbsolute(cwd)) ||
      (model !== undefined && !nonempty(model)) || (effort !== undefined && !nonempty(effort)) ||
      (resetEffort !== undefined && typeof resetEffort !== "boolean") ||
      (resetEffort && (!nonempty(model) || effort !== undefined))) throw invalid();
  const result: RpcObject = {
    ...(cwd === undefined ? {} : { cwd }), ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
  if (permission !== undefined) {
    if (!rpcObject(permission) || typeof permission.networkAccess !== "boolean") throw invalid();
    switch (permission.sandbox) {
      case "read-only": result.sandboxPolicy = { type: "readOnly", networkAccess: false }; break;
      case "danger-full-access": result.sandboxPolicy = { type: "dangerFullAccess" }; break;
      case "workspace-write": result.sandboxPolicy = {
        type: "workspaceWrite", networkAccess: permission.networkAccess,
        ...(cwd === undefined ? {} : { writableRoots: [cwd] }),
      }; break;
      default: throw invalid();
    }
  }
  // null/omission retain the previous thread effort on the pinned CLI. Resolve
  // the current default explicitly; this samples config before turn submission.
  if (resetEffort) result.effort = await defaultEffort(request, model!, cwd);
  return result;
}

export interface AppServerPreparedSettings { readonly model?: string; readonly effort?: string }
export interface AppServerSettingsSnapshot { model: string; effort: string | null }
export interface AppServerSettingsIntent extends AppServerSettingsSnapshot { effortIntent: "explicit" | "default" }
export interface AppServerPendingSettings { model: string | null; effort: string | null; effortReset: boolean }

export function appServerSettingsForAttempt(
  baseline: AppServerSettingsIntent | null, pending: AppServerPendingSettings, rollback = false,
): AppServerTurnSettings {
  if (!baseline || !nonempty(baseline.model)) throw new AppServerSettingsError("default_effort_unavailable");
  const reset = pending.effort === null && (pending.effortReset ||
    (baseline.effortIntent === "default" && (pending.model !== null || rollback)));
  const explicit = pending.effort ?? (baseline.effortIntent === "explicit" ? baseline.effort : null);
  if (!reset && baseline.effortIntent === "explicit" && !nonempty(explicit)) {
    throw new AppServerSettingsError("default_effort_unavailable");
  }
  return {
    ...((pending.model !== null || rollback || reset) ? { model: pending.model ?? baseline.model } : {}),
    ...(reset ? { resetEffort: true } : explicit === null ? {} : { effort: explicit }),
  };
}

export function appServerSettingsAfterSuccess(
  baseline: AppServerSettingsIntent, pending: AppServerPendingSettings, prepared: AppServerPreparedSettings, rollback = false,
): AppServerSettingsIntent {
  const attempted = appServerSettingsForAttempt(baseline, pending, rollback);
  if (attempted.resetEffort && !nonempty(prepared.effort)) throw new AppServerSettingsError("default_effort_unavailable");
  return {
    model: pending.model ?? baseline.model,
    effort: pending.effort ?? (attempted.resetEffort ? prepared.effort! : baseline.effort),
    effortIntent: pending.effort !== null ? "explicit" : attempted.resetEffort ? "default" : baseline.effortIntent,
  };
}

export function successfulResetEffort(resolved: string | undefined, catalogDefault: string | null): string | null {
  return resolved ?? catalogDefault;
}
