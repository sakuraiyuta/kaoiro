import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const library = process.env.RUNNER_PAIRING_LIB ?? join(repo, "scripts/lib/runner-pairing.sh");
const managedToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const presetToken = "preset-token-0123456789abcdef";

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), "momo-runner-pairing-test-"));
}

function runPairing(functionName, ...args) {
  return spawnSync(
    "bash",
    ["-c", 'source "$1"; "$2" "${@:3}"', "bash", library, functionName, ...args],
    { encoding: "utf8" },
  );
}

function runPairingWithoutMapfile(functionName, ...args) {
  return spawnSync(
    "bash",
    ["-c", 'mapfile() { return 127; }; source "$1"; "$2" "${@:3}"', "bash", library, functionName, ...args],
    { encoding: "utf8" },
  );
}

function writeRunnerEnv(path, content) {
  writeFileSync(path, content, { mode: 0o600 });
}

test("runner pairing creates and validates the launcher runner.env format", () => {
  const directory = temporaryDirectory();
  const envFile = join(directory, "runner.env");

  try {
    const minted = runPairing("pairing_ensure_runner_env", envFile);
    assert.equal(minted.status, 0, minted.stderr);
    assert.match(minted.stdout, /^[0-9a-f]{64}\n$/);
    assert.equal(statSync(envFile).mode & 0o777, 0o600);
    assert.equal(readFileSync(envFile, "utf8"), `KAOIRO_RUNNER_TOKEN=${minted.stdout}`);

    for (const content of [
      `KAOIRO_RUNNER_TOKEN=${managedToken}\n`,
      `KAOIRO_RUNNER_TOKEN='${managedToken}'\r\n`,
      `KAOIRO_RUNNER_TOKEN="${managedToken}"\n`,
    ]) {
      writeRunnerEnv(envFile, content);
      const result = runPairing("pairing_ensure_runner_env", envFile);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `${managedToken}\n`);
    }

    for (const content of [
      `KAOIRO_RUNNER_TOKEN=${managedToken.slice(0, -1)}\n`,
      `KAOIRO_RUNNER_TOKEN=${managedToken}\njunk\n`,
      `KAOIRO_RUNNER_TOKEN='${managedToken}"\n`,
    ]) {
      writeRunnerEnv(envFile, content);
      const result = runPairing("pairing_ensure_runner_env", envFile);
      assert.notEqual(result.status, 0, content);
      assert.match(result.stderr, /not in the launcher format/);
    }

    writeRunnerEnv(envFile, `KAOIRO_RUNNER_TOKEN=${managedToken}\n`);
    const withoutMapfile = runPairingWithoutMapfile("pairing_ensure_runner_env", envFile);
    assert.equal(withoutMapfile.status, 0, withoutMapfile.stderr);
    assert.equal(withoutMapfile.stdout, `${managedToken}\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runner pairing validates tokens and appends without parsing lists", () => {
  assert.equal(runPairing("pairing_check_token", presetToken).status, 0);
  for (const token of ["", "short-token-123", "contains,comma-123456", "has space-token-123", "has\ttab-token-123", `has\rcr-token-123`]) {
    const result = runPairing("pairing_check_token", token);
    assert.notEqual(result.status, 0, JSON.stringify(token));
  }
  assert.equal(runPairing("pairing_append", "", "dev-host", presetToken).stdout, `dev-host:${presetToken}`);
  assert.equal(runPairing("pairing_append", "other:operator", "dev-host", presetToken).stdout, `other:operator,dev-host:${presetToken}`);
});

function writeStub(path, body) {
  writeFileSync(path, `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function launcherFixture(scriptName, runnerList, options = {}) {
  const root = temporaryDirectory();
  const scripts = join(root, "scripts");
  const lib = join(scripts, "lib");
  const server = join(root, "server");
  const runner = join(root, "runner");
  const stubBin = join(root, "bin");
  const log = join(root, "launches.log");

  mkdirSync(lib, { recursive: true });
  mkdirSync(server);
  mkdirSync(join(runner, "dist"), { recursive: true });
  mkdirSync(join(root, "dashboard"));
  mkdirSync(stubBin);
  writeFileSync(log, "");
  copyFileSync(join(repo, "scripts", scriptName), join(scripts, scriptName));
  copyFileSync(library, join(lib, "runner-pairing.sh"));
  if (scriptName === "dogfood.sh") {
    copyFileSync(join(repo, "server/docker-compose.dogfood.yaml"), join(server, "docker-compose.dogfood.yaml"));
    writeFileSync(join(server, "docker-compose.yaml"), "services:\n  kaoiro:\n    image: example\n    env_file:\n      - .env\n");
    writeFileSync(join(server, ".env"), options.envFile ?? "KAOIRO_CLIENT_TOKENS=client:operator\n");
  } else {
    writeFileSync(join(server, ".env"), runnerList ? `KAOIRO_RUNNER_TOKENS=${runnerList}\n` : "");
  }
  writeFileSync(join(runner, "runner.config.json"), '{"host_id":"dev-host"}\n');
  writeRunnerEnv(join(runner, "runner.env"), `KAOIRO_RUNNER_TOKEN=${managedToken}\n`);
  writeFileSync(join(runner, "dist/cli.js"), 'require("fs").appendFileSync(process.env.MOCK_LOG, `runner|${process.env.KAOIRO_RUNNER_TOKEN}\\n`);\n');
  writeStub(join(stubBin, "mix"), 'printf "mix|%s|%s\\n" "${KAOIRO_RUNNER_TOKENS:-}" "${KAOIRO_RUNNER_TOKEN:-}" >> "$MOCK_LOG"');
  writeStub(join(stubBin, "pnpm"), 'printf "pnpm|%s|%s\\n" "${KAOIRO_RUNNER_TOKENS:-}" "${KAOIRO_RUNNER_TOKEN:-}" >> "$MOCK_LOG"');
  writeStub(join(stubBin, "docker"), `
if [[ "$*" == "compose version" ]]; then exit 0; fi
printf 'docker|%s|%s|%s\\n' "$*" "\${KAOIRO_LAUNCHER_RUNNER_TOKENS:-}" "\${KAOIRO_RUNNER_TOKEN:-}" >> "\$MOCK_LOG"
if [[ "$*" == *"config --format json" ]]; then
  if [[ -n "\${REAL_DOCKER:-}" ]]; then
    exec "\$REAL_DOCKER" "\$@"
  fi
  node -e 'process.stdout.write(JSON.stringify({ services: { kaoiro: { environment: { KAOIRO_RUNNER_TOKENS: process.env.MOCK_RUNNER_LIST } } } }))'
  exit 0
fi
`);

  return { root, script: join(scripts, scriptName), stubBin, log };
}

function runLauncher(scriptName, runnerList, options = {}) {
  const fixture = launcherFixture(scriptName, runnerList, options);
  try {
    const env = {
      ...process.env,
      PATH: `${fixture.stubBin}:${process.env.PATH}`,
      MOCK_LOG: fixture.log,
      MOCK_RUNNER_LIST: runnerList,
      KAOIRO_RUNNER_TOKEN: options.preset ?? "",
      REAL_DOCKER: options.realDocker ?? "",
    };
    const result = spawnSync("bash", [fixture.script], { encoding: "utf8", env, timeout: 10_000 });
    return { result, log: readFileSync(fixture.log, "utf8") };
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function composeArgs(command) {
  return `compose -f docker-compose.yaml -f docker-compose.dogfood.yaml ${command}`;
}

function dockerComposeVersion() {
  return spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
}

test("dev launcher appends a matching runner pair before every launch", () => {
  for (const runnerList of ["", "other:operator", "dev-host:stale"]) {
    const { result, log } = runLauncher("dev.sh", runnerList);
    const expected = `${runnerList ? `${runnerList},` : ""}dev-host:${managedToken}`;
    assert.equal(result.status, 0, result.stderr);
    assert.match(log, new RegExp(`mix\\|${expected}\\|${managedToken}`));
    assert.match(log, new RegExp(`pnpm\\|${expected}\\|${managedToken}`));
  }

  const { result, log } = runLauncher("dev.sh", "other:operator", { preset: presetToken });
  assert.equal(result.status, 0, result.stderr);
  assert.match(log, new RegExp(`mix\\|other:operator,dev-host:${presetToken}\\|${presetToken}`));

  const rejected = runLauncher("dev.sh", "", { preset: "one,dev-host:two" });
  assert.notEqual(rejected.result.status, 0);
  assert.equal(rejected.log, "");
});

test("dogfood launcher injects a matching override and rejects comma presets", () => {
  for (const runnerList of ["", "other:operator", "dev-host:stale"]) {
    const { result, log } = runLauncher("dogfood.sh", runnerList);
    const expected = `${runnerList ? `${runnerList},` : ""}dev-host:${managedToken}`;
    assert.equal(result.status, 0, result.stderr);
    assert.match(log, new RegExp(`docker\\|${composeArgs("up -d --build")}\\|${expected}\\|${managedToken}`));
    assert.match(log, new RegExp(`docker\\|${composeArgs("logs -f --tail=0")}\\|${expected}\\|${managedToken}`));
    assert.match(log, new RegExp(`docker\\|${composeArgs("down")}\\|${expected}\\|${managedToken}`));
    assert.match(log, new RegExp(`runner\\|${managedToken}`));
  }

  const { result, log } = runLauncher("dogfood.sh", "other:operator", { preset: presetToken });
  assert.equal(result.status, 0, result.stderr);
  assert.match(log, new RegExp(`docker\\|${composeArgs("up -d --build")}\\|other:operator,dev-host:${presetToken}\\|${presetToken}`));

  const rejected = runLauncher("dogfood.sh", "", { preset: "one,dev-host:two" });
  assert.notEqual(rejected.result.status, 0);
  assert.doesNotMatch(rejected.log, /^(docker|runner)\|/m);
});

test("dogfood preserves a Compose-resolved trailing newline before appending", (t) => {
  const version = dockerComposeVersion();
  if (version.status !== 0) {
    t.skip("docker compose is unavailable; trailing-newline caller probe skipped");
    return;
  }
  const dockerPath = spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8" });
  assert.equal(dockerPath.status, 0, dockerPath.stderr);

  const resolvedList = "other:old,other:\n";
  const { result, log } = runLauncher("dogfood.sh", resolvedList, {
    envFile: "KAOIRO_CLIENT_TOKENS=client:operator\nKAOIRO_RUNNER_TOKENS='other:old,other:\n'\n",
    realDocker: dockerPath.stdout.trim(),
  });
  const expected = `${resolvedList},dev-host:${managedToken}`;
  assert.equal(result.status, 0, result.stderr);
  assert.ok(log.includes(`docker|${composeArgs("up -d --build")}|${expected}|${managedToken}`));
});

test("dogfood override produces the appended Compose environment", (t) => {
  const version = dockerComposeVersion();
  if (version.status !== 0) {
    t.skip("docker compose is unavailable; Compose environment probe skipped");
    return;
  }

  const directory = temporaryDirectory();
  try {
    const base = join(directory, "docker-compose.yaml");
    const override = join(directory, "docker-compose.dogfood.yaml");
    writeFileSync(base, "services:\n  kaoiro:\n    image: alpine\n    environment:\n      KAOIRO_RUNNER_TOKENS: other:operator\n");
    copyFileSync(join(repo, "server/docker-compose.dogfood.yaml"), override);
    const env = { ...process.env, KAOIRO_LAUNCHER_RUNNER_TOKENS: `other:operator,dev-host:${managedToken}` };
    const configured = spawnSync("docker", ["compose", "-f", base, "-f", override, "config", "--format", "json"], { encoding: "utf8", env });
    assert.equal(configured.status, 0, configured.stderr);
    assert.equal(JSON.parse(configured.stdout).services.kaoiro.environment.KAOIRO_RUNNER_TOKENS, env.KAOIRO_LAUNCHER_RUNNER_TOKENS);

    const missing = spawnSync("docker", ["compose", "-f", base, "-f", override, "config", "--format", "json"], { encoding: "utf8", env: process.env });
    assert.notEqual(missing.status, 0, "unset override must fail closed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
