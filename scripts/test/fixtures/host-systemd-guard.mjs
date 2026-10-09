import childProcess from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const preload = fileURLToPath(import.meta.url);
const installed = Symbol.for("kaoiro.test.host-systemd-guard");
const hostBins = new Set(["/usr/bin", "/bin", "/usr/local/bin"].flatMap(directory =>
  ["systemd-run", "systemctl", "busctl"].map(name => resolve(directory, name)))
  .filter(existsSync).map(path => realpathSync(path)));

function executable(file, options) {
  if (file.includes("/")) return resolve(options.cwd ?? process.cwd(), file);
  return (options.env?.PATH ?? process.env.PATH ?? "").split(delimiter)
    .map(directory => resolve(directory, file)).find(existsSync) ?? file;
}

function protect(file, args, options) {
  const path = executable(file, options);
  const actual = existsSync(path) ? realpathSync(path) : path;
  if (hostBins.has(actual) &&
      (basename(actual) === "systemd-run" || args.includes("--user"))) {
    const error = new Error(`test refused real user systemd: ${actual}`);
    error.code = "ERR_TEST_HOST_SYSTEMD";
    throw error;
  }
  // Product child environments deliberately strip NODE_OPTIONS; carry the test
  // guard as a Node argument so subprocesses cannot lose it at that boundary.
  if (actual === realpathSync(process.execPath)) return ["--import", preload, ...args];
  return args;
}

export function installHostSystemdGuard() {
  if (globalThis[installed]) return;
  globalThis[installed] = true;
  for (const name of ["execFileSync", "spawnSync", "execFile", "spawn"]) {
    const original = childProcess[name];
    childProcess[name] = (file, args = [], options = {}, ...rest) => {
      return original(file, protect(file, args, options), options, ...rest);
    };
  }
  syncBuiltinESMExports();
}

installHostSystemdGuard();
