import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PermissionBroker,
  type Envelope,
  type WrapperConfig,
} from "@kaoiro/agent-common";
import { AntigravityHost } from "../src/host.js";

const config: WrapperConfig = {
  agent_id: "a1",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000",
  sandbox: "workspace-write",
  network_access: false,
};

async function waitFor(
  predicate: () => boolean,
  diagnostic: () => unknown,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out: ${JSON.stringify(diagnostic())}`);
}

function holderAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function firstPrintPid(capturePath: string): number | null {
  for (const line of readOrEmpty(capturePath).split("\n")) {
    if (line === "") continue;
    const row = JSON.parse(line) as { kind?: string; pid?: number };
    if (row.kind === "print" && typeof row.pid === "number") return row.pid;
  }
  return null;
}

function holderSource(strayFlag: string, straySent: string): string {
  const flag = JSON.stringify(strayFlag);
  const sent = JSON.stringify(straySent);
  return [
    "import { readFileSync, writeFileSync } from \"node:fs\";",
    "process.stdout.on(\"error\", () => {});",
    "let sentOnce = false;",
    "setInterval(() => {",
    "  if (sentOnce) return;",
    `  try { readFileSync(${flag}); } catch { return; }`,
    "  sentOnce = true;",
    "  const line = JSON.stringify({",
    "    event: \"result\",",
    "    result: { status: \"SUCCESS\", response: \"STRAY\" },",
    "  }) + \"\\n\";",
    "  process.stdout.write(line, () => {",
    `    writeFileSync(${sent}, \"1\");`,
    "  });",
    "}, 10);",
  ].join("\n");
}

function fixtureSource(paths: {
  capture: string;
  holdFlag: string;
  holdPid: string;
  finishFlag: string;
  holder: string;
  strayFlag: string;
  straySent: string;
  hook: string;
}): string {
  const q = JSON.stringify;
  return [
    `#!${process.execPath}`,
    "import { appendFileSync, readFileSync, rmSync, writeFileSync }",
    "  from \"node:fs\";",
    "import { spawn } from \"node:child_process\";",
    "const args = process.argv.slice(2);",
    "const note = (row) => appendFileSync(",
    `  ${q(paths.capture)},`,
    "  JSON.stringify(row) + \"\\n\",",
    ");",
    "if (args[0] === \"models\") {",
    "  process.stdout.write(\"fixture-model\\tFixture Model\\n\");",
    "} else if (args[0] === \"-p\" && args[1] === \"/hooks\") {",
    "  const customization = args[args.lastIndexOf(\"--add-dir\") + 1];",
    `  const command = ${q(paths.hook)};`,
    "  const body = { hooks: [{",
    "    source: customization + \"/.agents/hooks.json\",",
    "    actions: [{",
    "      event: \"PreToolUse\",",
    "      matcher: \"*\", command,",
    "      timeout_seconds: 3600,",
    "    }],",
    "  }] };",
    "  process.stdout.write(JSON.stringify(body));",
    "} else if (args[0] === \"--print\") {",
    "  note({ kind: \"print\", pid: process.pid });",
    "  let input = \"\";",
    "  process.stdin.setEncoding(\"utf8\");",
    "  process.stdin.on(\"data\", (chunk) => {",
    "    input += chunk;",
    "    let newline = input.indexOf(\"\\n\");",
    "    while (newline !== -1) {",
    "      const line = input.slice(0, newline);",
    "      input = input.slice(newline + 1);",
    "      newline = input.indexOf(\"\\n\");",
    "      const prompt = JSON.parse(line).message.content;",
    "      note({ kind: \"line\", pid: process.pid, prompt });",
    "      const payload = JSON.stringify({",
    "        event: \"result\",",
    "        result: { status: \"SUCCESS\", response: prompt },",
    "      }) + \"\\n\";",
    "      let hold = false;",
    "      try {",
    `        readFileSync(${q(paths.holdFlag)}, \"utf8\");`,
    "        hold = true;",
    `        rmSync(${q(paths.holdFlag)});`,
    "      } catch { hold = false; }",
    "      if (hold) {",
    "        process.stdout.write(payload, () => {",
    "          const child = spawn(process.execPath, [",
    `            ${q(paths.holder)},`,
    `            ${q(paths.strayFlag)},`,
    `            ${q(paths.straySent)},`,
    "          ], {",
    "            detached: true,",
    "            stdio: [\"ignore\", \"inherit\", \"inherit\"],",
    "          });",
    `          writeFileSync(${q(paths.holdPid)}, String(child.pid));`,
    "          child.unref();",
    "          note({ kind: \"exit-called\", pid: process.pid });",
    "          process.exit(0);",
    "        });",
    "        return;",
    "      }",
    "      const wait = setInterval(() => {",
    "        try {",
    `          readFileSync(${q(paths.finishFlag)});`,
    "        } catch { return; }",
    "        clearInterval(wait);",
    "        process.stdout.write(payload);",
    "      }, 10);",
    "    }",
    "  });",
    "} else { process.exitCode = 2; }",
  ].join("\n");
}

