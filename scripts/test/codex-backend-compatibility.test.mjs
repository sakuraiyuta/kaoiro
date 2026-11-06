import "./fixtures/test-isolation.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const RUNNER_SHA = "475e0d5d01d173b46be3bbb7b28564ccf8743abd";

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
