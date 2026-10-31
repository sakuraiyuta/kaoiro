#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { open, lstat, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execChildSync } from "./child-process-environment.mjs";

const HOST_ID = /^[A-Za-z0-9._-]+$/;
const FULL_SHA = /^[0-9a-f]{40}$/i;
const BACKENDS = new Set(["exec", "app-server"]);
const ENGINES = new Set(["claude-code", "codex", "antigravity", "grok"]);
const NULL_ENGINE_ORIGINS = new Set(["exec", "none", "not-codex", "unknown"]);
const ACK_TIMEOUT_MS = 30_000;

class Stop extends Error {}

function stop(code = "guard-rejected") {
  throw new Stop(code);
}

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--") || index + 1 >= argv.length || options.has(name)) stop("invalid-arguments");
    options.set(name, argv[++index]);
  }
  const allowed = new Set([
    "--phase", "--host", "--runner-sha", "--compose-file", "--runner-config",
    "--runner-unit", "--origin-evidence", "--adapter-module",
  ]);
  if ([...options.keys()].some((name) => !allowed.has(name))) stop("invalid-arguments");

  const args = Object.fromEntries([...options].map(([key, value]) => [key.slice(2).replaceAll("-", "_"), value]));
  if (args.phase !== "prepare" || !HOST_ID.test(args.host ?? "") || !FULL_SHA.test(args.runner_sha ?? "")) stop("invalid-arguments");
  if (args.runner_unit && !/^[A-Za-z0-9@_.:-]+$/.test(args.runner_unit)) stop("invalid-arguments");
  if (!args.origin_evidence) stop("invalid-arguments");
  if (!args.adapter_module && (!args.compose_file || !args.runner_config || !args.runner_unit)) stop("invalid-arguments");
  return args;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hostFromAgentId(id) {
  const lastDot = id.lastIndexOf(".");
  return lastDot < 0 ? id : id.slice(0, lastDot);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateObservation(observation, host) {
  if (!isRecord(observation) || observation.schema !== 1 || observation.host !== host || !Array.isArray(observation.rows)) stop("observation-invalid");
  const seen = new Set();
  for (const row of observation.rows) {
    if (!isRecord(row) || typeof row.id !== "string" || !HOST_ID.test(row.id)
      || hostFromAgentId(row.id) !== host || seen.has(row.id)) stop("observation-invalid");
    seen.add(row.id);
    if (typeof row.directory !== "boolean" || typeof row.live !== "boolean" || typeof row.connected !== "boolean"
      || typeof row.reset_pending !== "boolean" || typeof row.transition_pending !== "boolean") stop("observation-invalid");
    if (!["missing", "nil", "non_nil"].includes(row.pointer)) stop("observation-invalid");
    if (row.engine !== null && (typeof row.engine !== "string" || !ENGINES.has(row.engine))) stop("observation-invalid");
  }
  return observation;
}

function validateRunner(runner, host) {
  if (!isRecord(runner) || runner.host !== host || !["omitted", ...BACKENDS].includes(runner.configuredBackend)
    || ![null, ...BACKENDS].includes(runner.appliedBackend) || typeof runner.configHash !== "string"
    || !/^[0-9a-f]{64}$/.test(runner.configHash) || !Number.isFinite(runner.configMtimeMs)
    || typeof runner.runnerSha !== "string" || !FULL_SHA.test(runner.runnerSha)
    || typeof runner.invocationId !== "string" || !/^[0-9a-f]{32}$/.test(runner.invocationId)) stop("runner-observation-invalid");
  if (runner.runnerSha.toLowerCase() !== runner.expectedRunnerSha?.toLowerCase()) stop("runner-identity-mismatch");
  return runner;
}

function verifyOriginEvidence(evidence, observation, runner) {
  if (!isRecord(evidence) || evidence.schema !== 1 || evidence.host !== observation.host
    || evidence.config_sha256 !== runner.configHash
    || evidence.config_mtime_ms !== runner.configMtimeMs
    || evidence.runner_sha !== runner.runnerSha.toLowerCase()
    || evidence.invocation_id !== runner.invocationId
    || evidence.all_relevant_sessions_covered !== true || !Array.isArray(evidence.agent_ids)
    || !Array.isArray(evidence.agents)
    || !isStable([...evidence.agent_ids].sort(), observation.rows.map((row) => row.id).sort())) stop("origin-evidence-invalid");

  if (!["measured", "operator-attestation"].includes(evidence.origin_source)) stop("origin-evidence-invalid");
  if (evidence.origin_source === "operator-attestation") {
    const attestation = evidence.attestation;
    if (!isRecord(attestation) || attestation.accepted !== true
      || typeof attestation.attested_at !== "string" || attestation.attested_at.trim() === ""
      || typeof attestation.scope !== "string" || attestation.scope.trim() === ""
      || typeof attestation.release_range !== "string" || attestation.release_range.trim() === ""
      || typeof attestation.statement !== "string" || attestation.statement.trim() === ""
      || !Array.isArray(attestation.unknown_origin_rows)
      || !Array.isArray(attestation.contrary_rows) || attestation.contrary_rows.length !== 0
      || !Array.isArray(attestation.unresolved_rows) || attestation.unresolved_rows.length !== 0) stop("origin-evidence-invalid");
    for (const id of attestation.unknown_origin_rows) {
      if (typeof id !== "string" || !HOST_ID.test(id) || hostFromAgentId(id) !== observation.host) stop("origin-evidence-invalid");
    }
  } else if (evidence.attestation !== undefined) {
    stop("origin-evidence-invalid");
  }

  const byId = new Map();
  for (const entry of evidence.agents) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !HOST_ID.test(entry.id)
      || hostFromAgentId(entry.id) !== observation.host || byId.has(entry.id)
      || entry.complete !== true || !["exec", "none", "not-codex", "unknown", "app-server"].includes(entry.origin)) stop("origin-evidence-invalid");
    if (entry.origin === "app-server") stop("origin-evidence-conflict");
    if (entry.origin === "unknown") {
      const unknownIds = evidence.attestation?.unknown_origin_rows;
      if (evidence.origin_source !== "operator-attestation" || !unknownIds?.includes(entry.id)) stop("origin-unknown");
    }
    byId.set(entry.id, entry);
  }

  if (evidence.origin_source === "operator-attestation") {
    const declaredUnknown = evidence.attestation.unknown_origin_rows;
    const observedUnknown = [...byId.values()].filter((entry) => entry.origin === "unknown").map((entry) => entry.id).sort();
    if (new Set(declaredUnknown).size !== declaredUnknown.length
      || !isStable([...declaredUnknown].sort(), observedUnknown)) stop("origin-evidence-invalid");
  }

  for (const row of observation.rows) {
    const entry = byId.get(row.id);
    if (!entry) stop("origin-evidence-incomplete");
    if (row.engine === "codex") {
      if (entry.origin !== "exec" && entry.origin !== "none" && entry.origin !== "unknown") stop("origin-evidence-conflict");
      if (row.pointer === "non_nil" && entry.origin === "none") stop("origin-evidence-conflict");
    } else if (row.engine === null) {
      if (!NULL_ENGINE_ORIGINS.has(entry.origin)) stop("origin-evidence-conflict");
      if (row.pointer === "non_nil" && entry.origin === "none") stop("origin-evidence-conflict");
    } else {
      if (entry.origin !== "not-codex" && entry.origin !== "none") stop("origin-evidence-conflict");
      if (row.pointer === "non_nil" && entry.origin === "none") stop("origin-evidence-conflict");
    }
  }
  return evidence;
}

