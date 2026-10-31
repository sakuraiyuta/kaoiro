import "./fixtures/test-isolation.mjs";
import assert from "node:assert/strict";
import childProcess, { execFileSync, spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { main, observeSupervisor } from "../codex-backend-compatibility.mjs";

const HOST = "legacy-host";
const RUNNER_SHA = "475e0d5d01d173b46be3bbb7b28564ccf8743abd";
const CONFIG_HASH = "a".repeat(64);
const NEXT_CONFIG_HASH = "b".repeat(64);
const INVOCATION_ID = "1234567890abcdef1234567890abcdef";
const AGENT_ID = `${HOST}.agent`;

function observation(overrides = {}) {
  return {
    schema: 1,
    host: HOST,
    rows: [{
      id: AGENT_ID,
      directory: true,
      pointer: "non_nil",
      engine: "codex",
      live: false,
      connected: false,
      reset_pending: false,
      transition_pending: false,
      ...overrides,
    }],
  };
}

function emptyObservation() {
  return { schema: 1, host: HOST, rows: [] };
}

function runnerObservation(overrides = {}) {
  return {
    host: HOST,
    configuredBackend: "omitted",
    appliedBackend: "exec",
    appliedReceipt: { backend: "exec", source: "wrapper", timestampUs: 2_000_000 },
    configHash: CONFIG_HASH,
    configMtimeMs: 1_000,
    runnerSha: RUNNER_SHA,
    invocationId: INVOCATION_ID,
    ...overrides,
  };
}

function originEvidence(runner = runnerObservation()) {
  return {
    schema: 1,
    host: HOST,
    config_sha256: runner.configHash,
    config_mtime_ms: runner.configMtimeMs,
    runner_sha: runner.runnerSha,
    invocation_id: runner.invocationId,
    all_relevant_sessions_covered: true,
    origin_source: "measured",
    agent_ids: [AGENT_ID],
    agents: [{ id: AGENT_ID, origin: "exec", complete: true }],
  };
}

function emptyOriginEvidence(runner = runnerObservation()) {
  return {
    ...originEvidence(runner),
    agent_ids: [],
    agents: [],
  };
}

function makeAdapters({ hosts = [], runners = [], evidence, acknowledge = true, fail = {} } = {}) {
  const calls = { host: 0, runner: 0, origin: 0, cursor: 0, writes: 0, acknowledgements: 0, restores: 0 };
  const fallbackHost = observation();
  const beforeRunner = runnerObservation();
  const afterRunner = runnerObservation({
    configuredBackend: "exec",
    appliedBackend: "exec",
    appliedReceipt: { backend: "exec", source: "reload", timestampUs: 2_500_000 },
    configHash: NEXT_CONFIG_HASH,
    configMtimeMs: 2_000,
  });
  return {
    calls,
    adapters: {
      async observeHost() {
        calls.host += 1;
        if (fail.hostAt === calls.host) throw new Error("unavailable");
        return structuredClone(hosts[calls.host - 1] ?? fallbackHost);
      },
      async observeRunner() {
        calls.runner += 1;
        if (fail.runnerAt === calls.runner) throw new Error("unavailable");
        return structuredClone(runners[calls.runner - 1] ?? (calls.runner >= 3 ? afterRunner : beforeRunner));
      },
      async readOriginEvidence() {
        calls.origin += 1;
        if (fail.origin) throw new Error("unavailable");
        return structuredClone(evidence ?? originEvidence(beforeRunner));
      },
      async captureAckCursor() {
        calls.cursor += 1;
        return "cursor-before-write";
      },
      async writeBackendExec() {
        calls.writes += 1;
        if (fail.write) throw new Error("write failed");
      },
      async waitForAppliedBackendExec() {
        calls.acknowledgements += 1;
        if (fail.ack) throw new Error("ack adapter failed");
        return acknowledge;
      },
      async restore() {
        calls.restores += 1;
      },
    },
  };
}

function argv(phase = "prepare") {
  return [
    "--phase", phase,
    "--host", HOST,
    "--runner-sha", RUNNER_SHA,
    "--compose-file", "compose.yml",
    "--runner-config", "runner.config.json",
    "--runner-unit", "kaoiro-runner.service",
    "--origin-evidence", "origin-evidence.json",
  ];
}

function io() {
  return {
    stdout: { text: "", write(value) { this.text += value; } },
    stderr: { text: "", write(value) { this.text += value; } },
  };
}

test("prepare pins omitted legacy exec once and confirms the applied selection", async () => {
  const { adapters, calls } = makeAdapters();
  const output = io();

  assert.equal(await main(argv(), adapters, output), 0);
  assert.deepEqual(JSON.parse(output.stdout.text), {
    phase: "prepare", status: "prepared", host: HOST, backend: "exec",
  });
  assert.equal(calls.writes, 1);
  assert.equal(calls.acknowledgements, 1);
  assert.equal(calls.restores, 0);
});

test("a positive pending transition blocks the product entry before the config write", async () => {
  const pending = observation({ transition_pending: true });
  const { adapters, calls } = makeAdapters({ hosts: [pending, pending] });
  const output = io();

  const result = await main(argv(), adapters, output);
  assert.match(output.stderr.text, /stopped \(pending-lifecycle\)/);
  assert.equal(calls.origin, 0);
  assert.equal(calls.cursor, 0);
  assert.equal(calls.writes, 0);
  assert.equal(calls.restores, 0);
  assert.equal(result, 1);
});

test("the pre-write lifecycle gate keeps pending work from reaching the write boundary", async () => {
  const { adapters, calls } = makeAdapters({ hosts: [observation(), observation({ transition_pending: true })] });
  const output = io();

  assert.equal(await main(argv(), adapters, output), 1);
  assert.match(output.stderr.text, /stopped \(pending-lifecycle\)/);
  assert.equal(calls.writes, 0);
  assert.equal(calls.restores, 0);
});

test("the pre-write stability gate rejects host and runner changes", async (t) => {
  await t.test("pointer status changes without changing origin evidence", async () => {
    const { adapters, calls } = makeAdapters({ hosts: [observation(), observation({ pointer: "nil" })] });
    const output = io();

    assert.equal(await main(argv(), adapters, output), 1);
    assert.match(output.stderr.text, /stopped \(observation-changed\)/);
    assert.equal(calls.writes, 0);
    assert.equal(calls.restores, 0);
  });

  await t.test("runner receipt changes without changing origin evidence", async () => {
    const before = runnerObservation();
    const changed = runnerObservation({
      appliedReceipt: { ...before.appliedReceipt, timestampUs: before.appliedReceipt.timestampUs + 1 },
    });
    const { adapters, calls } = makeAdapters({ runners: [before, changed] });
    const output = io();

    assert.equal(await main(argv(), adapters, output), 1);
    assert.match(output.stderr.text, /stopped \(observation-changed\)/);
    assert.equal(calls.writes, 0);
    assert.equal(calls.restores, 0);
  });
});

test("an unavailable initial or immediate pre-write server observation makes no changes", async (t) => {
  await t.test("initial", async () => {
    const empty = emptyObservation();
    const { adapters, calls } = makeAdapters({
      hosts: [empty, empty],
      evidence: emptyOriginEvidence(),
      fail: { hostAt: 1 },
    });
    const result = await main(argv(), adapters, io());
    assert.equal(calls.writes, 0);
    assert.equal(calls.restores, 0);
    assert.equal(result, 1);
  });

  await t.test("pre-write recheck", async () => {
    const empty = emptyObservation();
    const { adapters, calls } = makeAdapters({
      hosts: [empty, empty],
      evidence: emptyOriginEvidence(),
      fail: { hostAt: 2 },
    });
    const result = await main(argv(), adapters, io());
    assert.equal(calls.writes, 0);
    assert.equal(calls.restores, 0);
    assert.equal(result, 1);
  });
});

test("unknown engine string stops with observation-invalid before evidence", async () => {
  const { adapters, calls } = makeAdapters({ hosts: [observation({ engine: "unrecognized-engine" })] });
  const output = io();

  assert.equal(await main(argv(), adapters, output), 1);
  assert.match(output.stderr.text, /stopped \(observation-invalid\)/);
  assert.equal(calls.origin, 0);
  assert.equal(calls.cursor, 0);
  assert.equal(calls.writes, 0);
  assert.equal(calls.restores, 0);
});

test("complete origin evidence resolves null engine rows without guessing", async (t) => {
  for (const [name, row] of [
    ["directory-only", { directory: true, pointer: "missing", live: false, connected: false }],
    ["pointerless-live", { directory: true, pointer: "missing", live: true, connected: true }],
  ]) {
    await t.test(`${name} with exec origin`, async () => {
      const nullEngine = observation({ ...row, engine: null });
      const { adapters, calls } = makeAdapters({ hosts: [nullEngine, nullEngine] });
      const output = io();

      assert.equal(await main(argv(), adapters, output), 0);
      assert.equal(JSON.parse(output.stdout.text).status, "prepared");
      assert.equal(calls.origin, 2);
      assert.equal(calls.writes, 1);
      assert.equal(calls.restores, 0);
    });
  }

  await t.test("none origin is accepted without a non-nil pointer", async () => {
    const nullEngine = observation({ engine: null, pointer: "missing", live: false, connected: false });
    const evidence = originEvidence();
    evidence.agents[0].origin = "none";
    const { adapters, calls } = makeAdapters({ hosts: [nullEngine, nullEngine], evidence });
    const output = io();

    assert.equal(await main(argv(), adapters, output), 0);
    assert.equal(JSON.parse(output.stdout.text).status, "prepared");
    assert.equal(calls.writes, 1);
  });

  await t.test("not-codex origin is accepted with complete evidence", async () => {
    const nullEngine = observation({ engine: null, pointer: "missing", live: false, connected: false });
    const evidence = originEvidence();
    evidence.agents[0].origin = "not-codex";
    const { adapters, calls } = makeAdapters({ hosts: [nullEngine, nullEngine], evidence });
    const output = io();

    assert.equal(await main(argv(), adapters, output), 0);
    assert.equal(JSON.parse(output.stdout.text).status, "prepared");
    assert.equal(calls.writes, 1);
  });

  await t.test("attested unknown origin is accepted for the exact null row", async () => {
    const nullEngine = observation({ engine: null, pointer: "missing", live: false, connected: false });
    const evidence = originEvidence();
    evidence.origin_source = "operator-attestation";
    evidence.agents[0].origin = "unknown";
    evidence.attestation = {
      accepted: true,
      attested_at: "2026-10-27T00:00:00Z",
      scope: "the measured test host",
      release_range: "the tested release",
      statement: "the exact row routes through exec",
      unknown_origin_rows: [AGENT_ID],
      contrary_rows: [],
      unresolved_rows: [],
    };
    const { adapters, calls } = makeAdapters({ hosts: [nullEngine, nullEngine], evidence });
    const output = io();

    assert.equal(await main(argv(), adapters, output), 0);
    assert.equal(JSON.parse(output.stdout.text).status, "prepared");
    assert.equal(calls.writes, 1);
  });
});

test("null engine evidence refusals use one exact stop code and do not write", async (t) => {
  const nullEngine = observation({ engine: null, pointer: "missing", live: false, connected: false });
  const cases = [
    ["null engine without evidence stops with origin-evidence-unavailable", { fail: { origin: true } }, "origin-evidence-unavailable"],
    ["null engine with incomplete roster stops with origin-evidence-incomplete", { evidence: { ...originEvidence(), agents: [] } }, "origin-evidence-incomplete"],
    ["null engine with mismatched evidence identity stops with origin-evidence-invalid", { evidence: { ...originEvidence(), runner_sha: "f".repeat(40) } }, "origin-evidence-invalid"],
    ["none origin conflicts with a non-nil pointer", { hosts: [observation({ engine: null, pointer: "non_nil" })], evidence: { ...originEvidence(), agents: [{ id: AGENT_ID, origin: "none", complete: true }] } }, "origin-evidence-conflict"],
    ["null engine with app-server origin stops with origin-evidence-conflict", { evidence: { ...originEvidence(), agents: [{ id: AGENT_ID, origin: "app-server", complete: true }] } }, "origin-evidence-conflict"],
    ["null engine with unbound attested unknown origin stops with origin-unknown", { evidence: {
      ...originEvidence(), origin_source: "operator-attestation",
      agents: [{ id: AGENT_ID, origin: "unknown", complete: true }],
      attestation: {
        accepted: true, attested_at: "2026-10-27T00:00:00Z", scope: "the measured test host",
        release_range: "the tested release", statement: "the exact row routes through exec",
        unknown_origin_rows: [], contrary_rows: [], unresolved_rows: [],
      },
    } }, "origin-unknown"],
    ["null engine with unsupported origin stops with origin-evidence-invalid", { evidence: { ...originEvidence(), agents: [{ id: AGENT_ID, origin: "other", complete: true }] } }, "origin-evidence-invalid"],
    ["null engine with missing origin stops with origin-evidence-invalid", { evidence: { ...originEvidence(), agents: [{ id: AGENT_ID, complete: true }] } }, "origin-evidence-invalid"],
  ];
  for (const [name, options, code] of cases) {
    await t.test(name, async () => {
      const { adapters, calls } = makeAdapters({ hosts: [nullEngine], ...options });
      const output = io();

      assert.equal(await main(argv(), adapters, output), 1);
      assert.match(output.stderr.text, new RegExp(`stopped \\(${code}\\)`));
      assert.equal(calls.cursor, 0);
      assert.equal(calls.writes, 0);
      assert.equal(calls.restores, 0);
    });
  }
});

test("origin-evidence-conflict covers known engine and origin disagreement", async (t) => {
  const cases = [
    ["codex engine conflicts with not-codex origin", observation({ engine: "codex", pointer: "nil" }), "not-codex", false],
    ["codex non-nil pointer conflicts with none origin", observation({ engine: "codex", pointer: "non_nil" }), "none", false],
    ["claude-code engine conflicts with exec origin", observation({ engine: "claude-code", pointer: "missing" }), "exec", false],
    ["claude-code engine conflicts with attested unknown origin", observation({ engine: "claude-code", pointer: "missing" }), "unknown", true],
  ];
  for (const [name, hostRow, origin, attest] of cases) {
    await t.test(name, async () => {
      const evidence = originEvidence();
      evidence.agents[0].origin = origin;
      if (attest) {
        evidence.origin_source = "operator-attestation";
        evidence.attestation = {
          accepted: true,
          attested_at: "2026-10-27T00:00:00Z",
          scope: "the measured test host",
          release_range: "the tested release",
          statement: "the exact row routes through exec",
          unknown_origin_rows: [AGENT_ID],
          contrary_rows: [],
          unresolved_rows: [],
        };
      }
      const { adapters, calls } = makeAdapters({ hosts: [hostRow], evidence });
      const output = io();

      assert.equal(await main(argv(), adapters, output), 1);
      assert.match(output.stderr.text, /stopped \(origin-evidence-conflict\)/);
      assert.equal(calls.cursor, 0);
      assert.equal(calls.writes, 0);
      assert.equal(calls.restores, 0);
    });
  }
});

test("an unavailable runner observation makes no changes", async (t) => {
  await t.test("initial", async () => {
    const empty = emptyObservation();
    const { adapters, calls } = makeAdapters({
      hosts: [empty, empty],
      evidence: emptyOriginEvidence(),
      fail: { runnerAt: 1 },
    });
    const result = await main(argv(), adapters, io());
    assert.equal(calls.writes, 0);
    assert.equal(calls.restores, 0);
    assert.equal(result, 1);
  });

  await t.test("pre-write recheck", async () => {
    const empty = emptyObservation();
    const { adapters, calls } = makeAdapters({
      hosts: [empty, empty],
      evidence: emptyOriginEvidence(),
      fail: { runnerAt: 2 },
    });
    const result = await main(argv(), adapters, io());
    assert.equal(calls.writes, 0);
    assert.equal(calls.restores, 0);
    assert.equal(result, 1);
  });
});

test("a failed applied-selection acknowledgement does not trigger a second mutation or restore", async () => {
  const { adapters, calls } = makeAdapters({ acknowledge: false });

  const result = await main(argv(), adapters, io());
  assert.equal(calls.writes, 1);
  assert.equal(calls.acknowledgements, 1);
  assert.equal(calls.restores, 0);
  assert.equal(calls.runner, 2);
  assert.equal(result, 1);
});

test("post-write applied selection requires a reload receipt", async () => {
  const after = runnerObservation({
    configuredBackend: "exec",
    appliedBackend: "exec",
    appliedReceipt: { backend: "exec", source: "wrapper", timestampUs: 3_000_000 },
    configHash: NEXT_CONFIG_HASH,
    configMtimeMs: 2_000,
  });
  const { adapters, calls } = makeAdapters({ runners: [undefined, undefined, after] });
  const output = io();

  assert.equal(await main(argv(), adapters, output), 1);
  assert.match(output.stderr.text, /stopped \(applied-selection-unverified\)/);
  assert.equal(calls.writes, 1);
  assert.equal(calls.acknowledgements, 1);
  assert.equal(calls.restores, 0);
});

test("unknown origin, changed roster, and malformed phase stop with exact codes", async (t) => {
  await t.test("unknown origin", async () => {
    const evidence = originEvidence();
    evidence.agents[0].origin = "unknown";
    const { adapters, calls } = makeAdapters({ evidence });
    const output = io();
    assert.equal(await main(argv(), adapters, output), 1);
    assert.match(output.stderr.text, /stopped \(origin-unknown\)/);
    assert.equal(calls.writes, 0);
    assert.equal(calls.restores, 0);
  });

  await t.test("changed observed roster", async () => {
    const { adapters, calls } = makeAdapters({ hosts: [observation(), observation({ id: `${HOST}.new-agent` })] });
    const output = io();
    assert.equal(await main(argv(), adapters, output), 1);
    assert.match(output.stderr.text, /stopped \(observation-changed\)/);
    assert.equal(calls.writes, 0);
    assert.equal(calls.restores, 0);
  });

  await t.test("non-U1 phase", async () => {
    const { adapters, calls } = makeAdapters();
    const output = io();
    assert.equal(await main(argv("restore-fresh"), adapters, output), 1);
    assert.match(output.stderr.text, /stopped \(invalid-arguments\)/);
    assert.equal(calls.host, 0);
    assert.equal(calls.writes, 0);
    assert.equal(calls.restores, 0);
  });
});

test("an explicit complete routing attestation can resolve directly unknown origin", async () => {
  const evidence = originEvidence();
  evidence.origin_source = "operator-attestation";
  evidence.agents[0].origin = "unknown";
  evidence.attestation = {
    accepted: true,
    attested_at: "2026-10-27T00:00:00Z",
    scope: "affected host and all relevant saved sessions",
    release_range: "complete applicable runner history",
    statement: "Every relevant route used the legacy exec backend; no imported app-server ID exists.",
    unknown_origin_rows: [AGENT_ID],
    contrary_rows: [],
    unresolved_rows: [],
  };
  const { adapters, calls } = makeAdapters({ evidence });
  const output = io();

  assert.equal(await main(argv(), adapters, output), 0);
  assert.equal(JSON.parse(output.stdout.text).status, "prepared");
  assert.equal(calls.writes, 1);
  assert.equal(calls.restores, 0);
});

test("an already-applied explicit setting is retained without origin probing or writes", async (t) => {
  for (const backend of ["exec", "app-server"]) {
    await t.test(backend, async () => {
      const explicit = runnerObservation({ configuredBackend: backend, appliedBackend: backend });
      const { adapters, calls } = makeAdapters({ runners: [explicit] });
      const output = io();

      assert.equal(await main(argv(), adapters, output), 0);
      assert.equal(JSON.parse(output.stdout.text).status, "already-explicit");
      assert.equal(calls.origin, 0);
      assert.equal(calls.host, 0);
      assert.equal(calls.writes, 0);
      assert.equal(calls.restores, 0);
    });
  }
});

function localFiles(t) {
  const directory = mkdtempSync(join(tmpdir(), "codex-backend-compatibility."));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const configPath = join(directory, "runner.config.json");
  const evidencePath = join(directory, "origin-evidence.json");
  const configBytes = Buffer.from(`{"host_id":"${HOST}"}\n`);
  writeFileSync(configPath, configBytes, { mode: 0o600 });
  const configMtimeMs = statSync(configPath).mtimeMs;
  const configHash = createHash("sha256").update(configBytes).digest("hex");
  const projection = JSON.parse(readFileSync(new URL("./fixtures/codex-backend/server-observation.json", import.meta.url), "utf8"));
  const liveRow = projection.rows.find((row) => row.id === `${HOST}.live`);
  assert.ok(liveRow, "the server golden must contain the live pointerless row");
  const preparationProjection = { ...projection, rows: [liveRow] };
  const agentId = liveRow.id;
  const evidence = {
    schema: 1,
    host: HOST,
    config_sha256: configHash,
    config_mtime_ms: configMtimeMs,
    runner_sha: RUNNER_SHA,
    invocation_id: INVOCATION_ID,
    all_relevant_sessions_covered: true,
    origin_source: "measured",
    agent_ids: [agentId],
    agents: [{ id: agentId, origin: "exec", complete: true }],
  };
  writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
  return { directory, configPath, evidencePath, configBytes, projection: preparationProjection };
}

function localArgv(configPath, evidencePath) {
  const args = argv();
  args[args.indexOf("--runner-config") + 1] = configPath;
  args[args.indexOf("--origin-evidence") + 1] = evidencePath;
  return args;
}

function localCommandBoundary({ configPath, projection, projectionOutput, identityOutput, reloadDiagnostic, wrapperDiagnostic, failObservationAt = 0, failAck = false, runnerSha = RUNNER_SHA, runnerHost = HOST, reloadTimestampOffsetUs = 1_000_000 }) {
  const calls = { systemctl: 0, docker: 0, journalRows: 0, journalRowsArgs: [], runnerIdentity: 0, runnerIdentityArgs: [], cursor: 0, acknowledgement: 0, acknowledgementArgs: [] };
  const startup = `runner: host=${runnerHost} rev=${runnerSha} connecting to wss://example.invalid/runner\n`;
  const reloadLine = reloadDiagnostic ?? "runner: codex backend=exec for subsequent wrappers\n";
  const wrapperLine = wrapperDiagnostic ?? "codex: backend=exec\n";

  return {
    calls,
    runCommand(command, args) {
      if (command === "systemctl") {
        calls.systemctl += 1;
        if (failAck && calls.systemctl === 6) return `${"f".repeat(32)}\n`;
        return `${INVOCATION_ID}\n`;
      }

      if (command === "docker") {
        calls.docker += 1;
        if (calls.docker === failObservationAt) throw new Error("captured RPC failure");
        return projectionOutput ?? `${JSON.stringify(projection)}\n`;
      }

      if (command === "journalctl") {
        if (args.includes("--show-cursor")) {
          calls.cursor += 1;
          return "-- cursor: cursor-before-write\n";
        }
        if (args.some((arg) => arg.startsWith("--after-cursor="))) {
          calls.acknowledgement += 1;
          calls.acknowledgementArgs.push(args);
          return reloadLine;
        }
        if (args.includes("--output=cat")) {
          calls.runnerIdentity += 1;
          calls.runnerIdentityArgs.push(args);
          const fullInvocation = identityOutput ?? startup;
          return args.some((arg) => arg.startsWith("--lines="))
            ? `${fullInvocation.split(/\r?\n/).filter(Boolean).at(-1) ?? ""}\n`
            : fullInvocation;
        }
        if (args.includes("--output=json")) {
          calls.journalRows += 1;
          calls.journalRowsArgs.push(args);
          const config = JSON.parse(readFileSync(configPath, "utf8"));
          const timestampOffset = config.codex?.backend === "exec" ? reloadTimestampOffsetUs : 1_000_000;
          const timestamp = String(Math.floor(statSync(configPath).mtimeMs * 1000) + timestampOffset);
          const message = config.codex?.backend === "exec"
            ? reloadLine.trimEnd()
            : wrapperLine.trimEnd();
          return `${JSON.stringify({ MESSAGE: message, __REALTIME_TIMESTAMP: timestamp, _PID: "4242" })}\n`;
        }
      }

      throw new Error(`unexpected command ${command}`);
    },
  };
}

async function captureRealRunnerReloadDiagnostic() {
  const directory = mkdtempSync(join(tmpdir(), "codex-backend-runner-reload."));
  const configPath = join(directory, "runner.config.json");
  const host = `u1-${randomUUID().replaceAll("-", "")}`;
  const writeConfig = (backend) => writeFileSync(configPath, `${JSON.stringify({
    host_id: host,
    server_url: "ws://fixture/runner",
    cwd_allowlist: [directory],
    capabilities: ["codex"],
    codex: { auth_mode: "chatgpt", backend },
  })}\n`, { mode: 0o600 });
  const output = [];
  const originalWrite = process.stderr.write;
  let reload;
  let runtime;
  const generatedLines = () => output.join("").split(/\r?\n/).filter(Boolean);

  try {
    writeConfig("app-server");
    const [{ runRunnerCli }, { loadRunnerConfig }] = await Promise.all([
      import(new URL("../../runner/dist/runner-cli.js", import.meta.url)),
      import(new URL("../../runner/dist/config.js", import.meta.url)),
    ]);
    process.stderr.write = (chunk, ...rest) => {
      output.push(String(chunk));
      const callback = rest.at(-1);
      if (typeof callback === "function") callback();
      return true;
    };
    runtime = await runRunnerCli({
      makeLauncher: () => () => { throw new Error("no wrapper launch expected"); },
      createRunnerLink: (_url, _id, _options) => ({
        sendSpawnResult() {}, sendSessions() {}, sendResetResult() {}, sendStopAgent() {},
        sendCatalogResult() {}, updateRegister() {}, reconnect() {}, close() {},
      }),
      watchRunnerConfig: (_path, onReload) => {
        reload = onReload;
        return { close() {} };
      },
      installSignalHandlers: false,
    }, [configPath]);

    const before = generatedLines().filter((line) => line === "runner: codex backend=exec for subsequent wrappers");
    assert.deepEqual(before, [], "the reload diagnostic must not exist before the config reload trigger");
    writeConfig("exec");
    reload(loadRunnerConfig(configPath));
    await runtime.waitForReloads();
    const after = generatedLines().filter((line) => line === "runner: codex backend=exec for subsequent wrappers");
    assert.equal(after.length, 1, "the real runner reload must emit one backend diagnostic after the trigger");
    return `${after[0]}\n`;
  } finally {
    runtime?.close();
    process.stderr.write = originalWrite;
    rmSync(directory, { recursive: true, force: true });
  }
}

async function captureRealWrapperBackendDiagnostic(backend = "exec") {
  const directory = mkdtempSync(join(tmpdir(), "codex-backend-wrapper-start."));
  const configPath = join(directory, "wrapper.config.json");
  const originalArgv = process.argv;
  const originalWrite = process.stderr.write;
  const output = [];
  const cliPath = fileURLToPath(new URL("../../wrapper/codex/dist/cli.js", import.meta.url));
  try {
    writeFileSync(configPath, `${JSON.stringify({
      agent_id: "u1-producer.agent",
      persona: { id: "producer", name: "Producer", sprite_set: "producer" },
      display_name: "Producer",
      server_url: "ws://fixture/wrapper",
      codex_backend: backend,
    })}\n`, { mode: 0o600 });
    process.argv = [process.execPath, "wrapper-test-harness", configPath];
    process.stderr.write = (chunk, ...rest) => {
      output.push(String(chunk));
      const callback = rest.at(-1);
      if (typeof callback === "function") callback();
      return true;
    };
    const { runCodexCli } = await import(new URL("../../wrapper/codex/dist/cli.js", import.meta.url));
    await assert.rejects(
      runCodexCli({ createServerLink: () => { throw new Error("intentional test seam stop after startup diagnostic"); } }),
      /intentional test seam stop/,
    );
    const lines = output.join("").split(/\r?\n/).filter(Boolean);
    const backendLines = lines.filter((line) => line.startsWith("codex: backend="));
    assert.deepEqual(backendLines, [`codex: backend=${backend}`]);
    return `${backendLines[0]}\n`;
  } finally {
    process.stderr.write = originalWrite;
    process.argv = originalArgv;
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the default local adapter prepares with product-shaped command responses and real file operations", async (t) => {
  const files = localFiles(t);
  const boundary = localCommandBoundary({ configPath: files.configPath, projection: files.projection });
  const output = io();

  assert.equal(await main(localArgv(files.configPath, files.evidencePath), undefined, output, { runCommand: boundary.runCommand }), 0);
  assert.deepEqual(JSON.parse(output.stdout.text), { phase: "prepare", status: "prepared", host: HOST, backend: "exec" });
  assert.equal(boundary.calls.docker, 2);
  assert.equal(boundary.calls.cursor, 1);
  assert.equal(boundary.calls.acknowledgement, 1);
  assert.equal(boundary.calls.journalRows, 3);
  assert.equal(boundary.calls.runnerIdentity, 4);
  assert.deepEqual(JSON.parse(readFileSync(files.configPath, "utf8")).codex, { backend: "exec" });
  assert.equal(statSync(files.configPath).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(files.directory).sort(), ["origin-evidence.json", "runner.config.json"]);
});

test("real reload diagnostic is consumed by both default readers", async (t) => {
  const reloadDiagnostic = await captureRealRunnerReloadDiagnostic();
  assert.match(reloadDiagnostic, /^runner: codex backend=exec for subsequent wrappers\n$/);
  const files = localFiles(t);
  const boundary = localCommandBoundary({ configPath: files.configPath, projection: files.projection, reloadDiagnostic });
  const output = io();

  assert.equal(await main(localArgv(files.configPath, files.evidencePath), undefined, output, { runCommand: boundary.runCommand }), 0);
  assert.deepEqual(JSON.parse(output.stdout.text), { phase: "prepare", status: "prepared", host: HOST, backend: "exec" });
  assert.equal(boundary.calls.journalRows, 3);
  assert.equal(boundary.calls.acknowledgement, 1);
  assert.ok(boundary.calls.acknowledgementArgs[0].includes("--after-cursor=cursor-before-write"));
  assert.ok(boundary.calls.acknowledgementArgs[0].includes("--output=cat"));
});

test("a reload diagnostic before the saved config mtime is not an applied receipt", async (t) => {
  const reloadDiagnostic = await captureRealRunnerReloadDiagnostic();
  const files = localFiles(t);
  const boundary = localCommandBoundary({ configPath: files.configPath, projection: files.projection, reloadDiagnostic, reloadTimestampOffsetUs: -1 });
  const output = io();

  assert.equal(await main(localArgv(files.configPath, files.evidencePath), undefined, output, { runCommand: boundary.runCommand }), 1);
  assert.match(output.stderr.text, /stopped \(applied-selection-unverified\)/);
  assert.deepEqual(JSON.parse(readFileSync(files.configPath, "utf8")).codex, { backend: "exec" });
  assert.equal(boundary.calls.acknowledgement, 1);
});

test("real wrapper backend diagnostic comes from temporary config and reaches the default reader", async (t) => {
  for (const backend of ["exec", "app-server"]) {
    await t.test(`configured ${backend} is emitted by the wrapper and read`, async (t) => {
      const wrapperDiagnostic = await captureRealWrapperBackendDiagnostic(backend);
      const files = localFiles(t);
      const before = readFileSync(files.configPath);
      const boundary = localCommandBoundary({ configPath: files.configPath, projection: files.projection, wrapperDiagnostic });
      const output = io();
      const result = await main(localArgv(files.configPath, files.evidencePath), undefined, output, { runCommand: boundary.runCommand });

      if (backend === "exec") {
        assert.equal(result, 0);
        assert.deepEqual(JSON.parse(output.stdout.text), { phase: "prepare", status: "prepared", host: HOST, backend: "exec" });
        assert.equal(boundary.calls.journalRows, 3);
      } else {
        assert.equal(result, 1);
        assert.match(output.stderr.text, /stopped \(applied-selection-not-exec\)/);
        assert.deepEqual(readFileSync(files.configPath), before);
        assert.equal(boundary.calls.cursor, 0);
      }
    });
  }
});

test("the default runner observer scans the full invocation and stops when its startup record is missing", async (t) => {
  await t.test("a startup record before later invocation output is retained", async (t) => {
    const files = localFiles(t);
    const startup = `runner: host=${HOST} rev=${RUNNER_SHA} connecting to wss://example.invalid/runner\n`;
    const boundary = localCommandBoundary({
      configPath: files.configPath,
      projection: files.projection,
      identityOutput: `runner: config loaded\n${startup}${"runner: heartbeat\n".repeat(20)}`,
    });
    const output = io();

    assert.equal(await main(localArgv(files.configPath, files.evidencePath), undefined, output, { runCommand: boundary.runCommand }), 0);
    assert.equal(boundary.calls.runnerIdentityArgs.length, 4);
    assert.ok(boundary.calls.runnerIdentityArgs.every((args) =>
      args.includes(`_SYSTEMD_INVOCATION_ID=${INVOCATION_ID}`)
        && !args.some((arg) => arg.startsWith("--lines="))));
    assert.ok(boundary.calls.journalRowsArgs.every((args) => args.includes(`_SYSTEMD_INVOCATION_ID=${INVOCATION_ID}`)));
  });

  await t.test("no matching startup record returns the named stop code before any write", async (t) => {
    const files = localFiles(t);
    const boundary = localCommandBoundary({
      configPath: files.configPath,
      projection: files.projection,
      identityOutput: "runner: config loaded\nrunner: heartbeat\n",
    });
    const before = readFileSync(files.configPath);
    const output = io();

    assert.equal(await main(localArgv(files.configPath, files.evidencePath), undefined, output, { runCommand: boundary.runCommand }), 1);
    assert.match(output.stderr.text, /stopped \(runner-start-record-unavailable\)/);
    assert.deepEqual(readFileSync(files.configPath), before);
    assert.equal(boundary.calls.docker, 0);
    assert.equal(boundary.calls.cursor, 0);
  });

  await t.test("real execFileSync overflow stops with runner-start-record-unavailable", async (t) => {
    const files = localFiles(t);
    const boundary = localCommandBoundary({ configPath: files.configPath, projection: files.projection });
    const before = readFileSync(files.configPath);
    const output = io();
    const originalExecFileSync = childProcess.execFileSync;
    let observedCode;
    const commandMock = t.mock.method(childProcess, "execFileSync", (command, args, options) => {
      if (command === "journalctl" && args.includes("--output=cat")) {
        assert.equal(options.maxBuffer, 8 * 1024 * 1024);
        try {
          return originalExecFileSync(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(9 * 1024 * 1024))"], options);
        } catch (error) {
          observedCode = error.code;
          throw error;
        }
      }
      return boundary.runCommand(command, args);
    });
    // The product imports the named built-in export; intercept only the process boundary.
    syncBuiltinESMExports();
    try {
      assert.equal(await main(localArgv(files.configPath, files.evidencePath), undefined, output), 1);
    } finally {
      commandMock.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(observedCode, "ENOBUFS");
    assert.match(output.stderr.text, /stopped \(runner-start-record-unavailable\)/);
    assert.deepEqual(readFileSync(files.configPath), before);
    assert.equal(boundary.calls.docker, 0);
    assert.equal(boundary.calls.cursor, 0);
  });
});

function assertStartupProvenance(line, host, revision, serverUrl) {
  assert.ok(line === `runner: host=${host} rev=${revision} connecting to ${serverUrl}`,
    "built runner startup line did not match the configured host and checkout revision");
}

test("a copied startup line fails the provenance assertion", () => {
  const serverUrl = "ws://fixture/runner";
  const copiedLine = `runner: host=copied-host rev=${RUNNER_SHA} connecting to ${serverUrl}`;
  assert.throws(() => assertStartupProvenance(copiedLine, "configured-host", RUNNER_SHA, serverUrl),
    { code: "ERR_ASSERTION" });
});

test("the built runner emits its checkout revision on the real startup path", async () => {
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const expectedSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  assert.ok(/^[0-9a-f]{40}$/.test(expectedSha) && expectedSha !== "unknown", "checkout revision must be known");

  const directory = mkdtempSync(join(tmpdir(), "codex-backend-runner-startup."));
  const server = createServer((_request, response) => response.writeHead(404).end());
  const upgradedSockets = new Set();
  let upgradeCount = 0;
  let resolveUpgrade;
  const loopbackAttempt = new Promise((resolve) => { resolveUpgrade = resolve; });
  server.on("upgrade", (_request, socket) => {
    upgradeCount += 1;
    upgradedSockets.add(socket);
    socket.destroy();
    resolveUpgrade();
  });

  let child;
  let childClosed;
  let startupLine;
  let resolveStartup;
  let rejectStartup;
  const startupRecord = new Promise((resolve, reject) => {
    resolveStartup = resolve;
    rejectStartup = reject;
  });
  let partialLine = "";
  let timer;

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string", "loopback endpoint did not bind");

    const host = `u1-${randomUUID().replaceAll("-", "")}`;
    const serverUrl = `ws://127.0.0.1:${address.port}/runner`;
    const configPath = join(directory, "runner.config.json");
    writeFileSync(configPath, `${JSON.stringify({
      host_id: host,
      server_url: serverUrl,
      cwd_allowlist: [directory],
      capabilities: ["codex"],
      codex: { auth_mode: "chatgpt" },
    })}\n`, { mode: 0o600 });
    mkdirSync(join(directory, "codex-home"), { mode: 0o700 });

    const runnerCli = fileURLToPath(new URL("../../runner/dist/cli.js", import.meta.url));
    child = spawn(process.execPath, [runnerCli, configPath], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        CODEX_HOME: join(directory, "codex-home"),
        TMPDIR: directory,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    childClosed = new Promise((resolve) => { child.once("close", resolve); });
    child.once("error", () => rejectStartup(new Error("built runner could not start")));
    child.stderr.on("data", (chunk) => {
      if (startupLine !== undefined) return;
      partialLine += chunk.toString("utf8");
      const lines = partialLine.split(/\r?\n/);
      partialLine = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("runner: host=")) continue;
        startupLine = line;
        resolveStartup(line);
        break;
      }
      if (partialLine.length > 4096) partialLine = partialLine.slice(-4096);
    });
    child.once("close", () => {
      if (startupLine === undefined) rejectStartup(new Error("built runner exited before startup"));
    });

    const [observedLine] = await Promise.race([
      Promise.all([startupRecord, loopbackAttempt]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("runner startup observation timed out")), 8_000); }),
    ]);
    assertStartupProvenance(observedLine, host, expectedSha, serverUrl);
    assert.ok(upgradeCount > 0, "built runner did not contact its test-owned loopback endpoint");
  } finally {
    if (timer) clearTimeout(timer);
    if (child) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      let cleanupTimer;
      await Promise.race([
        childClosed,
        new Promise((resolve) => { cleanupTimer = setTimeout(resolve, 5_000); }),
      ]);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await childClosed;
      }
    }
    for (const socket of upgradedSockets) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the built launcher reports checkout artifact identity", async (t) => {
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const expectedSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  assert.match(expectedSha, /^[0-9a-f]{40}$/);

  const directory = mkdtempSync(join(tmpdir(), "codex-backend-runner-version."));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runnerCli = fileURLToPath(new URL("../../runner/dist/cli.js", import.meta.url));
  const output = execFileSync(process.execPath, [runnerCli, "--version", "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 5_000,
    env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const identity = JSON.parse(output);

  assert.equal(identity.revision, expectedSha);
  assert.equal(typeof identity.dirty, "boolean");
});


