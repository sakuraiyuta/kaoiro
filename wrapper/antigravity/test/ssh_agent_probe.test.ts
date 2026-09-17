import { execFile, execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { SSH_AGENT_PROBE_TIMEOUT_MS, probeSshAgentIdentities } from "../src/ssh_agent_probe.js";

type ExecFileCallback = (error: (Error & { code?: unknown; killed?: boolean }) | null, stdout: string, stderr: string) => void;

function fakeExecFile(outcome: { error: (Error & { code?: unknown; killed?: boolean }) | null; stdout?: string; stderr?: string }) {
  const calls: Array<{ file: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined; timeout: number | undefined }> = [];
  const fake = ((file: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; timeout?: number }, callback: ExecFileCallback) => {
    calls.push({ file, args, env: options.env, timeout: options.timeout });
    queueMicrotask(() => callback(outcome.error, outcome.stdout ?? "", outcome.stderr ?? ""));
    return {} as never;
  }) as unknown as typeof execFile;
  return { fake, calls };
}

describe("probeSshAgentIdentities (issue #350)", () => {
  it("classifies only the measured empty-agent shape: exit 1 plus the fixed sentence", async () => {
    const { fake, calls } = fakeExecFile({
      error: Object.assign(new Error("Command failed"), { code: 1 }),
      stdout: "The agent has no identities.\n",
    });
    await expect(probeSshAgentIdentities({ env: { SSH_AUTH_SOCK: "/run/agent.sock", LANG: "ja_JP.UTF-8" }, execFile: fake }))
      .resolves.toBe("no_identities");
    expect(calls).toEqual([{
      file: "ssh-add", args: ["-l"], timeout: SSH_AGENT_PROBE_TIMEOUT_MS,
      env: expect.objectContaining({ SSH_AUTH_SOCK: "/run/agent.sock", LC_ALL: "C" }),
    }]);
  });

  it.each([
    ["exit 0 with identities", { error: null, stdout: "256 SHA256:abc key (ED25519)\n" }],
    ["exit 2 dead socket", { error: Object.assign(new Error("failed"), { code: 2 }), stderr: "Error connecting to agent: No such file or directory\n" }],
    ["exit 1 without the sentence", { error: Object.assign(new Error("failed"), { code: 1 }), stderr: "something else\n" }],
    ["timeout", { error: Object.assign(new Error("killed"), { code: null, killed: true }), stdout: "The agent has no identities.\n" }],
    ["ssh-add missing", { error: Object.assign(new Error("spawn ssh-add ENOENT"), { code: "ENOENT" }) }],
  ])("stays unknown on %s", async (_label, outcome) => {
    const { fake } = fakeExecFile(outcome);
    await expect(probeSshAgentIdentities({ env: { SSH_AUTH_SOCK: "/run/agent.sock" }, execFile: fake })).resolves.toBe("unknown");
  });

  it("does not run ssh-add without SSH_AUTH_SOCK", async () => {
    const { fake, calls } = fakeExecFile({ error: null });
    await expect(probeSshAgentIdentities({ env: { HOME: "/home/x" }, execFile: fake })).resolves.toBe("unknown");
    await expect(probeSshAgentIdentities({ env: { SSH_AUTH_SOCK: "" }, execFile: fake })).resolves.toBe("unknown");
    expect(calls).toEqual([]);
  });

  it("stays unknown when execFile itself throws", async () => {
    const throwing = (() => { throw new Error("synchronous spawn failure"); }) as unknown as typeof execFile;
    await expect(probeSshAgentIdentities({ env: { SSH_AUTH_SOCK: "/run/agent.sock" }, execFile: throwing })).resolves.toBe("unknown");
  });

  const sshAgentAvailable = (() => {
    try {
      execFileSync("ssh-agent", ["-h"], { stdio: "ignore" });
      return true;
    } catch (error) {
      // `ssh-agent -h` exits 1 after printing usage; only a missing binary matters.
      return (error as { code?: unknown }).code !== "ENOENT";
    }
  })();

  it.skipIf(!sshAgentAvailable)("reports a real empty ssh-agent through the default execFile", async () => {
    const output = execFileSync("ssh-agent", ["-s"], { encoding: "utf8" });
    const socket = /SSH_AUTH_SOCK=([^;]+);/.exec(output)?.[1];
    const pid = /SSH_AGENT_PID=([0-9]+);/.exec(output)?.[1];
    if (socket === undefined || pid === undefined) throw new Error(`unexpected ssh-agent output: ${output}`);
    try {
      await expect(probeSshAgentIdentities({ env: { ...process.env, SSH_AUTH_SOCK: socket } })).resolves.toBe("no_identities");
    } finally {
      process.kill(Number(pid), "SIGTERM");
    }
  });
});
