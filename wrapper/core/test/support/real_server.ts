// Test-only: boots the real Phoenix server for wrapper integration tests.
// It runs the server's test environment, whose config puts every boot's
// DETS stores under the system temp dir, with the endpoint enabled on a free
// loopback port. That temp dir is a private scratch dir removed on stop.
// Only the child this module spawned is ever signalled, by its own process
// group.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = fileURLToPath(new URL("../../../../server", import.meta.url));

export interface RealServer {
  url: string;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

function accepting(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

/** `afterBoot` is Elixir evaluated once the application started, e.g. to
 *  switch on queue routing. */
export async function startRealServer(afterBoot = ":ok", timeoutMs = 90_000): Promise<RealServer> {
  const port = await freePort();
  const scratch = mkdtempSync(join(tmpdir(), "kaoiro-real-server-"));
  const child: ChildProcess = spawn(process.env.KAOIRO_MIX ?? "mix", ["run", "--no-halt", "-e", afterBoot], {
    cwd: SERVER_DIR,
    env: { ...process.env, MIX_ENV: "test", PHX_SERVER: "true", PORT: String(port), TMPDIR: scratch },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  let exited = false;
  child.once("exit", () => { exited = true; });

  const stop = async (): Promise<void> => {
    const pid = child.pid;
    if (!exited && pid !== undefined && Number.isSafeInteger(pid) && pid > 1) {
      const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      process.kill(-pid, "SIGTERM");
      const timer = setTimeout(() => { if (!exited) process.kill(-pid, "SIGKILL"); }, 5_000);
      await gone;
      clearTimeout(timer);
    }
    rmSync(scratch, { recursive: true, force: true });
  };

  const deadline = Date.now() + timeoutMs;
  while (!(await accepting(port))) {
    if (exited || Date.now() > deadline) {
      await stop();
      throw new Error(`real server did not start on ${port}:\n${output.slice(-4000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { url: `ws://127.0.0.1:${port}/wrapper`, stop };
}