test("the server golden projection passes through default local adapters", async (t) => {
  const files = localFiles(t);
  const fixtureBytes = readFileSync(new URL("./fixtures/codex-backend/server-observation.json", import.meta.url), "utf8");
  const projection = JSON.parse(fixtureBytes);
  const boundary = localCommandBoundary({
    configPath: files.configPath,
    projection,
    projectionOutput: fixtureBytes,
  });
  const before = readFileSync(files.configPath);
  const output = io();

  assert.equal(await main(localArgv(files.configPath, files.evidencePath), undefined, output, { runCommand: boundary.runCommand }), 1);
  assert.match(output.stderr.text, /stopped \(pending-lifecycle\)/);
  assert.deepEqual(readFileSync(files.configPath), before);
  assert.equal(boundary.calls.docker, 1);
  assert.equal(boundary.calls.cursor, 0);
});

test("the default RPC reader selects the final observation frame and rejects a missing frame", async (t) => {
  await t.test("an earlier JSON record does not replace the server observation", async () => {
    const files = localFiles(t);
    const fixtureBytes = readFileSync(new URL("./fixtures/codex-backend/server-observation.json", import.meta.url), "utf8");
    const projection = JSON.parse(fixtureBytes);
    const boundary = localCommandBoundary({
      configPath: files.configPath,
      projection,
      projectionOutput: `{"notice":"compose heading"}\n${fixtureBytes}`,
    });
    const output = io();

    assert.equal(await main(localArgv(files.configPath, files.evidencePath), undefined, output, { runCommand: boundary.runCommand }), 1);
    assert.match(output.stderr.text, /stopped \(pending-lifecycle\)/);
    assert.equal(boundary.calls.docker, 1);
    assert.equal(boundary.calls.cursor, 0);
    assert.equal(boundary.calls.acknowledgement, 0);
  });

  await t.test("missing JSON frame stops with server-observation-unavailable", async () => {
    const files = localFiles(t);
    const boundary = localCommandBoundary({
      configPath: files.configPath,
      projection: files.projection,
      projectionOutput: "compose command completed without an observation frame\n",
    });
    const before = readFileSync(files.configPath);
    const output = io();

    assert.equal(await main(localArgv(files.configPath, files.evidencePath), undefined, output, { runCommand: boundary.runCommand }), 1);
    assert.match(output.stderr.text, /stopped \(server-observation-unavailable\)/);
    assert.deepEqual(readFileSync(files.configPath), before);
    assert.equal(boundary.calls.docker, 1);
    assert.equal(boundary.calls.cursor, 0);
  });
});

