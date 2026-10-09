import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname } from "node:path";

export const CHILD_PATH = dirname(process.execPath) + ":/usr/local/bin:/usr/bin:/bin";
const COMMON = ["HOME", "USER", "LOGNAME", "TMPDIR"];
const SESSION = ["SSH_AUTH_SOCK", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];
const BUILD = ["CI", "SOURCE_DATE_EPOCH", "COREPACK_ENABLE_DOWNLOAD_PROMPT", "PNPM_HOME",
  "KAOIRO_BUILD_IDENTITY_FILE", "KAOIRO_BUILD_IDENTITY_SHA256", "KAOIRO_BUILD_IDENTITY_JSON",
  "KAOIRO_BUILD_REVISION", "KAOIRO_BUILD_DIRTY", "KAOIRO_BUILD_VERSION", "KAOIRO_BUILD_BRANCH", "KAOIRO_BUILD_CHANNEL"];
const RUNNER = ["KAOIRO_NODE", "KAOIRO_RUNNER_DIR", "KAOIRO_RELEASE_RETAINED_UNIT", "INVOCATION_ID"];
const PROFILES = {
  git: SESSION, "ci-git": SESSION, "ssh-git": [...SESSION, "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_ALLOW_PROTOCOL"],
  gh: ["GH_TOKEN", "GITHUB_TOKEN", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"], ssh: ["SSH_AUTH_SOCK"],
  systemd: SESSION, authority: [], runner: [...SESSION, ...RUNNER], build: [...SESSION, ...BUILD],
};
const prepared = new WeakMap();

export function childEnvironmentProfile(environment) {
  const profile = prepared.get(environment);
  if (!profile) throw new Error("unprepared child environment refused");
  return profile;
}

export function childEnvironment(profile, source = process.env) {
  if (!Object.hasOwn(PROFILES, profile)) throw new Error("unknown child environment profile");
  if (prepared.get(source) === profile) return source;
  const result = { PATH: CHILD_PATH, HOME: homedir(), LANG: "C", LC_ALL: "C", TZ: "UTC" };
  for (const key of [...COMMON, ...PROFILES[profile]]) {
    if (typeof source[key] === "string") result[key] = source[key];
  }
  if (["git", "ci-git", "ssh-git"].includes(profile)) {
    Object.assign(result, { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
  }
  if (profile === "ci-git" && source.GH_TOKEN) {
    Object.assign(result, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic " + Buffer.from("x-access-token:" + source.GH_TOKEN).toString("base64") });
  }
  prepared.set(result, profile);
  return Object.freeze(result);
}

export function execChildSync(profile, file, args, options = {}) {
  return execFileSync(file, args, { ...options, env: childEnvironment(profile, options.env) });
}

export function spawnChildSync(profile, file, args, options = {}) {
  return spawnSync(file, args, { ...options, env: childEnvironment(profile, options.env) });
}
