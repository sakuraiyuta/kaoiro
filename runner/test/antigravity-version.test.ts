import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { resolveAgyVersion } from "../src/antigravity-version.js";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

describe("resolveAgyVersion (issue #387)", () => {
  it("成功時は stdout を trim して返す", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-agy-version-"));
    const script = join(dir, "agy");
    writeFileSync(script, "#!/bin/sh\nprintf 'agy-cli 1.2.3\\n'\n");
    chmodSync(script, 0o755);

    const version = await resolveAgyVersion({ ok: true, path: script }, 5_000);
    expect(version).toBe("agy-cli 1.2.3");
  });

  it("issue #387 review should2: 非ゼロ終了なら null を返す", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-agy-version-"));
    const script = join(dir, "agy");
    writeFileSync(script, "#!/bin/sh\nexit 1\n");
    chmodSync(script, 0o755);

    const version = await resolveAgyVersion({ ok: true, path: script }, 5_000);
    expect(version).toBeNull();
  });

  it(
    "issue #387 review should2: SIGTERM を無視する子でも期限内に null を返し、子を SIGKILL で止める (watchdog)",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "kaoiro-agy-version-"));
      const script = join(dir, "agy");
      const pidFile = join(dir, "pid");
      writeFileSync(
        script,
        `#!/bin/sh
trap '' TERM
echo $$ > ${JSON.stringify(pidFile)}
while :; do sleep 1; done
`,
      );
      chmodSync(script, 0o755);

      const t0 = performance.now();
      const version = await resolveAgyVersion({ ok: true, path: script }, 300);
      const elapsedMs = performance.now() - t0;

      // The caller must be released near the deadline -- NOT hang until the
      // child eventually dies on its own (which, ignoring SIGTERM, it never
      // would without the watchdog's SIGKILL).
      expect(version).toBeNull();
      expect(elapsedMs).toBeLessThan(2_000);

      await waitFor(() => existsSync(pidFile), 2_000);
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      await waitFor(() => !isAlive(pid), 3_000);
    },
    10_000,
  );
});
