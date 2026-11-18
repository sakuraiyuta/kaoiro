import { permitHostAccess } from "../../../scripts/test/fixtures/test-isolation.mjs";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { nativeRun, type PermissionDecisionRecord } from "./native-support.js";
import * as grokEvents from "../src/grok/events.js";
import { checkForegroundTool } from "./acceptance.js";

permitHostAccess({
  kinds: ["network"],
  optIn: "KAOIRO_LIVE_GROK",
  reason: "live Grok provider run",
});
const live = process.env.KAOIRO_LIVE_GROK === "1";
const config: WrapperConfig = {
  agent_id: "native.lifecycle",
  display_name: "Lifecycle fixture",
  server_url: "ws://127.0.0.1:1/agent",
  sandbox: "workspace-write",
  network_access: true,
  persona: { id: "default", name: "Default", sprite_set: "default" },
};
it.skipIf(!live)(
  "native foreground cancel removes the known tool child",
  async () => {
    const root = mkdtempSync(join(homedir(), ".kaoiro-grok-cancel-"));
    const pidPath = join(root, "owned-pid");
    const calls: Record<string, unknown>[] = [];
    const updateEvents = grokEvents.updateEvents;
    const observe = vi
      .spyOn(grokEvents, "updateEvents")
      .mockImplementation((notification) => {
        if (
          notification.update.sessionUpdate === "tool_call" ||
          notification.update.sessionUpdate === "tool_call_update"
        ) {
          calls.push(
            notification.update as unknown as Record<string, unknown>,
          );
        }
        return updateEvents(notification);
      });
    try {
      await nativeRun(config, root, async (
        host, _link, envelopes, metadata,
      ) => {
        await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
          timeout: 40_000,
        });
        const command =
          `printf '%s' "$$" > ${JSON.stringify(pidPath)}; ` + "exec sleep 120";
        const turn = host.send(
          "Call run_terminal_command exactly once with these arguments: " +
            JSON.stringify({ command, block_until_ms: 120_000 }) +
            ". Keep it in the foreground. Do not use other tools.",
        );
        void turn.catch(() => {});
        await vi.waitFor(() => expect(existsSync(pidPath)).toBe(true), {
          timeout: 120_000,
        });
        const pid = Number(readFileSync(pidPath, "utf8"));
        expect(pid).toBeGreaterThan(1);
        const before = readFileSync(`/proc/${pid}/stat`, "utf8");
        expect(before.slice(0, before.lastIndexOf(")") + 1)).toContain(
          "(sleep)",
        );
        const input = calls.map((c) => c.rawInput).find((raw) =>
          raw && typeof raw === "object" &&
          (raw as Record<string, unknown>).command === command,
        );
        checkForegroundTool(input, command);
        expect(() => checkForegroundTool(
          { ...(input as Record<string, unknown>), block_until_ms: 0 },
          command,
        )).toThrow();
        expect(metadata.some((m) => m.method === "_x.ai/task_backgrounded"))
          .toBe(false);
        expect(host.state).toBe("tool_running");
        await host.interrupt();
        await turn;
        expect(
          envelopes.filter((e) => e.type === "result").at(-1)?.ext?.stop_reason,
        ).toBe("cancelled");
        expect(host.state).toBe("waiting_input");
        await delay(5_000);
        expect(() => process.kill(pid, 0)).toThrow();
        expect(existsSync(`/proc/${pid}/stat`)).toBe(false);
        const startedAt = Date.now();
        host.close();
        await host.closed;
        expect(Date.now() - startedAt).toBeLessThan(4_500);
        if (process.env.KAOIRO_LIVE_GROK_LIFECYCLE_REPORT) {
          writeFileSync(
            process.env.KAOIRO_LIVE_GROK_LIFECYCLE_REPORT,
            JSON.stringify({
              pid,
              grok_pid: host.processId,
              calls,
              before,
              after_cancel: null,
              after_close: null,
              shutdown_ms: Date.now() - startedAt,
            }),
          );
        }
      });
    } finally {
      observe.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  },
  180_000,
);
it.skipIf(!live).each([false, true])(
  "native broker allow=%s controls the target file",
  async allow => {
    const root = mkdtempSync(join(homedir(), ".kaoiro-grok-permission-"));
    const fixtureHome = join(root, "home");
    const cwd = join(root, "work");
    mkdirSync(fixtureHome);
    mkdirSync(cwd);
    const target = join(cwd, "permission-output");
    const env = {
      ...process.env,
      HOME: fixtureHome,
      GROK_HOME: process.env.GROK_HOME ?? join(homedir(), ".grok"),
    };
    try {
      await nativeRun(
        { ...config, sandbox: "danger-full-access", network_access: true },
        cwd,
        async (host, _callbacks, envelopes) => {
          await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
            timeout: 40_000,
          });
          const turn = host.send(
            "Use run_terminal_command once to run exactly: " +
              `dd if=/dev/zero of=${JSON.stringify(target)} bs=1 count=1. ` +
              "Do not retry after rejection.",
          );
          void turn.catch(() => {});
          if (allow) await turn;
          else await expect(turn).rejects.toThrow("permission rejected");
          expect(envelopes.some((e) => e.type === "permission_request")).toBe(
            true,
          );
          expect(envelopes.some((e) => e.state === "waiting_permission")).toBe(
            true,
          );
          expect(
            envelopes.filter((e) => e.type === "result").at(-1)?.payload
              .error_code,
          ).toBe(allow ? undefined : "permission_rejected");
          expect(host.state).toBe("waiting_input");
          expect(existsSync(target)).toBe(allow);
        },
        env,
        () => allow,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  180_000,
);
it.skipIf(!live)(
  "native wrapper SIGTERM removes Grok and its active tool child",
  async () => {
    const { spawn } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const root = mkdtempSync(join(homedir(), ".kaoiro-grok-sigterm-"));
    const file = join(root, "agent.json");
    const ready = join(root, "ready");
    const toolPidFile = join(root, "tool-pid");
    const driver = join(root, "driver.mjs");
    writeFileSync(file, JSON.stringify(config));
    const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    writeFileSync(
      driver,
      `import { runGrokCli } from ${JSON.stringify(cli)};
import { writeFileSync } from 'node:fs';
process.argv = [process.argv[0], process.argv[1], 'run', ${JSON.stringify(file)}];
await runGrokCli({
 createServerLink: (_url, _id, options) => {
  queueMicrotask(() => options.onPersonaPrompt('Be concise.'));
  return { send() {}, setSessionId() {},
   noticeAttributionMode() { return 'legacy'; },
   deliveryIncarnation() { return null; },
   deliveryGeneration() { return null; },
   async reportDisconnectIntent() {}, close() {} };
 },
 onHostCreated: host => {
  const timer = setInterval(() => { if (host.state === 'waiting_input') {
   clearInterval(timer);
   writeFileSync(${JSON.stringify(ready)}, String(host.processId));
   void host.send(${JSON.stringify(
     "Use run_terminal_command exactly: " +
       `printf '%s' "$$" > ${JSON.stringify(toolPidFile)}; exec sleep 120. ` +
       "Do not run any other command.",
   )}).catch(() => {});
  } }, 25);
 }
});
`,
    );
    const child = spawn(process.execPath, [driver], {
      cwd: root,
      stdio: "ignore",
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    });
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), {
        timeout: 40_000,
      });
      await vi.waitFor(() => expect(existsSync(toolPidFile)).toBe(true), {
        timeout: 120_000,
      });
      const toolPid = Number(readFileSync(toolPidFile, "utf8"));
      expect(toolPid).toBeGreaterThan(1);
      expect(readFileSync(`/proc/${toolPid}/stat`, "utf8").split(" ")[1]).toBe(
        "(sleep)",
      );
      const grokPid = Number(readFileSync(ready, "utf8"));
      expect(grokPid).toBeGreaterThan(1);
      const startedAt = Date.now();
      child.kill("SIGTERM");
      await exited;
      expect(Date.now() - startedAt).toBeLessThan(4_500);
      await vi.waitFor(() => {
        expect(() => process.kill(-grokPid, 0)).toThrow();
        expect(() => process.kill(toolPid, 0)).toThrow();
      });
      expect(Date.now() - startedAt).toBeLessThan(4_500);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  180_000,
);
// Turns Grok starts on its own (issue 1128). The live plugin asks for every
// command carrying the marker and the rule would allow them, so only the
// wrapper's ownership check keeps the self-started command from the operator.
const SELF_STARTED = "Grok started a turn on its own";
const OWN_TURN_ENDED = "Grok's own turn ended";
function systemTexts(envelopes: Envelope[]) {
  return envelopes.filter((e) => e.type === "log" && e.payload.kind === "system")
    .map((e) => String(e.payload.text));
}
function askedCommands(envelopes: Envelope[]) {
  return envelopes.filter((e) => e.type === "permission_request")
    .map((e) => String((e.payload.input as Record<string, unknown> | undefined)?.command ?? ""));
}
it.skipIf(!live)(
  "native self-started turn: its permission never reaches the operator's next turn",
  async () => {
    const root = mkdtempSync(join(homedir(), ".kaoiro-grok-1128-"));
    const marker = "KAOIRO1128LIVE";
    const decisions: PermissionDecisionRecord[] = [];
    try {
      await nativeRun(config, root, async (host, _link, envelopes) => {
        await vi.waitFor(() => expect(host.state).toBe("waiting_input"), { timeout: 40_000 });
        await host.send(
          `Start \`sleep 6 # ${marker}\` with run_terminal_command as a background task ` +
            "(is_background true) and do not wait for it. When that background task finishes, " +
            `run \`printf done-${marker}\` with run_terminal_command.`,
        );
        // Positive control: the own marker command did ask the operator.
        expect(askedCommands(envelopes).some((c) => c.startsWith("sleep 6"))).toBe(true);
        await vi.waitFor(() => expect(systemTexts(envelopes).some((t) => t.startsWith(SELF_STARTED)))
          .toBe(true), { timeout: 60_000 });
        // A turn sent one microtask after the previous one ends is never
        // dispatched; that race in the drain loop predates this test.
        await delay(100);
        const from = envelopes.length;
        await host.send("What is 2 + 2? Answer in one short sentence and use no tools.");
        await vi.waitFor(() => expect(systemTexts(envelopes)).toContain(OWN_TURN_ENDED), { timeout: 60_000 });
        expect(askedCommands(envelopes).filter((c) => c.includes("printf done-"))).toEqual([]);
        const result = envelopes.slice(from).filter((e) => e.type === "result").at(-1);
        const opened = envelopes.findIndex((e) => e.type === "log" && e.payload.kind === "system" &&
          String(e.payload.text).startsWith(SELF_STARTED));
        const closed = envelopes.findIndex((e) => e.type === "log" && e.payload.kind === "system" &&
          e.payload.text === OWN_TURN_ENDED);
        for (const log of envelopes.slice(opened, closed)) {
          if (log.type === "log" && log.payload.kind === "assistant" && String(log.payload.text).length > 8)
            expect(String(result?.payload.text)).not.toContain(String(log.payload.text));
        }
        if (process.env.KAOIRO_LIVE_GROK_1128_REPORT)
          writeFileSync(process.env.KAOIRO_LIVE_GROK_1128_REPORT, JSON.stringify({
            asked: askedCommands(envelopes), system: systemTexts(envelopes), result: result?.payload,
            decisions,
          }, null, 1));
      }, undefined, { rule: { marker }, decisions });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  240_000,
);
it.skipIf(!live)(
  "native interrupt while the own prompt waits behind a self-started turn does not close the agent",
  async () => {
    const root = mkdtempSync(join(homedir(), ".kaoiro-grok-1128i-"));
    const marker = "KAOIRO1128LIVE";
    try {
      await nativeRun(config, root, async (host, _link, envelopes) => {
        await vi.waitFor(() => expect(host.state).toBe("waiting_input"), { timeout: 40_000 });
        await host.send(
          `Start \`sleep 6 # ${marker}\` with run_terminal_command as a background task ` +
            "(is_background true) and do not wait for it. Then reply 'started'.",
        );
        await vi.waitFor(() => expect(systemTexts(envelopes).some((t) => t.startsWith(SELF_STARTED)))
          .toBe(true), { timeout: 60_000 });
        const grokPid = host.processId;
        const from = envelopes.length;
        const waiting = host.send("Count slowly from one to twenty, one number per line.");
        void waiting.catch(() => {});
        await delay(300);
        const startedAt = Date.now();
        await host.interrupt();
        await waiting;
        expect(Date.now() - startedAt).toBeLessThan(15_000);
        expect(envelopes.slice(from).filter((e) => e.type === "result").at(-1)?.ext)
          .toMatchObject({ stop_reason: "cancelled", interrupted: true });
        await delay(3_500);
        expect(host.processId).toBe(grokPid);
        await host.send("Reply with the single word OK and use no tools.");
        expect(envelopes.filter((e) => e.type === "result").at(-1)?.payload.is_error).toBe(false);
      }, undefined, { rule: { marker } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  240_000,
);
// Background tasks of an interrupted turn (issue 594). Throwaway Grok
// settings with one file deny rule make the self-started turn's follow-up
// command (a redirect to a path in a variable) ask for permission at once.
function procStat(pid: number) {
  expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return { comm: stat.slice(stat.indexOf("("), stat.lastIndexOf(")") + 1),
      start: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] };
  } catch { return undefined; }
}
it.skipIf(!live)(
  "native interrupt kills the turn's background tasks and spares an earlier turn's",
  async () => {
    const root = mkdtempSync(join(homedir(), ".kaoiro-grok-594-"));
    const home = mkdtempSync(join(homedir(), ".kaoiro-grok-594-home-"));
    const marker = "KAOIRO594LIVE";
    const pidFile = (name: string) => join(root, `${name}.pid`);
    const background = (name: string) => `printf '%s' "$$" > ${pidFile(name)}; exec sleep 300 # ${marker}`;
    let a: number | undefined;
    try {
      mkdirSync(join(home, ".claude"));
      writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: {
        defaultMode: "auto", deny: ["Read(**/.env)", "Edit(**/.env)"] } }));
      const env = Object.assign({}, process.env, { HOME: home, GROK_HOME: join(homedir(), ".grok") });
      await nativeRun(config, root, async (host, _link, envelopes) => {
        await vi.waitFor(() => expect(host.state).toBe("waiting_input"), { timeout: 40_000 });
        await host.send("Start this command with run_terminal_command as a background task " +
          `(is_background true) and do not wait for it: ${background("A")}. Then reply 'started'.`);
        a = Number(readFileSync(pidFile("A"), "utf8"));
        const aStart = procStat(a)?.start;
        expect(procStat(a)?.comm).toBe("(sleep)");
        await delay(100);
        const turn = host.send("Start these two commands with run_terminal_command, each as its own " +
          `background task (is_background true): ${background("B1")}  and  ${background("B2")}. ` +
          "Then run `sleep 100` in the foreground with block_until_ms 120000 and wait for it. " +
          "When the background tasks finish or stop for any reason, run exactly this with " +
          `run_terminal_command: OUT=${root}; printf done > "$OUT/done-file" # ${marker}`);
        void turn.catch(() => {});
        await vi.waitFor(() => expect(existsSync(pidFile("B1")) && existsSync(pidFile("B2"))).toBe(true),
          { timeout: 120_000 });
        await delay(8_000);
        const b = ["B1", "B2"].map((name) => Number(readFileSync(pidFile(name), "utf8")));
        for (const pid of b) expect(procStat(pid)?.comm).toBe("(sleep)");
        const from = envelopes.length;
        await host.interrupt();
        await turn;
        const result = envelopes.slice(from).filter((e) => e.type === "result").at(-1)!;
        expect(result.ext).toMatchObject({ stop_reason: "cancelled", interrupted: true });
        await vi.waitFor(() => { for (const pid of b) expect(procStat(pid)).toBeUndefined(); },
          { timeout: 5_000, interval: 100 });
        expect(procStat(a!)).toEqual({ comm: "(sleep)", start: aStart });
        await vi.waitFor(() => expect(envelopes.some((e) => e.type === "log" && e.payload.kind === "system" &&
          String(e.payload.text).startsWith("Refused a permission request from a turn Grok started on its own")))
          .toBe(true), { timeout: 90_000 });
        const opened = envelopes.findIndex((e) => e.type === "log" && e.payload.kind === "system" &&
          String(e.payload.text).startsWith("Grok started a turn on its own"));
        expect(opened).toBeGreaterThan(envelopes.indexOf(result));
        expect(envelopes.slice(from).filter((e) => e.type === "permission_request")).toEqual([]);
        expect(host.state).toBe("waiting_input");
        if (process.env.KAOIRO_LIVE_GROK_594_REPORT)
          writeFileSync(process.env.KAOIRO_LIVE_GROK_594_REPORT, JSON.stringify({
            system: envelopes.filter((e) => e.type === "log" && e.payload.kind === "system")
              .map((e) => e.payload.text),
            result: result.payload, ext: result.ext }, null, 1));
      }, env, { rule: { marker } });
      await vi.waitFor(() => expect(procStat(a!)).toBeUndefined(), { timeout: 10_000 });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  },
  300_000,
);
