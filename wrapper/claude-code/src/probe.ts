#!/usr/bin/env node
// Short-lived Claude Agent SDK catalog probe (Option E, ADR-0039). Spawned
// by the runner as a child process (never in-process) so the runner package
// keeps zero direct dependency on @anthropic-ai/claude-agent-sdk. Reads no
// arguments from stdin; on success emits one JSON object on stdout and exits
// 0. On failure emits `{ ok: false, reason }` and exits 1.
//
// Wire (stdout, one line, JSON):
//   { "ok": true, "models": ModelInfo[], "elapsed_ms": number,
//     "source": "init" | "supported_models" }
//   { "ok": false, "reason": EngineCatalogFailReason,
//     "detail"?: string, "elapsed_ms": number }
//
// Side-effect posture (verified by phase-20 spike):
// - cwd is a freshly-created isolated tmpdir under os.tmpdir(). Deleted after
//   the probe, whether success or failure, so any accidental session/state
//   write leaves no artefact behind.
// - OAuth / keychain / ANTHROPIC_API_KEY paths are preserved: `env` is not
//   passed (SDK inherits process.env). `--bare` is NOT used because it
//   disables keychain reads (OAuth-only deployments would auth-fail).
// - No MCP servers, no built-in tools, no hooks, no agents, no additional
//   directories, no system prompt, no plugins. `settingsSources` is not
//   available on SDK 0.3.220 Options (verified 2026-07-25); user settings
//   are always loaded, which the isolated cwd cannot suppress.
// - The prompt is a never-yielding AsyncIterable so no user_message is sent
//   (no chat tokens, no session file write in practice — spike observed
//   0 files under ~/.claude/projects/).

import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Failure vocabulary mirrors protocol/src/index.ts EngineCatalogFailReason.
 *  Duplicated as a plain union here to keep the probe standalone-runnable
 *  without pulling @kaoiro/protocol into the CLI dependency graph. */
type ProbeFailReason =
  | "auth_failed"
  | "spawn_failed"
  | "cli_error"
  | "invalid_output"
  | "timeout";

/** Model row projected from ModelInfo. Only the fields the runner will
 *  advertise via RunnerRegister.engines[].models — nothing account-linked. */
interface ProbeModel {
  value: string;
  display_name: string;
  description: string;
  effort_levels?: string[];
  default_effort?: string;
  /** Canonical wire model ID this row's `value` resolves to, mirrored from
   *  ModelInfo.resolvedModel. Read-only metadata; absent = unknown. */
  resolved_model?: string;
}

interface ProbeSuccess {
  ok: true;
  models: ProbeModel[];
  elapsed_ms: number;
  source: "init" | "supported_models";
}

interface ProbeFailure {
  ok: false;
  reason: ProbeFailReason;
  detail?: string;
  elapsed_ms: number;
}

async function* neverYields(): AsyncGenerator<never, void, void> {
  await new Promise<never>(() => {});
}

interface CliArgs {
  timeoutMs: number;
}

function parseArgs(argv: string[]): CliArgs {
  let timeoutMs = 30_000;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--timeout-ms" && i + 1 < argv.length) {
      const raw = argv[i + 1]!;
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0 || n > 120_000) {
        emit({
          ok: false,
          reason: "cli_error",
          detail: `--timeout-ms must be a positive number <= 120000 (got ${raw})`,
          elapsed_ms: 0,
        });
        process.exit(1);
      }
      timeoutMs = n;
      i++;
    } else if (arg === "--help" || arg === "-h") {
      process.stderr.write(
        "usage: kaoiro-claude-probe [--timeout-ms N]\n" +
          "emits ProbeResult JSON on stdout; exit 0 on success, 1 on failure.\n",
      );
      process.exit(0);
    }
  }
  return { timeoutMs };
}

/** Map an SDK ModelInfo (structural — the SDK type may have extra optional
 *  fields we don't need) to the ProbeModel row shape. Exported for unit
 *  tests; the CLI itself only uses it through main(). */
export function projectModel(m: unknown): ProbeModel | null {
  if (typeof m !== "object" || m === null) return null;
  const rec = m as Record<string, unknown>;
  const value = typeof rec.value === "string" ? rec.value : null;
  const displayName =
    typeof rec.displayName === "string" ? rec.displayName : null;
  const description =
    typeof rec.description === "string" ? rec.description : "";
  if (value === null || displayName === null) return null;
  const out: ProbeModel = {
    value,
    display_name: displayName,
    description,
  };
  if (Array.isArray(rec.supportedEffortLevels)) {
    const levels = rec.supportedEffortLevels.filter(
      (l): l is string => typeof l === "string",
    );
    if (levels.length > 0) out.effort_levels = levels;
  }
  // Read-only metadata: carried only when the SDK reports a non-empty id, so
  // a row without resolvedModel stays byte-identical to the pre-field wire
  // shape. `""` is not a canonical wire ID — it collapses to absent (unknown)
  // rather than publishing a value no lookup could ever match. Not trimmed:
  // the wire ID is preserved verbatim.
  if (typeof rec.resolvedModel === "string" && rec.resolvedModel.length > 0) {
    out.resolved_model = rec.resolvedModel;
  }
  return out;
}