test("the default local adapter rejects invalid runner identity and resolves null engines by evidence", async (t) => {
  await t.test("runner startup identity differs from the requested full release SHA", async (t) => {
    const files = localFiles(t);
    const boundary = localCommandBoundary({
      configPath: files.configPath,
      projection: files.projection,
      runnerSha: "a".repeat(40),
    });
    const before = readFileSync(files.configPath);
    const output = io();

    assert.equal(await main(localArgv(files.configPath, files.evidencePath), undefined, output, { runCommand: boundary.runCommand }), 1);
    assert.match(output.stderr.text, /stopped \(runner-identity-mismatch\)/);
    assert.deepEqual(readFileSync(files.configPath), before);
    assert.equal(boundary.calls.docker, 0);
    assert.equal(boundary.calls.cursor, 0);
  });

  await t.test("runner startup identity names a different host", async (t) => {
    const files = localFiles(t);
    const boundary = localCommandBoundary({ configPath: files.configPath, projection: files.projection, runnerHost: "another-host" });
    const before = readFileSync(files.configPath);
    const output = io();

    assert.equal(await main(localArgv(files.configPath, files.evidencePath), undefined, output, { runCommand: boundary.runCommand }), 1);
    assert.match(output.stderr.text, /stopped \(runner-observation-unavailable\)/);
    assert.deepEqual(readFileSync(files.configPath), before);
    assert.equal(boundary.calls.docker, 0);
    assert.equal(boundary.calls.cursor, 0);
  });

  await t.test("runner startup identity with dirty suffix stops with runner-identity-dirty", async (t) => {
    const files = localFiles(t);
    const boundary = localCommandBoundary({ configPath: files.configPath, projection: files.projection, runnerSha: `${RUNNER_SHA}-dirty` });
    const before = readFileSync(files.configPath);
    const output = io();

    assert.equal(await main(localArgv(files.configPath, files.evidencePath), undefined, output, { runCommand: boundary.runCommand }), 1);
    assert.match(output.stderr.text, /stopped \(runner-identity-dirty\)/);
    assert.deepEqual(readFileSync(files.configPath), before);
    assert.equal(boundary.calls.docker, 0);
    assert.equal(boundary.calls.cursor, 0);
  });

  await t.test("directory-only inventory with engine=null and complete exec evidence is resolved", async (t) => {
    const files = localFiles(t);
    const projection = structuredClone(files.projection);
    projection.rows[0].engine = null;
    const boundary = localCommandBoundary({ configPath: files.configPath, projection });
    const before = readFileSync(files.configPath);
    const output = io();

    assert.equal(await main(localArgv(files.configPath, files.evidencePath), undefined, output, { runCommand: boundary.runCommand }), 0);
    assert.deepEqual(JSON.parse(output.stdout.text), { phase: "prepare", status: "prepared", host: HOST, backend: "exec" });
    assert.notDeepEqual(readFileSync(files.configPath), before);
    assert.equal(boundary.calls.docker, 2);
    assert.equal(boundary.calls.cursor, 1);
  });
});

