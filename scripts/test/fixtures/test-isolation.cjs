// Test-only isolation contract (issue 577, docs/contributing/test-isolation.md).
// A root test process neutralises inherited host pointers and credentials
// once; every spawn re-applies them after product code has built the child
// environment and hands the guard on to Node children with --require. This file
// is CommonJS because a --require preload must load without the ES module
// loader: --import breaks Node scripts named like fake-docker.sh, and
// require(esm) fails under asynchronous loader hooks such as tsx.
"use strict";
const childProcess = require("node:child_process");
const dgram = require("node:dgram");
const dns = require("node:dns");
const { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, statSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const net = require("node:net");
const { homedir, tmpdir } = require("node:os");
const { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } = require("node:path");
const { fileURLToPath } = require("node:url");
const { promisify } = require("node:util");
const workerThreads = require("node:worker_threads");
const PERMITS = require("./test-isolation-permits.cjs");

const STATE = Symbol.for("kaoiro.test.isolation");
const CHILD = "KAOIRO_TEST_ISOLATION_CHILD";
const ROOTS = "KAOIRO_TEST_ISOLATION_ROOTS";
const PERMIT = "KAOIRO_TEST_ISOLATION_PERMIT";
const FOREIGN = "KAOIRO_TEST_ISOLATION_FOREIGN";
const INERT = "KAOIRO_TEST_ISOLATION_INERT";
const TOKENS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK"];
const POINTERS = ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "DOCKER_HOST", "DOCKER_CONFIG", "GH_CONFIG_DIR"];
const NEUTRALISED = [...TOKENS, "DOCKER_CONTEXT", ...POINTERS];
// The environment each kind of opt-in gets back from the root's own environment.
const KIND_KEYS = {
  systemd: ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"],
  docker: ["DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT"],
  gh: ["GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"],
  network: ["SSH_AUTH_SOCK"],
};
const TOOLS = { systemctl: "systemd", "systemd-run": "systemd", busctl: "systemd", journalctl: "systemd",
  loginctl: "systemd", gh: "gh", docker: "docker" };
