import childProcess from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const preload = fileURLToPath(import.meta.url);
const installed = Symbol.for("kaoiro.test.host-systemd-guard");
const hostBins = new Set(["/usr/bin", "/bin", "/usr/local/bin"].flatMap(directory =>
  ["systemd-run", "systemctl", "busctl"].map(name => resolve(directory, name)))
  .filter(existsSync).map(path => realpathSync(path)));
const shells = new Set(["sh", "bash", "dash", "zsh", "ksh"]);
const launchers = new Set(["env", "setsid", "nohup", "timeout", "nice", "sudo", "xargs"]);

function refuse(message) {
  const error = new Error(message);
  error.code = "ERR_TEST_HOST_SYSTEMD";
  throw error;
}

function executable(file, options) {
  if (file.includes("/")) return resolve(options.cwd ?? process.cwd(), file);
  return (options.env?.PATH ?? process.env.PATH ?? "").split(delimiter)
    .map(directory => resolve(directory, file)).find(existsSync) ?? file;
}

function shellCommand(command) {
  // Shell parsing can hide executable boundaries. Refuse literal manager and
  // updater names even in a benign string; argv-based owned fixtures still work.
  if (/(?:systemd-run|systemctl|busctl|kaoiro-runner-update\.sh)/.test(command)) {
    refuse("test refused manager/updater in shell command");
  }
}

function shellEnvironment(options) {
  const env = options.env ?? process.env;
  return { ...options, env: { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --import=${preload}` } };
}

function protect(file, args, options) {
  const path = executable(file, options);
  const actual = existsSync(path) ? realpathSync(path) : path;
  if (hostBins.has(actual) &&
      (basename(actual) === "systemd-run" || args.some(arg => /^--u(?:s(?:e(?:r)?)?)?(?:=|$)/.test(arg)))) {
    refuse(`test refused real user systemd: ${actual}`);
  }
  const runsUpdater = basename(file) === "kaoiro-runner-update.sh" ||
    args.some(arg => typeof arg === "string" && basename(arg) === "kaoiro-runner-update.sh");
  if (runsUpdater) {
    const manager = executable(options.env?.KAOIRO_SYSTEMCTL ?? "systemctl", options);
    if (hostBins.has(existsSync(manager) ? realpathSync(manager) : manager)) {
      refuse("test refused updater shell with real user systemd");
    }
  }
  if ((shells.has(basename(actual)) || launchers.has(basename(actual))) && args.some(arg =>
      /(?:systemd-run|systemctl|busctl)/.test(arg) || /^--u(?:s(?:e(?:r)?)?)?(?:=|$)/.test(arg))) {
    refuse("test refused manager/user option in shell or launcher arguments");
  }
  const shellIndex = shells.has(basename(actual)) ? args.findIndex(arg => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg)) : -1;
  if (shellIndex >= 0) shellCommand(args[shellIndex + 1] ?? "");
  if (options.shell) shellCommand([file, ...args].join(" "));
  // Product child environments strip NODE_OPTIONS; carry the guard as a Node
  // argument, and separately preserve it through shells and fork's execArgv.
  if (actual === realpathSync(process.execPath)) return ["--import", preload, ...args];
  return args;
}

function invocation(params) {
  const [file, second] = params;
  const hasArgs = Array.isArray(second);
  const index = hasArgs || second == null && params.length > 2 ? 2 : 1;
  const hasOptions = params[index] !== null && typeof params[index] === "object";
  return { file, args: hasArgs ? second : [], options: hasOptions ? params[index] : {},
    rest: params.slice(index + (hasOptions ? 1 : 0)) };
}

export function installHostSystemdGuard() {
  if (globalThis[installed]) return;
  globalThis[installed] = true;
  for (const name of ["execFileSync", "spawnSync", "execFile", "spawn", "fork"]) {
    const original = childProcess[name];
    const wrapped = (...params) => {
      const { file, args, rest, options: inputOptions } = invocation(params);
      let options = inputOptions;
      if (name === "fork") {
        protect(options.execPath ?? process.execPath, [file, ...args], options);
        options = { ...options, execArgv: ["--import", preload, ...(options.execArgv ?? process.execArgv)] };
        return original(file, args, options);
      }
      const guardedArgs = protect(file, args, options);
      if (options.shell || shells.has(basename(file))) options = shellEnvironment(options);
      return original(file, guardedArgs, options, ...rest);
    };
    if (original[promisify.custom]) wrapped[promisify.custom] = (...params) => {
      let child;
      const promise = new Promise((resolve, reject) => {
        child = wrapped(...params, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }));
      });
      promise.child = child;
      return promise;
    };
    childProcess[name] = wrapped;
  }
  for (const name of ["execSync", "exec"]) {
    const original = childProcess[name];
    const wrapped = (command, options, callback) => {
      shellCommand(command);
      if (typeof options === "function") { callback = options; options = {}; }
      return original(command, shellEnvironment(options ?? {}), ...(name === "exec" ? [callback] : []));
    };
    if (original[promisify.custom]) wrapped[promisify.custom] = (command, options) => {
      let child;
      const promise = new Promise((resolve, reject) => {
        child = wrapped(command, options, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }));
      });
      promise.child = child;
      return promise;
    };
    childProcess[name] = wrapped;
  }
  syncBuiltinESMExports();
}

installHostSystemdGuard();