function emit(result: ProbeSuccess | ProbeFailure): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cwd = join(tmpdir(), `kaoiro-claude-probe-${process.pid}-${Date.now()}`);
  mkdirSync(cwd, { recursive: true });

  const t0 = performance.now();
  let q: ReturnType<typeof query> | null = null;

  // Single deadline timer (藤 must-fix 4): flip `timedOut` FIRST, then
  // q.close(); the awaited control request rejects through the catch path
  // below and correctly classifies as "timeout" (previously a separate
  // reject timer could race with the close-triggered rejection and
  // mis-classify as "cli_error"). Cleared explicitly on both success and
  // failure to prevent a late close on an already-completed query.
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    try { q?.close(); } catch {}
  }, args.timeoutMs);
  deadline.unref?.();

  try {
    q = query({
      prompt: neverYields(),
      options: {
        cwd,
        // Minimize side effects: no MCP, no built-in tools, no hooks,
        // no agents, no additional directories. OAuth/keychain are
        // preserved by inheriting the parent env (default). See file header.
        mcpServers: {},
        tools: [],
        allowedTools: [],
        disallowedTools: [],
        additionalDirectories: [],
        agents: {},
      },
    });

    const init = await q.initializationResult();

    // ADR-0039 F3: prefer init.models (the init control response already
    // carries the catalog on SDK 0.3.220). Fall back to supportedModels()
    // only when init did not surface a usable array — future-proofs against
    // SDK response shape drift without paying the second round-trip today.
    let modelsRaw: unknown[] = [];
    let source: "init" | "supported_models" = "init";
    const initModels = (init as { models?: unknown }).models;
    if (Array.isArray(initModels) && initModels.length > 0) {
      modelsRaw = initModels;
    } else {
      source = "supported_models";
      modelsRaw = await q.supportedModels();
    }

    const models = modelsRaw
      .map(projectModel)
      .filter((m): m is ProbeModel => m !== null);

    clearTimeout(deadline);
    q.close();

    // Zero models is not success (藤 must-fix 4): a runner that accepted
    // an empty catalog would overwrite the ADR-0037 F1 `default` bootstrap
    // floor with nothing, leaving LaunchDialog with no options at all. Fail
    // loud instead so the runner keeps the last-known-good (or default).
    if (models.length === 0) {
      emit({
        ok: false,
        reason: "invalid_output",
        detail: `probe returned 0 models (source=${source})`,
        elapsed_ms: Math.round(performance.now() - t0),
      });
      return 1;
    }

    emit({
      ok: true,
      models,
      elapsed_ms: Math.round(performance.now() - t0),
      source,
    });
    return 0;
  } catch (err) {
    clearTimeout(deadline);
    try {
      q?.close();
    } catch {}
    const detail = err instanceof Error ? err.message : String(err);
    const reason: ProbeFailReason = timedOut
      ? "timeout"
      : classifyError(detail);
    emit({
      ok: false,
      reason,
      detail: detail.slice(0, 512),
      elapsed_ms: Math.round(performance.now() - t0),
    });
    return 1;
  } finally {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {}
  }
}

/** Best-effort classification without pattern-scanning secrets: the SDK error
 *  messages we care about mention "auth", "spawn", or connection failures. */
function classifyError(message: string): ProbeFailReason {
  const m = message.toLowerCase();
  if (m.includes("auth") || m.includes("unauthor") || m.includes("token")) {
    return "auth_failed";
  }
  if (m.includes("spawn") || m.includes("enoent") || m.includes("bin")) {
    return "spawn_failed";
  }
  return "cli_error";
}

// Import-safe entrypoint gate (ADR-0039 F9 v2 = 藤 review B): only run
// main() when this file is invoked as a CLI, not when a library module
// imports it. Without this guard, `probe-client.ts`'s `require.resolve()`
// of this file would trigger the SDK query on every import.
import { fileURLToPath } from "node:url";
if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      // Unreachable if main() catches everything, but keep a hard backstop
      // so an unexpected throw never leaves the child stuck.
      emit({
        ok: false,
        reason: "cli_error",
        detail:
          `unhandled: ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            512,
          ),
        elapsed_ms: 0,
      });
      process.exit(2);
    },
  );
}
