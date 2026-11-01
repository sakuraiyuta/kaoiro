#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { open, lstat, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openOperator } from "./codex-backend-operator.mjs";
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
    "--phase-target", "--maintenance-evidence", "--agent", "--backend", "--operator-config",
  ]);
  if ([...options.keys()].some((name) => !allowed.has(name))) stop("invalid-arguments");

  const args = Object.fromEntries([...options].map(([key, value]) => [key.slice(2).replaceAll("-", "_"), value]));
  if (!["prepare", "observe", "remove-pin", "pin-exec-fresh", "restore-fresh"].includes(args.phase)
    || !HOST_ID.test(args.host ?? "") || !FULL_SHA.test(args.runner_sha ?? "")) stop("invalid-arguments");
  const inputs = { prepare: ["origin_evidence"], observe: ["phase_target"], "remove-pin": ["maintenance_evidence"],
    "pin-exec-fresh": ["maintenance_evidence"], "restore-fresh": ["maintenance_evidence", "agent", "backend", "operator_config"] };
  const required = [...inputs[args.phase]];
  if (args.phase === "observe") {
    if (!["remove-pin", "pin-exec-fresh", "restore-fresh"].includes(args.phase_target)) stop("invalid-arguments");
    if (args.phase_target === "restore-fresh") required.push("agent", "backend");
  }
  for (const key of ["origin_evidence", "phase_target", "maintenance_evidence", "agent", "backend", "operator_config"]) {
    if (required.includes(key) ? !args[key] : args[key] !== undefined) stop("invalid-arguments");
  }
  if (args.agent && (!HOST_ID.test(args.agent) || hostFromAgentId(args.agent) !== args.host)) stop("invalid-arguments");
  if (args.backend && !BACKENDS.has(args.backend)) stop("invalid-arguments");
  if (args.runner_unit && !/^[A-Za-z0-9@_.:-]+$/.test(args.runner_unit)) stop("invalid-arguments");
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

function exactKeys(value, keys) {
  return isRecord(value) && isStable(Object.keys(value).sort(), [...keys].sort());
}

const RUNNER_FIELDS = ["host", "runnerSha", "invocationId", "configHash", "configMtimeMs", "configuredBackend", "appliedBackend"];
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
const sortedRows = rows => [...rows].sort((a, b) => a.id.localeCompare(b.id));
const runnerState = runner => pick(runner, RUNNER_FIELDS);
const supervisorState = s => ({ ...s, request_id: undefined,
  children: [...s.children].sort((a, b) => a.agent_id.localeCompare(b.agent_id)),
  pending_spawns: [...s.pending_spawns].sort(), pending_switches: [...s.pending_switches].sort() });

async function maintenanceBundle(args, adapters, progress) {
  const read = async () => {
    const h = validateObservation(await observeHost(adapters, args.host, "server-observation-unavailable"), args.host);
    const r = await observeRunner(adapters, args, "runner-observation-unavailable");
    validateRunner({ ...r, expectedRunnerSha: args.runner_sha }, args.host);
    for (const row of h.rows) {
      if (!exactKeys(row, ["id", "directory", "live", "connected", "reset_pending", "transition_pending", "pointer", "engine"])) stop("observation-invalid");
    }
    const sample = { h: { ...h, rows: sortedRows(h.rows) }, r };
    if (progress) progress.read(sample);
    return sample;
  };
  const first = await read();
  let s;
  try { s = await adapters.observeSupervisor(args); }
  catch (error) { if (error instanceof Stop) throw error; stop("supervisor-observation-unavailable"); }
  validateSupervisor(s, args.host);
  if (progress) progress.supervisor(supervisorState(s));
  const last = await read();
  if ((!progress && !isStable(first.h, last.h)) || !isStable(runnerState(first.r), runnerState(last.r))) stop("observation-changed");
  const r = last.r;
  if (s.build_revision !== r.runnerSha || s.invocationId !== r.invocationId || s.configHash !== r.configHash
    || s.configMtimeMs !== r.configMtimeMs || s.applied_backend !== r.appliedBackend
    || (r.configuredBackend !== "omitted" && r.configuredBackend !== r.appliedBackend)) stop("supervisor-identity-mismatch");
  return { ...last, s: supervisorState(s), stable: isStable(first.h, last.h) };
}

function maintenanceBinding({ h, r, s }) {
  return { runner_sha: r.runnerSha, invocation_id: r.invocationId, config_sha256: r.configHash,
    config_mtime_ms: r.configMtimeMs, owner: s.owner, instance_id: s.instance_id, host_rows: h.rows };
}

function maintenanceTarget(args) {
  const phase = args.phase === "observe" ? args.phase_target : args.phase;
  return { phase, agent: phase === "restore-fresh" ? args.agent : null,
    backend: phase === "restore-fresh" ? args.backend : phase === "remove-pin" ? "app-server" : "exec" };
}

