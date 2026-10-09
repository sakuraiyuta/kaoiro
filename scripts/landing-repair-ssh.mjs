import { spawnSync } from "node:child_process";
import { actorLogin, digest, shellQuote } from "./landing-backlog.mjs";

const FIXED_OPTIONS = ["-oBatchMode=yes", "-oStrictHostKeyChecking=yes", "-oUpdateHostKeys=no",
  "-oConnectTimeout=10", "-oConnectionAttempts=1", "-oPermitLocalCommand=no", "-oLogLevel=QUIET"];
const must = (condition, message) => { if (!condition) throw new Error(message); };
const nativeSsh = (args, env) => spawnSync("/usr/bin/ssh", args, {
  env, encoding: "utf8", timeout: 15_000, maxBuffer: 4096,
  stdio: ["ignore", "ignore", "pipe"],
});

export function sshGreetingActor(result, expectedActor) {
  must(result.status === 1 && !result.error && !result.signal &&
    typeof result.stderr === "string" && Buffer.byteLength(result.stderr) <= 4096,
  "SSH authentication status/output refused");
  const line = result.stderr.replace(/\r?\n$/, "");
  const match = /^Hi ([A-Za-z0-9-]{1,39})! You've successfully authenticated, but GitHub does not provide shell access\.$/.exec(line);
  must(match && actorLogin(match[1]), "SSH authentication greeting refused");
  must(match[1] === expectedActor, "SSH and GitHub operator actors differ");
  return match[1];
}

export function operatorSshSnapshot(expectedActor, { env = process.env, readConfig, probe = nativeSsh } = {}) {
  const frozenEnv = Object.freeze({ ...env });
  const config = readConfig ? readConfig() : spawnSync("/usr/bin/ssh", ["-G", ...FIXED_OPTIONS, "git@github.com"], {
    env: frozenEnv, encoding: "utf8", timeout: 15_000, maxBuffer: 65_536,
    stdio: ["ignore", "pipe", "ignore"],
  });
  must(config.status === 0 && !config.error && !config.signal && typeof config.stdout === "string" &&
    Buffer.byteLength(config.stdout) <= 65_536, "SSH configuration unavailable");
  const values = new Map();
  for (const line of config.stdout.trimEnd().split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0) {
      const key = line.slice(0, space), value = line.slice(space + 1);
      values.set(key, [...(values.get(key) ?? []), value]);
    }
  }
  const one = key => values.get(key)?.length === 1 ? values.get(key)[0] : null;
  must(one("hostname") === "github.com" && one("user") === "git" && one("port") === "22" &&
    [undefined, "none"].includes(one("proxycommand") ?? undefined) &&
    [undefined, "none"].includes(one("proxyjump") ?? undefined), "SSH fixed GitHub destination required");
  const args = ["-F", "/dev/null", ...FIXED_OPTIONS, "-oProxyCommand=none", "-oProxyJump=none", "-oHostname=github.com", "-oUser=git", "-p22"];
  for (const key of ["identityfile", "identityagent", "identitiesonly", "certificatefile", "pkcs11provider", "securitykeyprovider",
    "preferredauthentications", "pubkeyauthentication", "userknownhostsfile", "globalknownhostsfile", "hostkeyalias"]) {
    for (const value of values.get(key) ?? []) {
      must(Buffer.byteLength(value) <= 4096 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value), "SSH selection setting refused");
      args.push(`-o${key}=${value}`);
    }
  }
  const frozenArgs = Object.freeze(args);
  sshGreetingActor(probe(["-T", ...frozenArgs, "git@github.com"], frozenEnv), expectedActor);
  const command = ["/usr/bin/ssh", ...frozenArgs].map(shellQuote).join(" ");
  const gitEnv = { ...frozenEnv, GIT_SSH_COMMAND: command, GIT_SSH_VARIANT: "ssh", GIT_TERMINAL_PROMPT: "0" };
  // HTTP credentials must not survive into the SSH-only repair transport.
  for (const key of Object.keys(gitEnv)) if (key.startsWith("GIT_CONFIG")) delete gitEnv[key];
  Object.assign(gitEnv, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_ALLOW_PROTOCOL: "ssh" });
  return Object.freeze({ gitEnv: Object.freeze(gitEnv), configurationSha256: digest(JSON.stringify(frozenArgs)) });
}