test("the default local adapter observes positive pending state and refuses before preparation", async (t) => {
  const files = localFiles(t);
  const projection = structuredClone(files.projection);
  projection.rows[0].transition_pending = true;
  const boundary = localCommandBoundary({ configPath: files.configPath, projection });
  const before = readFileSync(files.configPath);
  const output = io();

  assert.equal(await main(localArgv(files.configPath, files.evidencePath), undefined, output, { runCommand: boundary.runCommand }), 1);
  assert.match(output.stderr.text, /stopped \(pending-lifecycle\)/);
  assert.deepEqual(readFileSync(files.configPath), before);
  assert.equal(boundary.calls.docker, 1);
  assert.equal(boundary.calls.cursor, 0);
});

test("the default local adapter keeps unavailable observations and failed acknowledgements fail-closed", async (t) => {
  await t.test("initial observation unavailable", async (t) => {
    const files = localFiles(t);
    const boundary = localCommandBoundary({ configPath: files.configPath, projection: files.projection, failObservationAt: 1 });
    const before = readFileSync(files.configPath);
    const output = io();

    assert.equal(await main(localArgv(files.configPath, files.evidencePath), undefined, output, { runCommand: boundary.runCommand }), 1);
    assert.match(output.stderr.text, /stopped \(server-observation-unavailable\)/);
    assert.deepEqual(readFileSync(files.configPath), before);
    assert.equal(boundary.calls.docker, 1);
    assert.equal(boundary.calls.cursor, 0);
  });

  await t.test("immediate pre-write observation unavailable", async (t) => {
    const files = localFiles(t);
    const boundary = localCommandBoundary({ configPath: files.configPath, projection: files.projection, failObservationAt: 2 });
    const before = readFileSync(files.configPath);
    const output = io();

    assert.equal(await main(localArgv(files.configPath, files.evidencePath), undefined, output, { runCommand: boundary.runCommand }), 1);
    assert.match(output.stderr.text, /stopped \(pre-write-observation-unavailable\)/);
    assert.deepEqual(readFileSync(files.configPath), before);
    assert.equal(boundary.calls.docker, 2);
    assert.equal(boundary.calls.cursor, 1);
  });

  await t.test("acknowledgement failure leaves the one explicit write and starts no post-write observation", async (t) => {
    const files = localFiles(t);
    const boundary = localCommandBoundary({ configPath: files.configPath, projection: files.projection, failAck: true });
    const output = io();

    assert.equal(await main(localArgv(files.configPath, files.evidencePath), undefined, output, { runCommand: boundary.runCommand }), 1);
    assert.match(output.stderr.text, /stopped \(applied-selection-acknowledgement-missing\)/);
    assert.deepEqual(JSON.parse(readFileSync(files.configPath, "utf8")).codex, { backend: "exec" });
    assert.equal(boundary.calls.docker, 2);
    assert.equal(boundary.calls.journalRows, 2);
    assert.equal(boundary.calls.runnerIdentity, 3);
    assert.equal(boundary.calls.systemctl, 6);
    assert.equal(boundary.calls.acknowledgement, 0);
  });
});