describe("issue 602 exit before close", () => {
  it("delivers the next input once on a new epoch", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-602-"));
    const executable = join(root, "agy-fixture.mjs");
    const holder = join(root, "holder.mjs");
    const capture = join(root, "procs.jsonl");
    const holdFlag = join(root, "hold-next");
    const holdPid = join(root, "hold.pid");
    const finishFlag = join(root, "finish");
    const strayFlag = join(root, "stray");
    const straySent = join(root, "stray-sent");
    const hookPath = new URL("../dist/hook.js", import.meta.url).pathname;
    const hook = `${process.execPath} ${hookPath}`;
    writeFileSync(holdFlag, "1");
    writeFileSync(holder, holderSource(strayFlag, straySent));
    writeFileSync(executable, fixtureSource({
      capture,
      holdFlag,
      holdPid,
      finishFlag,
      holder,
      strayFlag,
      straySent,
      hook,
    }));
    chmodSync(executable, 0o755);
    const logs: Envelope[] = [];
    const starts: string[] = [];
    const ends: Array<{ turnToken?: string; error?: { detail?: string } }> = [];
    const idleExits: string[] = [];
    const host = new AntigravityHost(config, {
      cwd: root,
      appendSystemPrompt: "persona",
      permissionBroker: new PermissionBroker({ config, send: () => {} }),
      onState: () => {},
      onLog: (envelope) => logs.push(envelope),
      onTurnStart: ({ turnToken }) => starts.push(turnToken),
      onTurnEnd: (info) => ends.push(info),
      onEpochEnded: (info) => {
        if (info.reason === "idle_exit") idleExits.push(info.reason);
      },
      agyPath: executable,
      closeGraceMs: 50,
    });
    let holderPid: number | null = null;
    try {
      await host.send("first", undefined, [], "turn-1");
      await waitFor(
        () => {
          const exited = firstPrintPid(capture);
          return logs.some((envelope) => envelope.type === "result"
            && JSON.stringify(envelope.payload).includes("first"))
            && readOrEmpty(capture).includes("exit-called")
            && exited !== null
            && !holderAlive(exited);
        },
        () => ({
          types: logs.map((envelope) => envelope.type),
          capture: readOrEmpty(capture),
        }),
        15_000,
      );
      holderPid = Number(readFileSync(holdPid, "utf8"));
      expect(holderAlive(holderPid)).toBe(true);
      void host.send("second", undefined, [], "turn-2");
      await waitFor(
        () => starts.includes("turn-2"),
        () => ({ starts, ends, idleExits }),
        5_000,
      );
      expect(holderAlive(holderPid)).toBe(true);
      writeFileSync(strayFlag, "1");
      await waitFor(
        () => readOrEmpty(straySent) === "1",
        () => ({ starts, ends }),
        5_000,
      );
      expect(ends.some((end) => end.turnToken === "turn-2")).toBe(false);
      writeFileSync(finishFlag, "1");
      await waitFor(
        () => ends.some((end) => end.turnToken === "turn-2"),
        () => ({ starts, ends, idleExits }),
        5_000,
      );
      const rows = readFileSync(capture, "utf8").trim().split("\n")
        .map((line) => JSON.parse(line) as {
          kind: string;
          pid: number;
          prompt?: string;
        });
      const printPids = rows.filter((row) => row.kind === "print")
        .map((row) => row.pid);
      const secondLines = rows.filter((row) => row.kind === "line"
        && row.prompt === "second");
      const turn2 = ends.find((end) => end.turnToken === "turn-2");
      expect(turn2?.error).toBeUndefined();
      expect(starts).toEqual(["turn-1", "turn-2"]);
      expect(printPids).toHaveLength(2);
      expect(secondLines).toHaveLength(1);
      expect(secondLines[0]?.pid).not.toBe(printPids[0]);
      expect(idleExits).toEqual(["idle_exit"]);
      expect(logs.some((envelope) => envelope.type === "result"
        && JSON.stringify(envelope.payload).includes("\"STRAY\""))).toBe(false);
      expect(logs.some((envelope) => envelope.type === "result"
        && JSON.stringify(envelope.payload).includes("second"))).toBe(true);
      expect(holderAlive(holderPid)).toBe(true);
    } finally {
      if (holderPid !== null && holderAlive(holderPid)) {
        try {
          process.kill(holderPid, "SIGKILL");
        } catch {
          // The holder can already be gone.
        }
      }
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