function isStable(a, b) {
  return stableJson(a) === stableJson(b);
}

export async function runPrepare(args, adapters) {
  if (!adapters || typeof adapters.observeHost !== "function" || typeof adapters.observeRunner !== "function"
    || typeof adapters.readOriginEvidence !== "function" || typeof adapters.captureAckCursor !== "function"
    || typeof adapters.writeBackendExec !== "function" || typeof adapters.waitForAppliedBackendExec !== "function") stop();

  let beforeRunner;
  beforeRunner = await observeRunner(adapters, args, "runner-observation-unavailable");
  validateRunner({ ...beforeRunner, expectedRunnerSha: args.runner_sha }, args.host);

  if (beforeRunner.configuredBackend !== "omitted") {
    if (beforeRunner.appliedBackend !== beforeRunner.configuredBackend) stop();
    return { phase: "prepare", status: "already-explicit", host: args.host, backend: beforeRunner.configuredBackend };
  }

  if (beforeRunner.appliedBackend !== "exec") stop("applied-selection-not-exec");

  const beforeHost = await observeHost(adapters, args.host, "server-observation-unavailable");
  validateObservation(beforeHost, args.host);
  // Stop before reading routing evidence when a lifecycle transition is already active.
  if (beforeHost.rows.some((row) => row.reset_pending || row.transition_pending)) stop("pending-lifecycle");

  let evidence;
  try {
    evidence = await adapters.readOriginEvidence(args.origin_evidence);
  } catch {
    stop("origin-evidence-unavailable");
  }
  verifyOriginEvidence(evidence, beforeHost, beforeRunner);

  let cursor;
  try {
    cursor = await adapters.captureAckCursor(args);
  } catch {
    stop("ack-cursor-unavailable");
  }
  if (typeof cursor !== "string" || cursor.length === 0) stop();

  const [currentHost, currentRunner] = await Promise.all([
    observeHost(adapters, args.host, "pre-write-observation-unavailable"),
    observeRunner(adapters, args, "pre-write-observation-unavailable"),
  ]);
  validateObservation(currentHost, args.host);
  validateRunner({ ...currentRunner, expectedRunnerSha: args.runner_sha }, args.host);
  // Evidence and cursor collection can take time; repeat the lifecycle gate at the write boundary.
  if (currentHost.rows.some((row) => row.reset_pending || row.transition_pending)) stop("pending-lifecycle");
  if (!isStable(beforeHost, currentHost) || !isStable(beforeRunner, currentRunner)) stop("observation-changed");
  if (currentRunner.configuredBackend !== "omitted" || currentRunner.appliedBackend !== "exec") stop("applied-selection-changed");
  let currentEvidence;
  try {
    currentEvidence = await adapters.readOriginEvidence(args.origin_evidence);
  } catch {
    stop("origin-evidence-unavailable");
  }
  if (!isStable(evidence, currentEvidence)) stop("origin-evidence-changed");
  verifyOriginEvidence(currentEvidence, currentHost, currentRunner);

  try {
    await adapters.writeBackendExec({ args, expected: currentRunner });
  } catch {
    stop("config-write-failed");
  }

  let acknowledged = false;
  try {
    acknowledged = await adapters.waitForAppliedBackendExec({
      args,
      cursor,
      invocationId: currentRunner.invocationId,
      timeoutMs: ACK_TIMEOUT_MS,
    });
  } catch {
    stop("applied-selection-acknowledgement-missing");
  }
  if (acknowledged !== true) stop("applied-selection-acknowledgement-missing");

  let afterRunner;
  try {
    afterRunner = await adapters.observeRunner(args);
  } catch (error) {
    rethrowRunnerIdentityStop(error);
    stop("post-write-observation-unavailable");
  }
  validateRunner({ ...afterRunner, expectedRunnerSha: args.runner_sha }, args.host);
  if (afterRunner.configuredBackend !== "exec" || afterRunner.appliedBackend !== "exec"
    || afterRunner.configHash === currentRunner.configHash
    || afterRunner.invocationId !== currentRunner.invocationId
    || afterRunner.runnerSha.toLowerCase() !== currentRunner.runnerSha.toLowerCase()
    || !isRecord(afterRunner.appliedReceipt) || afterRunner.appliedReceipt.backend !== "exec"
    || afterRunner.appliedReceipt.source !== "reload"
    || afterRunner.appliedReceipt.timestampUs <= afterRunner.configMtimeMs * 1000) stop("applied-selection-unverified");

  return { phase: "prepare", status: "prepared", host: args.host, backend: "exec" };
}

