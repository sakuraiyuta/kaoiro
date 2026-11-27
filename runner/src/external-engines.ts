import { spawn } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import type { EngineCatalogEntry, EngineModelInfo, RunnerRegister } from "@kaoiro/protocol";
import type { ParsedSpawn } from "./supervisor.js";
import type { RunnerConfig } from "./config.js";
import { registerSizeEstimate, REGISTER_EXTERNAL_LIMIT } from "./delivery-settings.js";
import { isEngine } from "./engines.js";
import { endProbeGroup, probeGroupAlive } from "./grok_acp_probe.js";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(row: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(row).every(key => keys.includes(key));
}

function bounded(value: unknown, bytes: number): value is string {
  return typeof value === "string" && value !== "" && Buffer.byteLength(value) <= bytes;
}

function model(value: unknown): value is EngineModelInfo {
  if (!object(value) || !onlyKeys(value, ["value", "display_name", "effort_levels", "default_effort"])
      || !bounded(value.value, 256) || !bounded(value.display_name, 256)) return false;
  const levels = value.effort_levels;
  if (levels === undefined) return value.default_effort === undefined;
  return Array.isArray(levels) && levels.length >= 1 && levels.length <= 16
    && levels.every(level => bounded(level, 64)) && new Set(levels).size === levels.length
    && (value.default_effort === undefined
      || (typeof value.default_effort === "string" && levels.includes(value.default_effort)));
}

// Only errors raised here carry a public diagnostic. System errors may include argv.
class DescribeFailure extends Error {}

function declaration(bytes: Buffer, id: string): EngineCatalogEntry {
  let decoded: string;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new DescribeFailure("invalid_utf8"); }
  let raw: unknown;
  try { raw = JSON.parse(decoded); } catch { throw new DescribeFailure("invalid_json"); }
  if (!object(raw) || !onlyKeys(raw, ["version", "id", "models", "operations"])) throw new DescribeFailure("invalid_declaration");
  if (raw.version !== 1) throw new DescribeFailure("unsupported_version");
  if (raw.id !== id) throw new DescribeFailure("id_mismatch");
  const ops = raw.operations;
  const optional = ["resume", "enumerate_sessions", "refresh_engine_catalog"];
  if (!object(ops) || !onlyKeys(ops, ["version", "spawn", ...optional])
      || ops.version !== 1 || ops.spawn !== true
      || optional.some(key => key in ops && ops[key] !== false)) throw new DescribeFailure("invalid_operations");
  if (!Array.isArray(raw.models) || raw.models.length > 32 || !raw.models.every(model)
      || new Set(raw.models.map(row => row.value)).size !== raw.models.length) throw new DescribeFailure("invalid_models");
  return { id, models: raw.models, operations: { version: 1, spawn: true } };
}

type Command = [string, ...string[]];

async function describe(command: Command, cwd: string, signal: AbortSignal): Promise<Buffer> {
  const [program, ...fixed] = command;
  const env = { ...process.env };
  delete env.CODEX_HOME;
  const child = spawn(program, [...fixed, "describe"], {
    cwd, env, detached: true, stdio: ["ignore", "pipe", "ignore"],
  });
  let abort!: () => void;
  let deadline: NodeJS.Timeout | undefined;
  try {
    return await new Promise<Buffer>((ok, fail) => {
      const chunks: Buffer[] = [];
      let size = 0;
      abort = () => fail(new DescribeFailure("aborted"));
      deadline = setTimeout(() => fail(new DescribeFailure("timeout")), 2_000);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      child.once("error", (err: NodeJS.ErrnoException) =>
        fail(new DescribeFailure(err.code === "ENOENT" ? "not_found" : "cannot_execute")));
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 16_384) {
          child.stdout.pause();
          fail(new DescribeFailure("output_limit"));
        } else chunks.push(chunk);
      });
      child.stdout.once("error", () => fail(new DescribeFailure("read_failed")));
      child.once("close", (code, sig) => {
        if (code === 0 && sig === null) ok(Buffer.concat(chunks));
        else fail(new DescribeFailure(sig ? "signalled" : "nonzero_exit"));
      });
    });
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", abort);
    const pid = child.pid;
    if (probeGroupAlive(pid)) {
      await endProbeGroup(pid);
      if (probeGroupAlive(pid)) {
        child.stdout.destroy();
        throw new DescribeFailure("cleanup_unconfirmed");
      }
    }
    child.stdout.destroy();
  }
}

function externalId(row: unknown): string | undefined {
  if (!object(row) || !bounded(row.id, 64) || !/^[a-z][a-z0-9-]*$/.test(row.id)
      || isEngine(row.id) || row.id === "claude") return undefined;
  return row.id;
}

