import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const root = process.env.FUJI401_ROOT;
if (!root) throw new Error("missing FUJI401_ROOT");
mkdirSync(root, { recursive: true });
const pidFile = join(root, "child.pid");
const wrapper = spawn(process.execPath, [new URL("./wrapper.mjs", import.meta.url).pathname], {
  env: { ...process.env, FUJI401_CHILD_PID_FILE: pidFile }, stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
wrapper.stderr.on("data", chunk => { output = (output + String(chunk)).slice(-3000); });
wrapper.stdout.resume();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const state = pid => {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] ?? "unknown"; }
  catch { return "gone"; }
};
let childPid;
try {
  const readyBy = performance.now() + 10000;
  while (!existsSync(pidFile) && performance.now() < readyBy && state(wrapper.pid) !== "gone") await sleep(20);
  if (!existsSync(pidFile)) throw new Error(`child never started: ${output}`);
  childPid = Number(readFileSync(pidFile, "utf8"));
  const t0 = performance.now();
  process.kill(wrapper.pid, "SIGTERM");
  const directKillMs = Number(process.env.FUJI401_DIRECT_KILL_MS || 0);
  if (directKillMs > 0) {
    setTimeout(() => {
      if (!["gone", "Z"].includes(state(childPid))) process.kill(childPid, "SIGKILL");
    }, directKillMs);
  }
  await sleep(5000);
  const wrapperAtGrace = state(wrapper.pid);
  if (wrapperAtGrace !== "gone" && wrapperAtGrace !== "Z") process.kill(wrapper.pid, "SIGKILL");
  await sleep(150);
  const result = { wrapperPid: wrapper.pid, childPid, wrapperAtGrace,
    childAfterReset: state(childPid), elapsedMs: Math.round(performance.now() - t0),
    wrapperError: existsSync(join(root, "wrapper-error.txt")) ? readFileSync(join(root, "wrapper-error.txt"), "utf8") : null,
    stderrTail: output };
  console.log(JSON.stringify(result));
} finally {
  if (childPid && !["gone", "Z"].includes(state(childPid))) process.kill(childPid, "SIGKILL");
  if (!["gone", "Z"].includes(state(wrapper.pid))) process.kill(wrapper.pid, "SIGKILL");
  await sleep(100);
  rmSync(root, { recursive: true, force: true });
}