test("Supervisor reader binds two fresh RPC replies to the unchanged local unit", async (t) => {
  const files = localFiles(t);
  const args = { host: HOST, runner_config: files.configPath, runner_unit: "test.service", compose_file: "test-compose.yml" };
  const value = { version: "0", schema: 1, host: HOST, pid: 4242, build_revision: RUNNER_SHA,
    instance_id: "11111111-1111-4111-8111-111111111111", owner: "#PID<0.1.0>",
    request_id: "a".repeat(32), applied_backend: "exec", children: [], pending_spawns: [], pending_switches: [] };
  const identityMismatch = "supervisor-identity-mismatch";
  const unavailable = "supervisor-observation-unavailable";
  const cases = {
    ok: null, pid: identityMismatch, "zero-pid": unavailable, "unit-pid": identityMismatch,
    "missing-pid": identityMismatch, owner: identityMismatch, "invalid-owner": unavailable,
    instance: identityMismatch, "invalid-instance": unavailable, revision: identityMismatch,
    backend: identityMismatch, version: unavailable, schema: unavailable, host: unavailable,
    request: unavailable, flags: unavailable, "malformed-element": unavailable, duplicate: unavailable,
    registry: "runner-registry-changed", timeout: unavailable, "old-server": "undefined RPC",
    config: identityMismatch, invocation: identityMismatch,
  };
  for (const [scenario, expectedError] of Object.entries(cases)) {
    const boundary = localCommandBoundary({ configPath: files.configPath });
    let queries = 0;
    let pidReads = 0;
    const commands = (command, argv) => {
      if (command === "systemctl" && argv.includes("MainPID")) {
        pidReads += 1;
        if (scenario === "missing-pid") return "0\n";
        return scenario === "unit-pid" && pidReads > 1 ? "4243\n" : "4242\n";
      }
      if (command === "systemctl" && scenario === "invocation" && queries === 2) return "f".repeat(32);
      if (command === "docker") {
        queries += 1;
        assert.match(argv.at(-1), /CodexBackendCompatibility\.observe_runner\("legacy-host"\)/);
        if (scenario === "old-server") throw new Error("undefined RPC");
        if (scenario === "registry") return JSON.stringify({ error: "runner_registry_changed" });
        if (scenario === "timeout") return JSON.stringify({ error: "runner_observation_timeout" });
        const result = { ...value };
        if (scenario === "pid") result.pid = 4243;
        if (scenario === "zero-pid") result.pid = 0;
        if (scenario === "invalid-owner") result.owner = "";
        if (scenario === "invalid-instance") result.instance_id = "";
        if (scenario === "version") result.version = "1";
        if (scenario === "schema") result.schema = 2;
        if (scenario === "host") result.host = "another";
        if (scenario === "request") result.request_id = "";
        if (scenario === "flags") result.children = [{ agent_id: AGENT_ID, stopping: "false", restarting: false, reset_pending: false }];
        if (scenario === "owner" && queries === 2) result.owner = "#PID<0.2.0>";
        if (scenario === "instance" && queries === 2) result.instance_id = "22222222-2222-4222-8222-222222222222";
        if (scenario === "revision") result.build_revision = "b".repeat(40);
        if (scenario === "backend") result.applied_backend = "app-server";
        if (scenario === "malformed-element") result.pending_spawns = ["other.a"];
        if (scenario === "duplicate") result.pending_switches = [AGENT_ID, AGENT_ID];
        if (scenario === "config" && queries === 2) writeFileSync(files.configPath, `{"host_id":"${HOST}","extra":1}`);
        return JSON.stringify(result);
      }
      return boundary.runCommand(command, argv);
    };
    if (scenario === "ok") {
      const result = await observeSupervisor(args, commands);
      assert.equal(result.pid, 4242);
      assert.equal(result.invocationId, INVOCATION_ID);
      assert.equal(queries, 2);
    } else {
      await assert.rejects(observeSupervisor(args, commands), { message: expectedError }, scenario);
      if (scenario === "missing-pid") assert.equal(queries, 0);
      if (scenario === "zero-pid") assert.equal(queries, 1);
    }
    writeFileSync(files.configPath, files.configBytes);
  }
});