async function observeHost(adapters, host, failureCode) {
  try {
    return await adapters.observeHost(host);
  } catch {
    stop(failureCode);
  }
}

async function observeRunner(adapters, args, failureCode) {
  try {
    return await adapters.observeRunner(args);
  } catch (error) {
    rethrowRunnerIdentityStop(error);
    stop(failureCode);
  }
}

function run(command, argv, options = {}) {
  try {
    const profile = command === "systemctl" || command === "journalctl" ? "systemd" : "authority";
    return execChildSync(profile, command, argv, {
      encoding: "utf8",
      timeout: options.timeoutMs ?? 15_000,
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    if (error?.code === "ENOBUFS") throw error;
    stop();
  }
}

function parseJsonOutput(output) {
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line);
      if (isRecord(value)) return value;
    } catch {
      // Operational tools may emit a fixed-format heading before their JSON record.
    }
  }
  stop();
}

function runnerIdentity(host, invocationId, runCommand = run) {
  let output;
  try {
    output = runCommand("journalctl", [
      "--user", `_SYSTEMD_INVOCATION_ID=${invocationId}`, "--no-pager", "--output=cat",
    ]);
  } catch (error) {
    if (error?.code === "ENOBUFS") stop("runner-start-record-unavailable");
    throw error;
  }
  const records = output.split(/\r?\n/).filter((line) => line.startsWith("runner: host="));
  if (records.length !== 1) stop("runner-start-record-unavailable");
  const match = records[0].match(/^runner: host=([A-Za-z0-9._-]+) rev=([a-f0-9]{40})(-dirty)? connecting to \S.*$/i);
  if (!match) stop("runner-start-record-unavailable");
  if (match[1] !== host) stop();
  if (match[3]) stop("runner-identity-dirty");
  return match[2].toLowerCase();
}