function templateFor(args, bundle) {
  const target = maintenanceTarget(args);
  return { schema: 1, host: args.host, phase: target.phase, agent: target.agent, target_backend: target.backend,
    maintenance_owner_accepted: false, binding: maintenanceBinding(bundle),
    agents: bundle.h.rows.map(row => ({ id: row.id,
      classification: row.engine === "codex" ? "codex" : row.engine === null ? "unknown" : "not-codex",
      current_backend: "unknown", evidence_refs: [] })) };
}

async function maintenanceFile(args, adapters) {
  try {
    const raw = await adapters.readMaintenanceEvidence(args.maintenance_evidence);
    if (!(typeof raw === "string" || raw instanceof Uint8Array)) stop("maintenance-evidence-invalid");
    return { hash: sha256(raw), value: JSON.parse(Buffer.from(raw).toString("utf8")) };
  } catch { stop("maintenance-evidence-unavailable"); }
}

function maintenanceEvidence(args, bundle, evidence) {
  const { h, s } = bundle, target = maintenanceTarget(args);
  if (!exactKeys(evidence, ["schema", "host", "phase", "agent", "target_backend", "maintenance_owner_accepted", "binding", "agents"])
    || evidence.schema !== 1 || evidence.host !== args.host || evidence.phase !== target.phase || evidence.agent !== target.agent
    || evidence.target_backend !== target.backend || !Array.isArray(evidence.agents)) stop("maintenance-evidence-invalid");
  if (evidence.maintenance_owner_accepted !== true) stop("maintenance-not-accepted");
  if (!isStable(evidence.binding, maintenanceBinding(bundle))) stop("maintenance-binding-changed");
  const rows = new Map();
  for (const row of evidence.agents) {
    if (!exactKeys(row, ["id", "classification", "current_backend", "evidence_refs"]) || typeof row.id !== "string" || rows.has(row.id)
      || !["codex", "not-codex"].includes(row.classification)
      || !["exec", "app-server", "none", "not-applicable"].includes(row.current_backend)
      || !Array.isArray(row.evidence_refs) || !row.evidence_refs.length
      || !row.evidence_refs.every(ref => typeof ref === "string" && ref.trim().length > 0)) stop("maintenance-evidence-invalid");
    rows.set(row.id, row);
  }
  if (!isStable([...rows.keys()].sort(), h.rows.map(row => row.id).sort())) stop("maintenance-roster-mismatch");
  for (const row of h.rows) {
    const declared = rows.get(row.id);
    if (row.engine !== null && declared.classification !== (row.engine === "codex" ? "codex" : "not-codex")) stop("maintenance-classification-conflict");
    if (declared.classification === "not-codex") {
      if (declared.current_backend !== "not-applicable") stop("maintenance-routing-conflict");
    } else {
      if (declared.current_backend === "none") {
        if (row.connected || row.pointer !== "nil" || hasWork(s, row.id)) stop("maintenance-routing-conflict");
      } else if (declared.current_backend !== bundle.r.appliedBackend) stop("maintenance-routing-conflict");
    }
  }
  for (const id of [...s.children.map(row => row.agent_id), ...s.pending_spawns, ...s.pending_switches]) {
    if (rows.get(id)?.classification !== "codex") stop("maintenance-roster-mismatch");
  }
  return rows;
}

function hasWork(s, id) {
  return s.children.some(row => row.agent_id === id) || s.pending_spawns.includes(id) || s.pending_switches.includes(id);
}

function maintenanceConditions(args, { h, r, s }, rows) {
  if (h.rows.some(row => row.reset_pending || row.transition_pending)) stop("pending-lifecycle");
  if (args.phase === "restore-fresh") {
    const target = h.rows.find(row => row.id === args.agent);
    if (!target || rows.get(target.id).classification !== "codex" || target.connected || target.pointer !== "nil"
      || hasWork(s, target.id)) stop("target-not-fresh");
    if (r.appliedBackend !== args.backend || (args.backend === "exec" ? r.configuredBackend !== "exec"
      : !["omitted", "app-server"].includes(r.configuredBackend))) stop("restore-backend-mismatch");
    if (s.pending_spawns.length || s.pending_switches.length
      || s.children.some(row => row.stopping || row.restarting || row.reset_pending)) stop("supervisor-work-pending");
  } else {
    if (h.rows.some(row => rows.get(row.id).classification === "codex" && (row.connected || row.pointer !== "nil"))) stop("host-not-fresh");
    if (s.children.length || s.pending_spawns.length || s.pending_switches.length) stop("supervisor-not-empty");
    if (args.phase === "remove-pin" && (r.configuredBackend !== "exec" || r.appliedBackend !== "exec" || s.applied_backend !== "exec")) stop("remove-pin-source-not-exec");
  }
}