function validCommand(raw: unknown): raw is Command {
  return Array.isArray(raw) && raw.length > 0
    && raw.every(arg => typeof arg === "string" && !arg.includes("\0"))
    && isAbsolute(raw[0]);
}

function diagnostic(id: string, reason: string): void {
  process.stderr.write(`runner: external engine ${id} unavailable: ${reason}\n`);
}

export class ExternalEngines {
  readonly #ids = new Set<string>();
  readonly #ready = new Map<string, { command: Command; row: EngineCatalogEntry }>();

  static async discover(config: RunnerConfig, path: string, signal: AbortSignal): Promise<ExternalEngines> {
    const found = new ExternalEngines();
    const rows = config.external_engines ?? [];
    const duplicate = new Set<string>();
    for (const raw of rows) {
      const id = externalId(raw);
      if (id === undefined) continue;
      if (found.#ids.has(id)) duplicate.add(id);
      found.#ids.add(id);
    }
    let count = 0;
    for (const [index, raw] of rows.entries()) {
      signal.throwIfAborted();
      const id = externalId(raw);
      if (id === undefined || !object(raw)) {
        diagnostic(object(raw) && bounded(raw.id, 64) && /^[a-z][a-z0-9-]*$/.test(raw.id)
          ? raw.id : `row[${index}]`, "invalid_or_reserved_id");
        continue;
      }
      if (duplicate.has(id)) { diagnostic(id, "duplicate_id"); continue; }
      if (!onlyKeys(raw, ["id", "command"]) || !validCommand(raw.command)) {
        diagnostic(id, "invalid_command");
        continue;
      }
      if (config.capabilities && !config.capabilities.includes(id)) {
        continue;
      }
      if (++count > 16) { diagnostic(id, "engine_limit"); continue; }
      try {
        const bytes = await describe(raw.command, dirname(resolve(path)), signal);
        found.#ready.set(id, { command: raw.command, row: declaration(bytes, id) });
      } catch (error) {
        signal.throwIfAborted();
        diagnostic(id, error instanceof DescribeFailure ? error.message : "cannot_execute");
      }
    }
    return found;
  }

  command(id: string): Command | undefined { return this.#ready.get(id)?.command; }

  register(base: RunnerRegister, config: RunnerConfig): RunnerRegister {
    if (!this.#ids.size) return base;
    let result: RunnerRegister = {
      ...base, capabilities: (base.capabilities ?? []).filter(id => !this.#ids.has(id)),
    };
    for (const [id, { row }] of this.#ready) {
      if (config.capabilities && !config.capabilities.includes(id)) continue;
      const next = { ...result, capabilities: [...(result.capabilities ?? []), id],
        engines: [...(result.engines ?? []), row] };
      if (registerSizeEstimate(next) > REGISTER_EXTERNAL_LIMIT) diagnostic(id, "register_size");
      else result = next;
    }
    return result;
  }
}

/** Parses only the launch choices supported by a spawn-only declaration. */
export function externalPicks(payload: Record<string, unknown>, row: EngineCatalogEntry):
  Pick<ParsedSpawn, "model" | "modelSource" | "effort" | "effortSource"> | null {
  if (["permission_mode", "sandbox", "approval", "network_access", "resume_session_id"]
      .some(key => Object.hasOwn(payload, key))) return null;
  const freshRestore = payload.apply_resume_snapshot === true;
  const picks: Pick<ParsedSpawn, "model" | "modelSource" | "effort" | "effortSource"> = {};
  let input: Record<string, unknown> = payload;
  if (freshRestore) {
    if ("model" in payload || "effort" in payload) return null;
    if (!("resume_snapshot" in payload)) return picks;
    if (!object(payload.resume_snapshot) || !onlyKeys(payload.resume_snapshot,
      ["model", "effort", "model_source", "effort_source"])) return null;
    input = payload.resume_snapshot;
  } else if ("apply_resume_snapshot" in payload || "resume_snapshot" in payload) {
    return null;
  }
  for (const key of ["model", "effort"] as const) {
    const value = input[key];
    const source = freshRestore ? input[key + "_source"] : undefined;
    if (value === undefined && source === undefined) continue;
    if (typeof value !== "string" || !value.length) return null;
    if (source === "default") continue;
    if (source !== undefined && source !== "launch" && source !== "env" && source !== "config") return null;
    picks[key] = value;
    if (freshRestore) picks[key === "model" ? "modelSource" : "effortSource"] = source ?? "config";
  }
  if (picks.model === undefined) return picks.effort === undefined ? picks : null;
  const selected = row.models.find(item => item.value === picks.model);
  if (!selected || (picks.effort !== undefined && !selected.effort_levels?.includes(picks.effort))) return null;
  return picks;
}
