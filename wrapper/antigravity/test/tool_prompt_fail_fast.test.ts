import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionBroker, type Envelope, type WrapperConfig } from "@kaoiro/agent-common";
import { AntigravityHost } from "../src/host.js";

const HOOK = `${process.execPath} ${new URL("../dist/hook.js", import.meta.url).pathname}`;

// Stands in for `git fetch` over ssh: it blocks like a passphrase prompt
// unless every prompt-disabling variable reached it, and only then reports
// either "no identity" (128) or, with the identity flag, success.
const GIT_SHIM = `#!/bin/sh
case "$GIT_SSH_COMMAND" in *BatchMode=yes*) batch=1;; *) batch=0;; esac
if [ "$GIT_TERMINAL_PROMPT" = "0" ] && [ "$SSH_ASKPASS_REQUIRE" = "never" ] && [ "$batch" = 1 ]; then
  if [ -n "$KAOIRO_TEST_SSH_IDENTITY" ]; then exit 0; fi
  echo "git@remote: Permission denied (publickey)." >&2
  exit 128
fi
printf "Enter passphrase for key '/home/x/.ssh/id_rsa': "
sleep 30
exit 1
`;

function writeFixture(root: string): { executable: string } {
  const shim = join(root, "git-shim.sh");
  writeFileSync(shim, GIT_SHIM);
  chmodSync(shim, 0o755);
  const executable = join(root, "agy-fixture.mjs");
  writeFileSync(executable, `#!${process.execPath}
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
if (args[0] === "models") {
  process.stdout.write("fixture-model\\tFixture Model\\n");
} else if (args[0] === "-p" && args[1] === "/hooks") {
  const customization = args[args.lastIndexOf("--add-dir") + 1];
  process.stdout.write(JSON.stringify({ hooks: [{ source: customization + "/.agents/hooks.json", actions: [{ event: "PreToolUse", matcher: "*", command: ${JSON.stringify(HOOK)}, timeout_seconds: 3600 }] }] }));
} else if (args[0] === "--print") {
  line({ event: "init", conversation_id: "cid-shim", init: { tools: ["run_command"] } });
  line({ event: "step_update", step_update: { conversation_id: "cid-shim", step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "git fetch origin" } } } });
  // The tool child inherits this process's environment, as agy's does.
  const child = spawn(${JSON.stringify(shim)}, [], { stdio: ["pipe", "ignore", "ignore"] });
  process.on("SIGTERM", () => { child.kill("SIGKILL"); process.exit(0); });
  child.on("exit", (code) => {
    line({ event: "result", result: { conversation_id: "cid-shim", status: "SUCCESS", response: "shim exit " + code } });
    process.exit(0);
  });
} else {
  process.exitCode = 2;
}
`);
  chmodSync(executable, 0o755);
  return { executable };
}

async function runTurn(root: string, executable: string): Promise<{ response: string; elapsedMs: number }> {
  const cfg: WrapperConfig = {
    agent_id: "a1", persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P",
    server_url: "ws://localhost:4000", antigravity_cli_path: executable,
  };
  const logs: Envelope[] = [];
  const host = new AntigravityHost(cfg, {
    cwd: root, appendSystemPrompt: "persona",
    permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
    onState: () => {}, onLog: (envelope) => logs.push(envelope),
  });
  const started = performance.now();
  try {
    await host.send("fetch");
    const deadline = started + 4_000;
    while (performance.now() < deadline && !logs.some((envelope) => envelope.type === "result")) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const result = logs.find((envelope) => envelope.type === "result");
    if (result === undefined) throw new Error("tool child still blocked on the prompt after 4s");
    return { response: String(result.payload.text), elapsedMs: performance.now() - started };
  } finally {
    host.close();
  }
}

describe("agy tool children fail fast on git/ssh prompts (issue #350)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("exits non-interactively without an identity instead of blocking on the passphrase prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-prompt-"));
    vi.stubEnv("GIT_SSH_COMMAND", "");
    vi.stubEnv("KAOIRO_TEST_SSH_IDENTITY", "");
    try {
      const { executable } = writeFixture(root);
      const turn = await runTurn(root, executable);
      expect(turn.response).toBe("shim exit 128");
      expect(turn.elapsedMs).toBeLessThan(4_000);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("still succeeds in BatchMode when an identity is present (control)", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-prompt-control-"));
    vi.stubEnv("GIT_SSH_COMMAND", "");
    vi.stubEnv("KAOIRO_TEST_SSH_IDENTITY", "1");
    try {
      const { executable } = writeFixture(root);
      expect((await runTurn(root, executable)).response).toBe("shim exit 0");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