function rethrowRunnerIdentityStop(error) {
  if (error instanceof Stop && ["runner-start-record-unavailable", "runner-identity-dirty"].includes(error.message)) throw error;
}

function configuredBackend(config) {
  if (!isRecord(config)) stop();
  if (config.codex === undefined) return "omitted";
  if (!isRecord(config.codex)) stop();
  const backend = config.codex.backend;
  if (backend === undefined) return "omitted";
  if (!BACKENDS.has(backend)) stop();
  return backend;
}

function readInvocation(unit, runCommand = run) {
  const output = runCommand("systemctl", ["--user", "show", "-p", "InvocationID", "--value", unit]);
  const invocationId = output.trim();
  if (!/^[0-9a-f]{32}$/.test(invocationId)) stop();
  return invocationId;
}

function journalRows(_unit, invocationId, runCommand = run) {
  const output = runCommand("journalctl", [
    "--user", `_SYSTEMD_INVOCATION_ID=${invocationId}`,
    "--no-pager", "--output=json", "--lines=10000",
  ]);
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      stop();
    }
  });
}

async function readLocalRunner(args, runCommand = run) {
  const file = resolve(args.runner_config);
  const beforeStat = await lstat(file).catch(() => stop());
  if (!beforeStat.isFile() || beforeStat.isSymbolicLink()) stop();
  const raw = await readFile(file).catch(() => stop());
  const config = JSON.parse(raw.toString("utf8"));
  if (!isRecord(config) || config.host_id !== args.host) stop();
  const configHash = sha256(raw);
  const configMtimeMs = beforeStat.mtimeMs;
  const selectedInvocation = readInvocation(args.runner_unit, runCommand);
  const rows = journalRows(args.runner_unit, selectedInvocation, runCommand);
  const runnerSha = runnerIdentity(args.host, selectedInvocation, runCommand);
  const events = [];
  for (const row of rows) {
    if (typeof row.MESSAGE !== "string" || !/^\d+$/.test(String(row.__REALTIME_TIMESTAMP ?? ""))) continue;
    const timestampUs = Number(row.__REALTIME_TIMESTAMP);
    if (timestampUs <= configMtimeMs * 1000) continue;
    const runnerAck = row.MESSAGE.match(/^runner: codex backend=(exec|app-server) for subsequent wrappers$/);
    const wrapperStart = row.MESSAGE.match(/^codex: backend=(exec|app-server)$/);
    const match = runnerAck ?? wrapperStart;
    if (match) events.push({ backend: match[1], timestampUs, pid: row._PID, source: runnerAck ? "reload" : "wrapper" });
  }
  events.sort((a, b) => a.timestampUs - b.timestampUs);
  const latestEvent = events.at(-1) ?? null;
  const latestReload = events.filter((event) => event.source === "reload").at(-1) ?? null;
  const endRaw = await readFile(file).catch(() => stop());
  const endStat = await stat(file).catch(() => stop());
  const finalInvocation = readInvocation(args.runner_unit, runCommand);
  if (sha256(endRaw) !== configHash || endStat.mtimeMs !== configMtimeMs || finalInvocation !== selectedInvocation) stop();
  return {
    host: args.host,
    configuredBackend: configuredBackend(config),
    appliedBackend: latestEvent?.backend ?? null,
    appliedReceipt: latestReload ?? latestEvent,
    configHash,
    configMtimeMs,
    runnerSha,
    invocationId: selectedInvocation,
  };
}

