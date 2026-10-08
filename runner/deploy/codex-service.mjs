import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { digest, hasEntry, identity, must } from "./codex-snapshot.mjs";

const KEYS = new Set(["HOME", "XDG_CONFIG_HOME", "KAOIRO_RUNNER_DIR", "KAOIRO_RUNNER_ENV", "CODEX_HOME"]);
function systemctl(service, ...args) {
  try {
    return execFileSync(process.env.KAOIRO_SYSTEMCTL || "systemctl", ["--user", ...args, ...(service ? [service] : [])], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024 }).trimEnd();
  } catch { throw new Error("Cannot read required service-manager state"); }
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
export function staticBinding(root, service, requestedHome) {
  must(process.platform === "linux", "State-aware updates require Linux systemd");
  const home = identity(requestedHome);
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
  const manager = { ...env };
  const configDir = env.KAOIRO_RUNNER_DIR || join(env.XDG_CONFIG_HOME || join(env.HOME, ".config"), "kaoiro");
  const config = env.KAOIRO_RUNNER_ENV || join(configDir, "runner.env");
  must(config.startsWith("/"), "runner.env path must be absolute");
  let sourceHash = null, configIdentity = null;
  if (hasEntry(config)) {
    must(realpathSync(config) === resolve(config), "runner.env symlinks are unsupported for state updates");
    const st = lstatSync(config);
    must(st.isFile() && st.uid === process.getuid() && !(st.mode & 0o077), "runner.env must be a private owned file");
    const text = readFileSync(config, "utf8");
    sourceHash = digest(text);
    configIdentity = { dev: st.dev, ino: st.ino };
    Object.assign(env, parseRunnerEnvironment(text, env));
  }
  const next = env.CODEX_HOME || join(env.HOME, ".codex");
  must(next.startsWith("/") && JSON.stringify(identity(next)) === JSON.stringify(home), "Next launch CODEX_HOME differs from requested home");
  const unit = prop(service, "Id");
  must(/^[A-Za-z0-9_.@-]+\.service$/.test(unit), "Unsupported unit identity");
  const fragment = prop(service, "FragmentPath");
  const dropins = words(prop(service, "DropInPaths"));
  const unitSources = [fragment, ...dropins].map((path) => ({ path, sha256: digest(readFileSync(path)) }));
  return { home, unit, config, sourceHash, configIdentity, manager, effective: env, unitSources, execStart: start.split(" ; ignore_errors=")[0] };
}
export function captureBinding(root, service, home) {
  const binding = staticBinding(root, service, home);
  const pid = Number(prop(service, "MainPID"));
  must(prop(service, "ActiveState") === "active" && Number.isSafeInteger(pid) && pid > 0, "Forward snapshot requires a running source runner");
  const start = pidIdentity(pid);
  const values = readFileSync(`/proc/${pid}/environ`).toString().split("\0").filter((entry) => entry.startsWith("CODEX_HOME="));
  must(values.length <= 1, "Ambiguous running CODEX_HOME");
  const live = values[0]?.slice("CODEX_HOME=".length) || join(binding.effective.HOME, ".codex");
  must(JSON.stringify(identity(live)) === JSON.stringify(binding.home), "Running CODEX_HOME differs from requested home");
  must(Number(prop(service, "MainPID")) === pid && pidIdentity(pid) === start, "Runner changed during binding");
  return { ...binding, live: { pid, start } };
}
export function checkBinding(root, service, binding, restored = false) {
  const current = staticBinding(root, service, binding.home.path);
  const expected = { ...binding };
  delete expected.live;
  if (restored) current.home = { ...current.home, dev: expected.home.dev, ino: expected.home.ino };
  must(JSON.stringify(current) === JSON.stringify(expected), "Service/home configuration changed after binding");
}
export function runnerActivity(service) {
  const state = prop(service, "ActiveState"), pid = prop(service, "MainPID");
  if (state === "active" && /^[1-9][0-9]*$/.test(pid) && Number.isSafeInteger(Number(pid))) return "active";
  must(["inactive", "failed"].includes(state) && pid === "0", "Runner activity is transitional or unknown");
  return "inactive";
}
export function assertOwnedCgroup(service) {
  must(process.platform === "linux" && hasEntry("/sys/fs/cgroup/cgroup.controllers"), "State-aware operation requires unified cgroup v2");
  const activity = runnerActivity(service), group = prop(service, "ControlGroup");
  if (!group) { must(activity === "inactive", "Active runner has no cgroup"); return; }
  must(group.startsWith("/") && group !== "/" && !/[\0\r\n]/.test(group) && group.slice(1).split("/").every((p) => p && p !== "." && p !== ".."), "Invalid runner cgroup path");
  const base = "/sys/fs/cgroup", selected = join(base, group);
  must(realpathSync(base) === base, "Unexpected cgroup root symlink");
  if (!hasEntry(selected)) { must(activity === "inactive", "Active runner cgroup is missing"); return; }
  const members = () => {
    const rows = new Map(), pending = [selected];
    while (pending.length) {
      const path = pending.pop();
      must(lstatSync(path).isDirectory() && realpathSync(path) === path, "Unexpected runner cgroup symlink");
      must(readFileSync(join(path, "cgroup.type"), "utf8").trim() === "domain", "Unsupported threaded runner cgroup");
      for (const text of readFileSync(join(path, "cgroup.procs"), "utf8").split(/\s+/).filter(Boolean)) {
        const pid = Number(text);
        must(/^[1-9][0-9]*$/.test(text) && Number.isSafeInteger(pid), "Invalid runner cgroup PID");
        if (!rows.has(pid)) rows.set(pid, new Set());
        rows.get(pid).add(path.slice(base.length));
      }
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        must(!entry.isSymbolicLink(), "Unexpected runner cgroup symlink");
        if (entry.isDirectory()) pending.push(join(path, entry.name));
      }
    }
    return rows;
  };
  const listed = members(), failures = [];
  const membership = (pid) => {
    const text = readFileSync(`/proc/${pid}/cgroup`, "utf8");
    const lines = text.trim().split("\n");
    must(lines.length === 1 && lines[0].startsWith("0::"), "Unknown process cgroup membership");
    return lines[0].slice(3);
  };
  for (const [pid, groups] of [...listed].sort(([a], [b]) => a - b)) {
    let uid = "unknown", name = "unknown";
    try {
      const before = pidIdentity(pid), member = membership(pid);
      must(typeof before === "string" && /^[0-9]+$/.test(before) && groups.has(member), "Process identity/membership changed");
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      name = (/^Name:\s*(.*)$/m.exec(status)?.[1] || name).replace(/[\x00-\x1f\x7f]/g, "?").slice(0, 128);
      const row = /^Uid:\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s*$/m.exec(status);
      must(row && row.slice(1).every((v) => Number.isSafeInteger(Number(v))), "Unreadable or malformed process UID");
      uid = row.slice(1).join("/");
      // Start time and membership bracket UID observation; a recycled PID cannot authorize stop.
      must(pidIdentity(pid) === before && membership(pid) === member, "Process identity/membership changed");
      must(row.slice(1).every((v) => Number(v) === process.getuid()), "Foreign process UID");
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes(error.code) && !members().has(pid)) continue;
      failures.push(`PID ${pid} UID ${uid} Name ${name}`);
    }
  }
  must(!failures.length, `Runner cgroup contains foreign or unverified processes: ${failures.join("; ")}`);
  must([...members().keys()].every((pid) => listed.has(pid)) && prop(service, "ControlGroup") === group && runnerActivity(service) === activity, "Runner cgroup changed during inspection; retry during maintenance");
}
export function assertStopped(service, home) {
  must(["inactive", "failed"].includes(prop(service, "ActiveState")) && prop(service, "MainPID") === "0", "Runner is not fully stopped");
  must(hasEntry("/sys/fs/cgroup/cgroup.controllers"), "State-aware operation requires unified cgroup v2");
  const group = prop(service, "ControlGroup");
  if (group && hasEntry(join("/sys/fs/cgroup", group, "cgroup.events"))) {
    must(/^populated 0$/m.test(readFileSync(join("/sys/fs/cgroup", group, "cgroup.events"), "utf8")), "Runner descendants remain");
  }
}