function stableBundle(before, after) {
  return isStable(before.h, after.h) && isStable(runnerState(before.r), runnerState(after.r)) && isStable(before.s, after.s);
}

function restoreProgress(current, agent) {
  const baseline = new Map(current.h.rows.map(row => [row.id, row]));
  let previous = baseline.get(agent);
  return {
    read({ h, r }) {
      for (const key of RUNNER_FIELDS) if (r[key] !== current.r[key]) stop("observation-changed");
      const target = h.rows.find(row => row.id === agent);
      if (!target) stop("observation-changed");
      for (const key of ["engine", "directory"]) if (target[key] !== baseline.get(agent)[key]) stop("observation-changed");
      if (target.reset_pending) stop("pending-lifecycle");
      if (target.pointer === "missing") stop("observation-invalid");
      if (previous.connected && !target.connected) stop("observation-changed");
      if (previous.pointer === "non_nil" && target.pointer === "nil") stop("observation-changed");
      // live denotes an AgentStates row, not a socket; its baseline may already be true.
      if (previous.live && !target.live) stop("observation-changed");
      if (h.rows.some(row => row.id !== agent && !baseline.has(row.id))) stop("observation-changed");
      if (current.h.rows.some(row => row.id !== agent && !h.rows.some(item => item.id === row.id))) stop("observation-changed");
      for (const row of h.rows) {
        if (row.id !== agent && baseline.has(row.id) && !isStable(row, baseline.get(row.id))) stop("observation-changed");
      }
      previous = target;
    },
    supervisor(s) {
      for (const key of ["owner", "instance_id", "pid", "build_revision"]) if (s[key] !== current.s[key]) stop("observation-changed");
      const siblings = value => value.children.filter(item => item.agent_id !== agent);
      if (!isStable(siblings(current.s), siblings(s))) stop("observation-changed");
      if (s.pending_spawns.some(id => id !== agent)) stop("observation-changed");
      if (s.pending_switches.some(id => id !== agent)) stop("observation-changed");
      for (const flag of ["stopping", "restarting", "reset_pending"]) if (s.children.some(item => item[flag])) stop("supervisor-work-pending");
    },
  };
}