function hostObservationCommand(host) {
  const hostLiteral = JSON.stringify(host);
  return [
    `case KaoiroServer.CodexBackendCompatibility.observe_host(${hostLiteral}) do`,
    "  {:ok, projection} -> IO.puts(Jason.encode!(projection))",
    '  {:error, _reason} -> raise "codex backend observation unavailable"',
    "end",
  ].join("\n");
}

async function parseOriginFile(file) {
  try {
    return JSON.parse(await readFile(resolve(file), "utf8"));
  } catch {
    stop();
  }
}

export async function observeSupervisor(args, runCommand = run) {
  if (!HOST_ID.test(args.host ?? "") || args.host.length > 256) stop("invalid-arguments");
  const readPid = () => {
    const value = runCommand("systemctl", ["--user", "show", "-p", "MainPID", "--value", args.runner_unit]).trim();
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) stop("supervisor-identity-mismatch");
    return Number(value);
  };
  const query = () => {
    const command = [
      `case KaoiroServer.CodexBackendCompatibility.observe_runner(${JSON.stringify(args.host)}) do`,
      "  {:ok, projection} -> IO.puts(Jason.encode!(projection))",
      '  {:error, reason} -> IO.puts(Jason.encode!(%{error: to_string(reason)}))',
      "end",
    ].join("\n");
    const value = parseJsonOutput(runCommand("docker", [
      "compose", "-f", resolve(args.compose_file), "exec", "-T", "kaoiro",
      "/app/bin/kaoiro_server", "rpc", command,
    ]));
    if (value?.error === "runner_registry_changed") stop("runner-registry-changed");
    if (!isRecord(value) || value.version !== "0" || value.schema !== 1 || value.host !== args.host
      || !FULL_SHA.test(value.build_revision ?? "") || !Number.isSafeInteger(value.pid) || value.pid < 1
      || typeof value.instance_id !== "string" || !/^[0-9a-f-]{36}$/.test(value.instance_id)
      || typeof value.owner !== "string" || !/^#PID<[0-9.]+>$/.test(value.owner)
      || typeof value.request_id !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(value.request_id)
      || !BACKENDS.has(value.applied_backend) || !Array.isArray(value.children)
      || !value.children.every((row) => isRecord(row) && [row.stopping, row.restarting, row.reset_pending].every((v) => typeof v === "boolean"))) {
      stop("supervisor-observation-unavailable");
    }
    for (const ids of [value.children.map((row) => row.agent_id), value.pending_spawns, value.pending_switches]) {
      if (!Array.isArray(ids) || new Set(ids).size !== ids.length
        || ids.some((id) => typeof id !== "string" || id.length > 256 || !HOST_ID.test(id) || hostFromAgentId(id) !== args.host)) {
        stop("supervisor-observation-unavailable");
      }
    }
    return value;
  };
  const before = await readLocalRunner(args, runCommand);
  const pid = readPid();
  const first = query();
  const last = query();
  const after = await readLocalRunner(args, runCommand);
  if (pid !== readPid() || first.pid !== pid || last.pid !== pid
    || ["owner", "instance_id", "build_revision", "applied_backend"].some((key) => first[key] !== last[key])
    || ["configHash", "configMtimeMs", "runnerSha", "invocationId", "configuredBackend", "appliedBackend"].some((key) => before[key] !== after[key])
    || first.build_revision !== before.runnerSha || first.applied_backend !== before.appliedBackend
    || (before.configuredBackend !== "omitted" && first.applied_backend !== before.configuredBackend)) stop("supervisor-identity-mismatch");
  return { ...last, invocationId: before.invocationId, configHash: before.configHash, configMtimeMs: before.configMtimeMs };
}

