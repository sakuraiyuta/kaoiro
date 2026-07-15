// Orchestrator for the `refresh_engine_catalog` request (Option E,
// ADR-0039). Validates the incoming payload, coalesces onto the runner's
// per-engine memory cache + dedup mutex, and — on a successful probe —
// re-registers the host so LaunchDialog picks up the fresh catalog via the
// ordinary `hosts` broadcast. Emits a paired EngineCatalogResult in every
// case so the client's toast + dedup can settle by request_id.

import type {
  CodexAuthMode,
} from "./codex-auth.js";
import type {
  EngineCatalogFailReason,
  EngineCatalogResult,
  EngineKind,
  RunnerRegister,
} from "@kaoiro/protocol";
import { buildRegister, type RunnerConfig } from "./config.js";
import { ClaudeCatalogCache } from "./claude_catalog_cache.js";
import { runClaudeProbe } from "@kaoiro/claude-code/probe-client";
import type { ProbeOutcome } from "@kaoiro/claude-code/probe-client";

/** Engines whose launch catalog can be freshened via a live probe. Codex
 *  is static-catalog by ADR-0035 F1, so refresh requests targeting it are
 *  rejected as unsupported_engine (fail-loud rather than silent no-op). */
const LIVE_PROBE_ENGINES: readonly EngineKind[] = ["claude-code"];

export interface RefreshEngineCatalogDeps {
  /** Live getter so a config hot-reload that changes host_id is reflected
   *  in the next catalog_result reply (藤 must-fix 2). A fixed string
   *  captured at handler construction would stamp the OLD host_id after
   *  reconnect. */
  getHostId: () => string;
  cache: ClaudeCatalogCache;
  getCurrentConfig: () => RunnerConfig;
  getCodexAuthMode: () => CodexAuthMode;
  updateRegister: (register: RunnerRegister) => void;
  sendCatalogResult: (result: EngineCatalogResult) => void;
  /** Injectable for tests; defaults to the real probe. */
  probe?: () => Promise<ProbeOutcome>;
}

interface ParsedRefreshRequest {
  engine: EngineKind;
  request_id: string;
  force: boolean;
}

/** Best-effort structural parse — anything malformed is dropped silently:
 *  the client can retry, and there is nothing to reply to without a valid
 *  request_id. Only `engine` + `request_id` are strictly required. */
function parsePayload(payload: unknown): ParsedRefreshRequest | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const engine = p.engine;
  const request_id = p.request_id;
  if (typeof engine !== "string" || engine === "") return null;
  if (typeof request_id !== "string" || request_id === "") return null;
  return {
    engine: engine as EngineKind,
    request_id,
    force: p.force === true,
  };
}

/** Build a refresh_engine_catalog handler bound to the runner's live cache,
 *  register push, and result sink. Returns a function suitable for
 *  `RunnerLink.onRefreshEngineCatalog`. */
export function makeRefreshEngineCatalogHandler(
  deps: RefreshEngineCatalogDeps,
): (payload: unknown) => void {
  return (payload: unknown) => {
    const req = parsePayload(payload);
    if (req === null) return;

    if (!LIVE_PROBE_ENGINES.includes(req.engine)) {
      emitFailure(deps, req, "unsupported_engine");
      return;
    }

    // Fire-and-forget: RunnerLink's channel.on callback is sync-void, but
    // the probe is async. Errors inside are caught locally so a bug here
    // cannot crash the runner.
    void handle(deps, req).catch((err) => {
      process.stderr.write(
        `runner: refresh_engine_catalog handler crashed: ${String(err)}\n`,
      );
      emitFailure(deps, req, "cli_error", err);
    });
  };
}

async function handle(
  deps: RefreshEngineCatalogDeps,
  req: ParsedRefreshRequest,
): Promise<void> {
  const probeFn = deps.probe ?? runClaudeProbe;
  const outcome = await deps.cache.refresh(probeFn, req.force);

  if (outcome.ok && outcome.models !== undefined) {
    // Only push a new register when the cache actually just changed —
    // a cache-hit reply (`source: "cache"`) means the register already
    // carries these models, and the dedup fan-out is also tagged "cache"
    // so exactly ONE updateRegister happens per real probe (藤 review medium
    // item + concurrent-dedup 抑制).
    if (outcome.source !== ClaudeCatalogCache.CACHE_HIT) {
      const config = deps.getCurrentConfig();
      const nextRegister = buildRegister(
        config,
        deps.getCodexAuthMode(),
        outcome.models,
      );
      deps.updateRegister(nextRegister);
    }

    deps.sendCatalogResult({
      version: "0",
      host_id: deps.getHostId(),
      engine: req.engine,
      request_id: req.request_id,
      ok: true,
      models_count: outcome.models.length,
    });
    return;
  }

  const reason: EngineCatalogFailReason = outcome.reason ?? "cli_error";
  emitFailure(deps, req, reason);
}

function emitFailure(
  deps: RefreshEngineCatalogDeps,
  req: ParsedRefreshRequest,
  reason: EngineCatalogFailReason,
  cause?: unknown,
): void {
  if (cause !== undefined) {
    process.stderr.write(
      `runner: engine catalog probe failed (${req.engine}, ${reason}): ${String(cause)}\n`,
    );
  }
  deps.sendCatalogResult({
    version: "0",
    host_id: deps.getHostId(),
    engine: req.engine,
    request_id: req.request_id,
    ok: false,
    reason,
  });
}