export async function runMaintenance(args, adapters) {
  let stage = "before-write", operator;
  try {
    try {
      const before = await maintenanceBundle(args, adapters);
      if (args.phase === "observe") {
        const receipt = before.r.appliedReceipt;
        return { phase: "observe", status: "observed", runner: { configured_backend: before.r.configuredBackend,
          applied_backend: before.r.appliedBackend, applied_receipt: receipt ? pick(receipt, ["backend", "source", "timestampUs"]) : null },
          maintenance_template: templateFor(args, before) };
      }
      const evidence = await maintenanceFile(args, adapters);
      const rows = maintenanceEvidence(args, before, evidence.value);
      maintenanceConditions(args, before, rows);
      const noWrite = args.phase === "pin-exec-fresh" && before.r.configuredBackend === "exec";
      let cursor;
      if (args.phase === "restore-fresh") {
        try { operator = await adapters.openOperator(args.operator_config); }
        catch { stop("operator-unavailable"); }
      } else if (!noWrite) {
        try { cursor = await adapters.captureAckCursor(args); } catch { stop("ack-cursor-unavailable"); }
        if (typeof cursor !== "string" || !cursor) stop("ack-cursor-unavailable");
      }
      const current = await maintenanceBundle(args, adapters);
      if (!stableBundle(before, current)) stop("observation-changed");
      const currentEvidence = await maintenanceFile(args, adapters);
      if (evidence.hash !== currentEvidence.hash) stop("maintenance-evidence-changed");
      maintenanceConditions(args, current, maintenanceEvidence(args, current, currentEvidence.value));
      const target = maintenanceTarget(args);
      const result = { phase: args.phase, status: noWrite ? "already-selected" : "selected", host: args.host,
        backend: target.backend, ...(target.agent ? { agent: target.agent } : {}), maintenance_evidence_sha256: evidence.hash };
      if (args.phase === "restore-fresh") {
        stage = "restore-outcome-unknown";
        try { await operator.restore(args.agent); } catch { stop("restore-unconfirmed"); }
        const until = Date.now() + 30_000, progress = restoreProgress(current, args.agent);
        do {
          const after = await maintenanceBundle(args, adapters, progress);
          if (Date.now() >= until) stop("restore-unconfirmed");
          const row = after.h.rows.find(item => item.id === args.agent), child = after.s.children.find(item => item.agent_id === args.agent);
          if (after.stable && row?.connected && !row.reset_pending && !row.transition_pending && child
            && !after.s.pending_spawns.length && !after.s.pending_switches.length) return { ...result, status: "restored" };
          await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
        } while (Date.now() < until);
        stop("restore-unconfirmed");
      }
      if (noWrite) return result;
      stage = "write-outcome-unknown";
      let written;
      try { written = await adapters.writeBackend({ args, expected: current.r, selection: args.phase === "remove-pin" ? "omitted" : "exec" }); }
      catch { stop("config-write-failed"); }
      stage = "after-write";
      let acknowledged;
      try { acknowledged = await adapters.waitForAppliedBackend({ args, cursor, invocationId: current.r.invocationId, timeoutMs: ACK_TIMEOUT_MS, backend: target.backend }); }
      catch { stop("applied-selection-acknowledgement-missing"); }
      if (acknowledged !== true) stop("applied-selection-acknowledgement-missing");
      const after = await maintenanceBundle(args, adapters);
      const receipt = after.r.appliedReceipt;
      if (!isStable(current.h, after.h) || !isStable(current.s, { ...after.s, applied_backend: current.s.applied_backend,
        configHash: current.s.configHash, configMtimeMs: current.s.configMtimeMs })
        || current.r.invocationId !== after.r.invocationId || current.r.runnerSha !== after.r.runnerSha
        || after.r.configuredBackend !== (args.phase === "remove-pin" ? "omitted" : "exec") || after.r.appliedBackend !== target.backend
        || !written || after.r.configHash !== written.configHash || after.r.configMtimeMs !== written.configMtimeMs
        || after.r.configHash === current.r.configHash || receipt?.backend !== target.backend || receipt?.source !== "reload"
        || !Number.isFinite(receipt.timestampUs) || receipt.timestampUs <= after.r.configMtimeMs * 1000) stop("applied-selection-unverified");
      return result;
    } finally { if (operator) await operator.close(); }
  } catch (error) {
    const failure = error instanceof Stop ? error : new Stop("adapter-failed");
    failure.stage = stage;
    throw failure;
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

function validateSupervisor(value, host) {
    if (!isRecord(value) || value.version !== "0" || value.schema !== 1 || value.host !== host
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
        || ids.some((id) => typeof id !== "string" || id.length > 256 || !HOST_ID.test(id) || hostFromAgentId(id) !== host)) {
        stop("supervisor-observation-unavailable");
      }
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
    validateSupervisor(value, args.host);
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
    readMaintenanceEvidence: (file) => readFile(resolve(file)),
    openOperator,

    async captureAckCursor() {
      const output = runCommand("journalctl", ["--user", "--no-pager", "--lines=0", "--show-cursor"]);
      const cursor = output.match(/^-- cursor: (.+)$/m)?.[1];
      if (!cursor) stop();
      return cursor;
    },
    writeBackendExec(input) { return this.writeBackend({ ...input, selection: "exec" }); },
    async writeBackend({ expected, selection }) {
      const file = resolve(args.runner_config);
      const beforeStat = await lstat(file).catch(() => stop());
      if (!beforeStat.isFile() || beforeStat.isSymbolicLink()) stop();
      const before = await readFile(file).catch(() => stop());
      if (sha256(before) !== expected.configHash || beforeStat.mtimeMs !== expected.configMtimeMs) stop();
      const config = JSON.parse(before.toString("utf8"));
      if (!isRecord(config) || config.host_id !== args.host || configuredBackend(config) !== expected.configuredBackend
        || !["omitted", "exec"].includes(selection)) stop();
      config.codex ??= {};
      if (selection === "omitted") delete config.codex.backend;
      else config.codex.backend = selection;
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
        return { configHash: sha256(after), configMtimeMs: (await stat(file)).mtimeMs };
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        await unlink(temporary).catch(() => {});
        rethrowRunnerIdentityStop(error);
        stop();
      }
    },
    waitForAppliedBackendExec(input) { return this.waitForAppliedBackend({ ...input, backend: "exec" }); },
    async waitForAppliedBackend({ cursor, invocationId, timeoutMs, backend }) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        if (readInvocation(args.runner_unit, runCommand) !== invocationId) return false;
        const output = runCommand("journalctl", [
          "--user", `_SYSTEMD_INVOCATION_ID=${invocationId}`,
          `--after-cursor=${cursor}`, "--no-pager", "--output=cat",
        ]);
        if (output.split(/\r?\n/).includes(`runner: codex backend=${backend} for subsequent wrappers`)) return true;
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
    const result = await (args.phase === "prepare" ? runPrepare(args, selectedAdapters) : runMaintenance(args, selectedAdapters));
    io.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof Stop ? error.message : "adapter-failed";
    if (error instanceof Stop && error.stage) {
      io.stderr.write(`${JSON.stringify({ status: "stopped", reason: code, stage: error.stage })}\n`);
      return 1;
    }
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