function localAdapters(args, runCommand = run) {
  return {
    async observeHost(host) {
      const output = runCommand("docker", [
        "compose", "-f", resolve(args.compose_file), "exec", "-T", "kaoiro",
        "/app/bin/kaoiro_server", "rpc", hostObservationCommand(host),
      ]);
      return parseJsonOutput(output);
    },
    observeRunner: (runnerArgs) => readLocalRunner(runnerArgs, runCommand),
    observeSupervisor: () => observeSupervisor(args, runCommand),
    readOriginEvidence: async (file) => parseOriginFile(file),
    async captureAckCursor() {
      const output = runCommand("journalctl", ["--user", "--no-pager", "--lines=0", "--show-cursor"]);
      const cursor = output.match(/^-- cursor: (.+)$/m)?.[1];
      if (!cursor) stop();
      return cursor;
    },
    async writeBackendExec({ expected }) {
      const file = resolve(args.runner_config);
      const beforeStat = await lstat(file).catch(() => stop());
      if (!beforeStat.isFile() || beforeStat.isSymbolicLink()) stop();
      const before = await readFile(file).catch(() => stop());
      if (sha256(before) !== expected.configHash || beforeStat.mtimeMs !== expected.configMtimeMs) stop();
      const config = JSON.parse(before.toString("utf8"));
      if (!isRecord(config) || config.host_id !== args.host || configuredBackend(config) !== "omitted") stop();
      config.codex ??= {};
      config.codex.backend = "exec";
      const after = `${JSON.stringify(config, null, 2)}\n`;
      const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
      let handle;
      try {
        handle = await open(temporary, "wx", beforeStat.mode & 0o777);
        await handle.writeFile(after, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        const currentStat = await lstat(file);
        const current = await readFile(file);
        if (currentStat.isSymbolicLink() || sha256(current) !== expected.configHash
          || currentStat.mtimeMs !== expected.configMtimeMs
          || readInvocation(args.runner_unit, runCommand) !== expected.invocationId
          || runnerIdentity(args.host, expected.invocationId, runCommand) !== expected.runnerSha.toLowerCase()) stop();
        await rename(temporary, file);
        const directory = await open(dirname(file), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        await unlink(temporary).catch(() => {});
        rethrowRunnerIdentityStop(error);
        stop();
      }
    },
    async waitForAppliedBackendExec({ cursor, invocationId, timeoutMs }) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        if (readInvocation(args.runner_unit, runCommand) !== invocationId) return false;
        const output = runCommand("journalctl", [
          "--user", `_SYSTEMD_INVOCATION_ID=${invocationId}`,
          `--after-cursor=${cursor}`, "--no-pager", "--output=cat",
        ]);
        if (output.split(/\r?\n/).includes("runner: codex backend=exec for subsequent wrappers")) return true;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      }
      return false;
    },
  };
}

async function loadAdapterModule(args) {
  const moduleUrl = pathToFileURL(resolve(args.adapter_module));
  const module = await import(moduleUrl.href);
  if (typeof module.createAdapters !== "function") stop();
  const adapters = await module.createAdapters(args);
  if (!adapters || typeof adapters !== "object") stop();
  return adapters;
}

export async function main(argv = process.argv.slice(2), adapters = undefined, io = process, runtime = {}) {
  try {
    const args = parseArgs(argv);
    const selectedAdapters = adapters ?? (args.adapter_module ? await loadAdapterModule(args) : localAdapters(args, runtime.runCommand));
    const result = await runPrepare(args, selectedAdapters);
    io.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof Stop ? error.message : "adapter-failed";
    const allowed = new Set([
      "guard-rejected", "server-observation-unavailable", "runner-observation-unavailable",
      "pre-write-observation-unavailable", "post-write-observation-unavailable",
      "origin-evidence-unavailable", "origin-evidence-invalid", "origin-evidence-changed",
      "origin-evidence-conflict", "origin-evidence-incomplete", "origin-unknown",
      "observation-invalid", "engine-unknown", "runner-observation-invalid", "runner-identity-mismatch",
      "pending-lifecycle", "applied-selection-not-exec", "applied-selection-changed",
      "applied-selection-acknowledgement-missing", "applied-selection-unverified",
      "observation-changed", "config-write-failed", "ack-cursor-unavailable",
      "invalid-arguments", "runner-start-record-unavailable", "runner-identity-dirty", "adapter-failed",
    ]);
    io.stderr.write(`codex backend preparation stopped (${allowed.has(code) ? code : "adapter-failed"}); no additional write, rollback, or restore was attempted\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  process.exitCode = await main();
}
