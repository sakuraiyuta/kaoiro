import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { digest, hasEntry, identity, inside, must } from "./codex-snapshot.mjs";

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
export function assertStopped(service, home) {
  must(["inactive", "failed"].includes(prop(service, "ActiveState")) && prop(service, "MainPID") === "0", "Runner is not fully stopped");
  const group = prop(service, "ControlGroup");
  if (group && hasEntry(join("/sys/fs/cgroup", group, "cgroup.events"))) {
    must(/^populated 0$/m.test(readFileSync(join("/sys/fs/cgroup", group, "cgroup.events"), "utf8")), "Runner descendants remain");
  }
  const inodes = new Set();
  const collect = (path) => {
    const st = lstatSync(path);
    inodes.add(`${st.dev}:${st.ino}`);
    if (st.isDirectory()) for (const name of readdirSync(path)) collect(join(path, name));
  };
  collect(home);
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    const proc = `/proc/${name}`;
    let start;
    try {
      if (lstatSync(proc).uid !== process.getuid()) continue;
      start = pidIdentity(name);
      const row = readFileSync(join(proc, "stat"), "utf8");
      const fields = row.slice(row.lastIndexOf(")") + 2).split(" ");
      // An unreaped, exited child has released its descriptors; /proc/fd can
      // already deny access while its parent's event loop has not reaped it.
      if (fields[0] === "Z" && fields[19] === start) continue;
      const paths = [join(proc, "cwd"), ...readdirSync(join(proc, "fd")).map((fd) => join(proc, "fd", fd))];
      for (const path of paths) {
        let target;
        try { target = readlinkSync(path).replace(/ \(deleted\)$/, ""); }
        catch (error) { if (error.code === "ENOENT" && path.includes("/fd/")) continue; throw error; }
        let st;
        try { st = statSync(path); }
        catch (error) { if (error.code === "ENOENT" && path.includes("/fd/")) continue; throw error; }
        must(!inside(home, target) && !inodes.has(`${st.dev}:${st.ino}`), `Codex home is held by another process (${name})`);
      }
    } catch (error) {
      if (!hasEntry(proc)) continue;
      if (start && pidIdentity(name) !== start) continue;
      throw error;
    }
  }
}