const KINDS = new Set(Object.keys(KIND_KEYS));
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh"]);
const LAUNCHERS = new Set(["env", "setsid", "nohup", "timeout", "nice", "xargs"]);
// Privilege tools reset the environment, so the inert pointers would not hold.
const ESCALATORS = new Set(["sudo", "doas", "pkexec", "run0", "su"]);
// A login or interactive shell rebuilds PATH and the environment from profiles.
const LOGIN_FLAG = /^(?:--login|--interactive|-[a-zA-Z]*[li][a-zA-Z]*)$/;
const USER_FLAG = /^--u(?:s(?:e(?:r)?)?)?(?:=|$)/;
const SYSTEMD_TEXT = /(?:systemd-run|systemctl|busctl|journalctl|loginctl)/;
const SHELL_TOOL = /(?:^|[\s;&|()`'"])([^\s;&|()`'"]*\/)?(gh|docker)(?=$|[\s;&|()`'"])/g;
// What libuv searches when a child environment has no PATH.
const DEFAULT_PATH = "/usr/bin:/bin";
const REPOSITORY = realpathSync(resolve(__dirname, "../../.."));
const PRELOAD_FLAG = `--require="${__filename.replace(/(["\\])/g, "\\$1")}"`;

function refuse(code, message) {
  throw Object.assign(new Error(message), { code });
}

// realpath of the deepest existing ancestor plus the rest, so a missing socket
// or directory inside an owned root is still recognised as owned.
function canonical(path) {
  let head = resolve(path);
  const rest = [];
  while (!existsSync(head) && dirname(head) !== head) {
    rest.unshift(basename(head));
    head = dirname(head);
  }
  return join(existsSync(head) ? realpathSync(head) : head, ...rest);
}

function state() {
  return globalThis[STATE];
}

function ownedPath(path) {
  if (typeof path !== "string" || !isAbsolute(path)) return false;
  const actual = canonical(path);
  const inside = root => actual === root || actual.startsWith(root + sep);
  return !state().foreign.some(inside) && state().roots.some(inside);
}

function pointerPath(key, value) {
  if (typeof value !== "string") return undefined;
  if (key === "DBUS_SESSION_BUS_ADDRESS") return value.match(/^unix:path=([^,;]+)$/)?.[1];
  if (key === "DOCKER_HOST") return value.match(/^unix:\/\/(\/.+)$/)?.[1];
  return value;
}

function inertPointers() {
  const current = state();
  if (current.inert) return current.inert;
  const base = mkdtempSync(join(tmpdir(), "kaoiro-test-isolation-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const directory = name => { const path = join(base, name); mkdirSync(path, { mode: 0o700 }); return path; };
  current.inert = { DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(base, "no-bus")}`,
    XDG_RUNTIME_DIR: directory("runtime"), DOCKER_HOST: `unix://${join(base, "no-docker.sock")}`,
    DOCKER_CONFIG: directory("docker"), GH_CONFIG_DIR: directory("gh") };
  if (!current.roots.some(root => base === root || base.startsWith(root + sep))) current.roots.push(canonical(base));
  return current.inert;
}

function permittedKeys() {
  return new Set([...state().permitted].flatMap(kind => KIND_KEYS[kind]));
}

/** The NODE_OPTIONS value the boundary gives a child whose own NODE_OPTIONS
 *  is empty. */
function isolationNodeOptions() {
  return PRELOAD_FLAG;
}

function appendPreload(options) {
  return typeof options === "string" && options.includes(PRELOAD_FLAG) ? options
    : `${options ?? ""} ${PRELOAD_FLAG}`.trim();
}

/** The environment a child really receives: the caller's (or the inherited
 *  one), with host pointers that are missing or not owned replaced, except
 *  those of a permitted kind. */
function boundaryEnvironment(env) {
  const current = state();
  const keep = permittedKeys();
  const result = { ...(env ?? process.env) };
  if (!keep.has("DOCKER_CONTEXT") && !ownedPath(pointerPath("DOCKER_CONFIG", result.DOCKER_CONFIG))) delete result.DOCKER_CONTEXT;
  for (const key of POINTERS) {
    if (!keep.has(key) && !ownedPath(pointerPath(key, result[key]))) result[key] = inertPointers()[key];
  }
  result.NODE_OPTIONS = appendPreload(result.NODE_OPTIONS);
  result[CHILD] = "1";
  result[ROOTS] = JSON.stringify(current.roots);
  result[FOREIGN] = JSON.stringify(current.foreign);
  result[INERT] = JSON.stringify(inertPointers());
  if (current.permitted.size > 0) result[PERMIT] = [...current.permitted].join(",");
  else delete result[PERMIT];
  return result;
}

function neutralise() {
  for (const key of [...TOKENS, "DOCKER_CONTEXT"]) delete process.env[key];
  Object.assign(process.env, inertPointers());
}

function initialise() {
  const child = process.env[CHILD] === "1";
  const roots = new Set();
  const temp = canonical(tmpdir());
  let home;
  try { home = canonical(homedir()); } catch { home = undefined; }
  // A child given a broad TMPDIR (/, or a directory holding HOME) must not
  // make that whole tree owned.
  if (temp !== sep && !(home && `${home}${sep}`.startsWith(`${temp}${sep}`))) roots.add(temp);
  const permitted = new Set();
  const foreign = new Set();
  const handOff = (key, into) => {
    try {
      for (const root of JSON.parse(process.env[key] ?? "[]")) if (typeof root === "string" && isAbsolute(root)) into.add(root);
    } catch { /* an unreadable hand-off is ignored */ }
  };
  if (child) {
    handOff(ROOTS, roots);
    handOff(FOREIGN, foreign);
    for (const kind of (process.env[PERMIT] ?? "").split(",")) if (KINDS.has(kind)) permitted.add(kind);
  }
  // A child reuses the root's inert pointers instead of creating its own
  // directory under whatever TMPDIR the test gave it.
  let inert;
  if (child) {
    try {
      const handed = JSON.parse(process.env[INERT] ?? "null");
      if (handed && POINTERS.every(key => typeof handed[key] === "string")) inert = Object.fromEntries(POINTERS.map(key => [key, handed[key]]));
    } catch { inert = undefined; }
  }
  const original = child ? {} : Object.fromEntries(NEUTRALISED.filter(key => key in process.env)
    .map(key => [key, process.env[key]]));
  // A TMPDIR inside the real runtime directory must not make the session bus owned.
  for (const path of ["/run/user", original.XDG_RUNTIME_DIR]) if (typeof path === "string" && isAbsolute(path)) foreign.add(canonical(path));
  globalThis[STATE] = { child, roots: [...roots], foreign: [...foreign], permitted, original, inert,
    initialRoots: [...roots], initialForeign: [...foreign] };
  if (!child) neutralise();
}

/** Starts a new test entry in a reused root process (vitest re-evaluates its
 *  setup per test file): permissions, their restored environment and
 *  registered roots do not carry over. */
function beginEntry() {
  const current = state();
  if (current.child) return;
  current.permitted.clear();
  current.roots = [...current.initialRoots];
  current.foreign = [...current.initialForeign];
  neutralise();
}

/** Fixture directories outside the OS temp directory whose programs and
 *  pointers count as owned. */
function registerOwnedRoot(directory) {
  const root = canonical(directory);
  if (!state().roots.includes(root)) state().roots.push(root);
}

/** Test-only: treat a directory as a host location even inside an owned root,
 *  so stand-in host programs can be placed under the temp directory. It only
 *  narrows ownership. */
function registerForeignRoot(directory) {
  const root = canonical(directory);
  if (!state().foreign.includes(root)) state().foreign.push(root);
}

// The repository-relative file that called permitHostAccess, read from V8
// call sites; undefined when it has no file name (eval, stdin), a query or
// fragment, or lies outside the repository.
function callingFile() {
  const prepare = Error.prepareStackTrace, limit = Error.stackTraceLimit;
  let sites;
  try {
    Error.stackTraceLimit = 30;
    Error.prepareStackTrace = (_, callSites) => callSites;
    const holder = {};
    Error.captureStackTrace(holder, permitHostAccess);
    // The stack is formatted when first read, so read it before restoring.
    sites = holder.stack;
  } finally {
    Error.prepareStackTrace = prepare;
    Error.stackTraceLimit = limit;
  }
  const name = Array.isArray(sites) ? sites[0]?.getFileName() : undefined;
  if (typeof name !== "string" || /[?#]/.test(name) || !(isAbsolute(name) || name.startsWith("file:"))) return undefined;
  let file;
  try { file = realpathSync(name.startsWith("file:") ? fileURLToPath(name) : name); } catch { return undefined; }
  const path = relative(REPOSITORY, file);
  return path.startsWith("..") || isAbsolute(path) ? undefined : path.split(sep).join("/");
}

/** Relax the listed kinds for this process and its children, only when the
 *  probe's own opt-in variable is "1": their tools run and the root's own
 *  environment for them comes back. The calling file and its kinds must be
 *  in test-isolation-permits.cjs; that is checked even without the opt-in. */
function permitHostAccess({ kinds, optIn, reason }) {
  if (!Array.isArray(kinds) || kinds.some(kind => !KINDS.has(kind)) || typeof optIn !== "string" ||
      typeof reason !== "string" || reason.length === 0) {
    throw new TypeError("permitHostAccess needs known kinds, an opt-in variable and a reason");
  }
  if (!/^KAOIRO_[A-Z0-9_]+$/.test(optIn) || optIn.startsWith("KAOIRO_TEST_ISOLATION_")) {
    throw new TypeError("permitHostAccess optIn must be a probe's own KAOIRO_ variable");
  }
  const caller = callingFile();
  const allowed = caller === undefined ? undefined : PERMITS[caller];
  if (!allowed) {
    throw new TypeError(`permitHostAccess is not allowed from ${caller ?? "a caller without a repository file"}; ` +
      "add the file to scripts/test/fixtures/test-isolation-permits.cjs");
  }
  const extra = kinds.filter(kind => !allowed.includes(kind));
  if (extra.length > 0) throw new TypeError(`permitHostAccess kinds ${extra.join(", ")} are not allowed for ${caller}`);
  if (process.env[optIn] !== "1") return false;
  const current = state();
  for (const kind of kinds) {
    current.permitted.add(kind);
    if (current.child) continue;
    for (const key of KIND_KEYS[kind]) {
      if (key in current.original) process.env[key] = current.original[key];
      else delete process.env[key];
    }
  }
  return true;
}

function childEnv(options) {
  return options.env ?? process.env;
}

// The child changes to its cwd before execvp, so relative PATH elements, and
// an empty one (the cwd itself), are searched from there.
function program(file, options) {
  const cwd = resolve(options.cwd instanceof URL ? fileURLToPath(options.cwd) : options.cwd ?? ".");
  if (file.includes("/")) return resolve(cwd, file);
  const path = childEnv(options).PATH ?? DEFAULT_PATH;
  return path.split(delimiter).map(directory => resolve(cwd, directory, file)).find(executable);
}

// What execvp would run: a regular file with an execute bit.
function executable(path) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Follows symlinks even when the final target is missing, so a link to a host
// binary is judged by the binary's name and location.
function actualProgram(path) {
  let current = path;
  for (let hops = 0; hops < 40; hops += 1) {
    if (existsSync(current)) return realpathSync(current);
    let link;
    try { link = lstatSync(current).isSymbolicLink() ? readlinkSync(current) : undefined; } catch { link = undefined; }
    if (link === undefined) return canonical(current);
    current = resolve(dirname(current), link);
  }
  return canonical(current);
}

function checkTool(name, path) {
  const kind = TOOLS[name];
  if (!kind || state().permitted.has(kind)) return;
  if (path && ownedPath(path)) return;
  refuse(kind === "systemd" ? "ERR_TEST_HOST_SYSTEMD" : "ERR_TEST_HOST_TOOL",
    `test refused host ${name}: ${path ?? "not found"}`);
}

// A shell or launcher resolves its words again, after it may have changed
// PATH or its cwd, so there gh and docker must be an owned absolute path.
// Even a word that is never run is refused: telling it apart would mean
// parsing the shell, and the text itself may reassign PATH.
function checkIndirectWords(text) {
  for (const [, prefix = "", tool] of text.matchAll(SHELL_TOOL)) {
    if (state().permitted.has(tool)) continue;
    if (!isAbsolute(prefix)) {
      refuse("ERR_TEST_HOST_TOOL",
        `test refused ${tool} through a shell or launcher: name it by an absolute path to an owned program`);
    }
    checkTool(tool, actualProgram(`${prefix}${tool}`));
  }
}

function shellCommand(command) {
  if (/(?:^|[\s;&|()`'"])(?:sudo|doas|pkexec|run0|su)(?=$|[\s;&|()`'"])/.test(command)) {
    refuse("ERR_TEST_ISOLATION", "test refused privilege tool in shell command");
  }
  if (!state().permitted.has("systemd") && /kaoiro-runner-update\.sh/.test(command)) {
    refuse("ERR_TEST_HOST_SYSTEMD", "test refused updater in shell command");
  }
  // Shell parsing can hide executable boundaries, so literal names are
  // refused even in benign strings; argv-based owned fixtures still work.
  if (!state().permitted.has("systemd") && SYSTEMD_TEXT.test(command)) {
    refuse("ERR_TEST_HOST_SYSTEMD", "test refused manager in shell command");
  }
  checkIndirectWords(command);
}

function protect(file, args, options) {
  const resolved = program(file, options);
  const actual = resolved && actualProgram(resolved);
  checkTool(basename(file), actual);
  if (actual) checkTool(basename(actual), actual);
  const name = basename(actual ?? file);
  if (ESCALATORS.has(name) || ((SHELLS.has(name) || LAUNCHERS.has(name)) && args.some(arg => typeof arg === "string" && ESCALATORS.has(basename(arg))))) {
    refuse("ERR_TEST_ISOLATION", `test refused privilege tool: ${name}`);
  }
  const isUpdater = arg => typeof arg === "string" && basename(arg) === "kaoiro-runner-update.sh";
  // Only an executed updater can reach a manager: run directly, by a shell, or
  // through a launcher. A path merely passed to another program is not a launch.
  const runsUpdater = isUpdater(file) || ((SHELLS.has(name) || LAUNCHERS.has(name)) && args.some(isUpdater));
  if (runsUpdater && !state().permitted.has("systemd")) {
    const env = childEnv(options);
    const systemctl = program(env.KAOIRO_SYSTEMCTL ?? "systemctl", options);
    // The updater runs systemd-run only for --detach, so only then is it
    // refused when it resolves to a host systemd tool (an inert stand-in such
    // as /bin/false is fine). Without --detach a host systemd-run on PATH, as
    // on a CI runner, is never reached. The manager must always be owned.
    const detaches = [file, ...args].some(arg => arg === "--detach");
    const systemdRun = detaches && program(env.KAOIRO_SYSTEMD_RUN ?? "systemd-run", options);
    const hostSystemdRun = systemdRun && TOOLS[basename(actualProgram(systemdRun))] === "systemd" &&
      !ownedPath(actualProgram(systemdRun));
    if (!systemctl || !ownedPath(actualProgram(systemctl)) || hostSystemdRun) {
      refuse("ERR_TEST_HOST_SYSTEMD", "test refused updater shell with a host manager");
    }
  }
  if (SHELLS.has(name) || LAUNCHERS.has(name)) {
    for (const arg of args) {
      if (typeof arg !== "string") continue;
      if (!state().permitted.has("systemd") && (SYSTEMD_TEXT.test(arg) || USER_FLAG.test(arg))) {
        refuse("ERR_TEST_HOST_SYSTEMD", "test refused manager or user option in shell or launcher arguments");
      }
      checkIndirectWords(arg);
      // A launcher may run a symlink whose name hides the tool it points to.
      if (isAbsolute(arg)) checkTool(basename(actualProgram(arg)), actualProgram(arg));
    }
  }
  // A launcher's own arguments may start a shell: check that shell's -c too.
  const shellAt = SHELLS.has(name) ? -1 : LAUNCHERS.has(name)
    ? args.findIndex(arg => typeof arg === "string" && SHELLS.has(basename(arg))) : -2;
  const shellArgs = shellAt === -1 ? args : shellAt >= 0 ? args.slice(shellAt + 1) : [];
  const shellIndex = shellArgs.findIndex(arg => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg));
  if (shellIndex >= 0) shellCommand(shellArgs[shellIndex + 1] ?? "");
  if (options.shell) shellCommand([file, ...args].join(" "));
  // Only the shell's own options count, not words passed on to its script.
  const shellOptions = [];
  for (const arg of shellArgs) { if (typeof arg !== "string" || !arg.startsWith("-")) break; shellOptions.push(arg); }
  if (shellAt >= -1 && shellOptions.some(arg => LOGIN_FLAG.test(arg))) {
    refuse("ERR_TEST_ISOLATION", "test refused a login or interactive shell");
  }
}

// Mirrors Node's (file, [args], [options], [callback]) parsing; an explicit
// null or undefined options slot is still the options slot.
function invocation(params) {
  const [file, second] = params;
  const hasArgs = Array.isArray(second);
  const index = hasArgs || second == null && params.length > 2 ? 2 : 1;
  const slot = params[index];
  const hasOptions = index < params.length && (slot == null || typeof slot === "object");
  return { file, args: hasArgs ? second : [], options: hasOptions && slot ? slot : {},
    rest: params.slice(index + (hasOptions ? 1 : 0)) };
}

function promisified(wrapped) {
  return (...params) => {
    let child;
    const promise = new Promise((resolvePromise, reject) => {
      child = wrapped(...params, (error, stdout, stderr) => error
        ? reject(Object.assign(error, { stdout, stderr })) : resolvePromise({ stdout, stderr }));
    });
    promise.child = child;
    return promise;
  };
}

function installChildProcess() {
  for (const name of ["execFileSync", "spawnSync", "execFile", "spawn", "fork"]) {
    const original = childProcess[name];
    const wrapped = (...params) => {
      const { file, args, rest, options } = invocation(params);
      if (name === "fork") {
        protect(options.execPath ?? process.execPath, [file, ...args], options);
      } else {
        protect(file, args, options);
      }
      return original(file, args, { ...options, env: boundaryEnvironment(options.env) }, ...rest);
    };
    if (original[promisify.custom]) wrapped[promisify.custom] = promisified(wrapped);
    childProcess[name] = wrapped;
  }
  for (const name of ["execSync", "exec"]) {
    const original = childProcess[name];
    const wrapped = (command, options, callback) => {
      if (typeof options === "function") { callback = options; options = {}; }
      shellCommand(command);
      const guarded = { ...(options ?? {}), env: boundaryEnvironment(options?.env) };
      return name === "exec" ? original(command, guarded, callback) : original(command, guarded);
    };
    if (original[promisify.custom]) wrapped[promisify.custom] = promisified(wrapped);
    childProcess[name] = wrapped;
  }
}

function loopback(host) {
  if (host === undefined || host === null || host === "" || host === "localhost") return true;
  const bare = String(host).replace(/^\[|\]$/g, "");
  if (net.isIPv4(bare)) return bare.startsWith("127.");
  if (net.isIPv6(bare)) return bare === "::1" || /^::ffff:127\./i.test(bare);
  return false;
}

function networkError(host) {
  return Object.assign(new Error(`test refused network access to ${host}`), { code: "ERR_TEST_NETWORK" });
}

function installNetwork() {
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const [options] = Array.isArray(args[0]) ? args[0] : net._normalizeArgs(args);
    if (!state().permitted.has("network") && !options.path && !loopback(options.host)) {
      const error = networkError(options.host);
      process.nextTick(() => this.destroy(error));
      return this;
    }
    return connect.apply(this, args);
  };
  for (const method of ["send", "connect"]) {
    const original = dgram.Socket.prototype[method];
    dgram.Socket.prototype[method] = function (...args) {
      const host = args.slice(1).find(arg => typeof arg === "string");
      if (!state().permitted.has("network") && !loopback(host)) throw networkError(host);
      return original.apply(this, args);
    };
  }
  const refusesName = name => !state().permitted.has("network") && !loopback(name);
  for (const target of [dns, dns.Resolver.prototype]) {
    for (const key of Object.getOwnPropertyNames(target)) {
      if (!/^(?:lookup|lookupService|resolve|reverse)/.test(key) || typeof target[key] !== "function") continue;
      const original = target[key];
      target[key] = function (name, ...rest) {
        if (refusesName(name)) {
          const callback = rest.findLast(arg => typeof arg === "function");
          if (!callback) throw networkError(name);
          process.nextTick(() => callback(networkError(name)));
          return undefined;
        }
        return original.call(this, name, ...rest);
      };
    }
  }
  for (const target of [dns.promises, dns.promises.Resolver.prototype]) {
    for (const key of Object.getOwnPropertyNames(target)) {
      if (!/^(?:lookup|lookupService|resolve|reverse)/.test(key) || typeof target[key] !== "function") continue;
      const original = target[key];
      target[key] = function (name, ...rest) {
        return refusesName(name) ? Promise.reject(networkError(name)) : original.call(this, name, ...rest);
      };
    }
  }
}

function installWorker() {
  const OriginalWorker = workerThreads.Worker;
  workerThreads.Worker = class Worker extends OriginalWorker {
    constructor(filename, options = {}) {
      if (options.env !== undefined || options.execArgv !== undefined) {
        refuse("ERR_TEST_ISOLATION", "test refused worker environment or startup argument override");
      }
      const inherited = [...process.execArgv];
      if (inherited[0] === "--require" && inherited[1] === __filename) inherited.splice(0, 2);
      // A worker has its own builtins. Install the boundary before its entry,
      // even when the parent imported the guard without a startup preload.
      super(filename, { ...options, env: boundaryEnvironment(), execArgv: ["--require", __filename, ...inherited] });
    }
  };
}

if (!globalThis[STATE]) {
  initialise();
  installChildProcess();
  installNetwork();
  installWorker();
  syncBuiltinESMExports();
}

exports.beginEntry = beginEntry;
exports.boundaryEnvironment = boundaryEnvironment;
exports.isolationNodeOptions = isolationNodeOptions;
exports.permitHostAccess = permitHostAccess;
exports.registerForeignRoot = registerForeignRoot;
exports.registerOwnedRoot = registerOwnedRoot;
