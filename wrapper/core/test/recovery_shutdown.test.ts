import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { RecoveryFailure, recoveryExitCode } from "../src/recovery_checkpoint.js";

it("keeps checkpoint-unavailable status across an unrelated finalizer error", () => {
  const previous = process.exitCode;
  try { process.exitCode = 79; expect(recoveryExitCode(new Error("finalizer"))).toBe(79); }
  finally { process.exitCode = previous; }
  expect(recoveryExitCode(new RecoveryFailure(1, "candidate_attach_unavailable"))).toBe(1);
});

it.each([false, true])("bounds actual recovery shutdown with owned process handles (stalled=%s)", async stalled => {
  const module = new URL("../dist/recovery_checkpoint.js", import.meta.url).href;
  const script = `import { RecoveryFailure, shutdownForRecovery } from ${JSON.stringify(module)};
const start = Date.now();
${stalled ? "setInterval(() => {}, 1000);" : ""}
void shutdownForRecovery(new RecoveryFailure(79, 'checkpoint_unavailable'),
  () => ${stalled ? "new Promise(() => {})" : "undefined"},
  () => ${stalled ? "new Promise(() => {})" : "undefined"},
  () => console.log(JSON.stringify({closed: true, elapsed: Date.now() - start})));`;
  const started = performance.now();
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("owned recovery process exceeded deadline")); }, 15_000);
      child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (!stalled) expect(performance.now() - started).toBeLessThan(8_000);
    expect(result).toEqual({ code: 79, signal: null }); expect(stderr).toBe("");
    const close = JSON.parse(stdout.trim()) as { closed: boolean; elapsed: number };
    expect(close.closed).toBe(true); expect(close.elapsed).toBeLessThan(5_000);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}, 20_000);
