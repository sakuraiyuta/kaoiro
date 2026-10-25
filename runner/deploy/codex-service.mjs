import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { hasEntry, identity, must } from "./codex-snapshot.mjs";

const KEYS = new Set(["HOME", "XDG_CONFIG_HOME", "KAOIRO_RUNNER_DIR", "KAOIRO_RUNNER_ENV", "CODEX_HOME"]);
export function systemctl(service, ...args) {
  try {
    return execFileSync(process.env.KAOIRO_SYSTEMCTL || "systemctl", ["--user", ...args, ...(service ? [service] : [])], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024 }).trimEnd();
  } catch (error) {
    const failure = new Error("Cannot read required service-manager state");
    failure.serviceStatus = error.status;
    throw failure;
  }
}
function prop(service, name) { return systemctl(service, "show", `--property=${name}`, "--value"); }
function words(input) {
  const result = [];
  let value = "", quote = null, active = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "\\") {
      must(i + 1 < input.length && /[ \\"']/.test(input[i + 1]), "Unsupported environment escaping");
      value += input[++i]; active = true;
    } else if (quote) { if (c === quote) quote = null; else value += c; }
    else if (c === '"' || c === "'") { quote = c; active = true; }
    else if (/\s/.test(c)) { if (active) result.push(value); value = ""; active = false; }
    else { value += c; active = true; }
  }
  must(!quote, "Unterminated environment quote");
  if (active) result.push(value);
  return result;
}
function selectedAssignments(assignments, target) {
  for (const assignment of assignments) {
    const equals = assignment.indexOf("=");
    must(equals > 0, "Unsupported unit environment assignment");
    const key = assignment.slice(0, equals);
    if (KEYS.has(key)) {
      const value = assignment.slice(equals + 1);
      must(!/[\n\r\0%$`]/.test(value), "Unsupported relevant unit environment expansion");
      target[key] = value;
    }
  }
}
export function parseRunnerEnvironment(text, initial) {
  const env = { ...initial };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    must(match, "runner.env requires literal assignments only");
    const [, key, rawValue] = match;
    let value = rawValue;
    const single = value.startsWith("'") && value.endsWith("'");
    const double = value.startsWith('"') && value.endsWith('"');
    if (single || double) value = value.slice(1, -1);
    else must(!/[\s'";|&<>()[\]{}\\]/.test(value), "Unsupported runner.env expression");
    must(!/[\n\r\0]/.test(value), "Unsupported runner.env value");
    if (single) must(!value.includes("'"), "Unsupported runner.env quoting");
    else {
      must(!/[`\\";|&<>]/.test(value), "Unsupported runner.env shell syntax");
      value = value.replace(/\$(?:\{(HOME|XDG_CONFIG_HOME)\}|(HOME|XDG_CONFIG_HOME)\b)/g, (_, a, b) => {
        must(typeof env[a || b] === "string", "Undefined runner.env path expansion");
        return env[a || b];
      });
      must(!value.includes("$"), "Unsupported runner.env expansion");
    }
    if (KEYS.has(key)) env[key] = value;
  }
  return env;
}
function pidIdentity(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}
export function homePath(path, allowAbsent = false) {
  if (allowAbsent && !hasEntry(path)) {
    identity(dirname(path));
    must(join(realpathSync(dirname(path)), basename(path)) === path, "Home must use its canonical absolute path");
    return path;
  }
  return identity(path).path;
}
export function staticBinding(root, service, requestedHome, allowAbsent = false) {
  must(process.platform === "linux", "State-aware updates require Linux systemd");
  const home = homePath(requestedHome, allowAbsent);
  must(prop(service, "Transient") === "no", "State-aware updates require an installed persistent unit");
  const start = prop(service, "ExecStart");
  const shim = `${root}/current/deploy/kaoiro-runner-launch.sh`;
  must(start.startsWith(`{ path=${shim} ; argv[]=${shim} ;`) && start.indexOf("{", 1) < 0, "Unsupported runner ExecStart");
  for (const name of ["ExecStartPre", "ExecStartPost", "EnvironmentFiles", "PassEnvironment", "RootDirectory", "RootImage"]) {
    must(prop(service, name) === "", `Unsupported installed unit property: ${name}`);
  }
  must(prop(service, "KillMode") === "control-group", "Installed unit must use KillMode=control-group");
  const env = {};
  for (const line of systemctl(null, "show-environment").split("\n")) {
    const key = line.split("=", 1)[0];
    if (KEYS.has(key)) selectedAssignments(words(line), env);
  }
  selectedAssignments(words(prop(service, "Environment")), env);
  for (const entry of words(prop(service, "UnsetEnvironment"))) {
    const [key, value] = entry.split("=");
    if (KEYS.has(key) && (value === undefined || env[key] === value)) delete env[key];
  }
  must(typeof env.HOME === "string" && env.HOME.startsWith("/"), "Cannot establish launch-user HOME");
  const configDir = env.KAOIRO_RUNNER_DIR || join(env.XDG_CONFIG_HOME || join(env.HOME, ".config"), "kaoiro");
  const config = env.KAOIRO_RUNNER_ENV || join(configDir, "runner.env");
  must(config.startsWith("/"), "runner.env path must be absolute");
  if (hasEntry(config)) {
    must(realpathSync(config) === resolve(config), "runner.env symlinks are unsupported for state updates");
    const st = lstatSync(config);
    must(st.isFile() && st.uid === process.getuid() && !(st.mode & 0o077), "runner.env must be a private owned file");
    const text = readFileSync(config, "utf8");
    Object.assign(env, parseRunnerEnvironment(text, env));
  }
  must(typeof env.CODEX_HOME === "string" && env.CODEX_HOME.length > 0, "State-aware operations require explicit next-start CODEX_HOME");
  must(homePath(env.CODEX_HOME, allowAbsent) === home, "Next launch CODEX_HOME differs from requested home");
  const unit = prop(service, "Id");
  must(/^[A-Za-z0-9_.@-]+\.service$/.test(unit), "Unsupported unit identity");
  return { home, unit };
}
export function captureBinding(root, service, home, allowAbsent = false) {
  const binding = staticBinding(root, service, home, allowAbsent);
  const pid = Number(prop(service, "MainPID"));
  must(prop(service, "ActiveState") === "active" && Number.isSafeInteger(pid) && pid > 0, "Forward snapshot requires a running source runner");
  const start = pidIdentity(pid);
  const env = {};
  for (const key of ["CODEX_HOME", "HOME"]) {
    const values = readFileSync(`/proc/${pid}/environ`).toString().split("\0").filter((entry) => entry.startsWith(`${key}=`));
    must(values.length <= 1, `Ambiguous running ${key}`);
    env[key] = values[0]?.slice(key.length + 1);
  }
  must(env.CODEX_HOME || (typeof env.HOME === "string" && env.HOME.startsWith("/")), "Cannot establish running HOME");
  const live = env.CODEX_HOME || join(env.HOME, ".codex");
  must(homePath(live, allowAbsent) === binding.home, "Running CODEX_HOME differs from requested home");
  must(Number(prop(service, "MainPID")) === pid && pidIdentity(pid) === start, "Runner changed during home read");
  return binding;
}
export function checkBinding(root, service, binding, allowAbsent = false) {
  const current = staticBinding(root, service, binding.home, allowAbsent);
  must(current.unit === binding.unit, "Selected installed service differs from record");
  if (runnerActivity(service) === "active") captureBinding(root, service, binding.home, allowAbsent);
}

export function runnerActivity(service) {
  const state = prop(service, "ActiveState"), pid = prop(service, "MainPID");
  if (state === "active" && /^[1-9][0-9]*$/.test(pid) && Number.isSafeInteger(Number(pid))) return "active";
  must(["inactive", "failed"].includes(state) && pid === "0", "Runner activity is transitional or unknown");
  return "inactive";
}
export function requireCgroupV2() {
  must(process.platform === "linux" && hasEntry("/sys/fs/cgroup/cgroup.controllers"), "State-aware operation requires unified cgroup v2");
}
export function assertStopped(service, home) {
  must(["inactive", "failed"].includes(prop(service, "ActiveState")) && prop(service, "MainPID") === "0", "Runner is not fully stopped");
  requireCgroupV2();
  const group = prop(service, "ControlGroup");
  if (group && hasEntry(join("/sys/fs/cgroup", group, "cgroup.events"))) {
    must(/^populated 0$/m.test(readFileSync(join("/sys/fs/cgroup", group, "cgroup.events"), "utf8")), "Runner descendants remain");
  }
}
