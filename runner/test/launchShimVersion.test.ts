// runner/deploy/kaoiro-runner-launch.sh (issue #228 round 2 MF-5, ふじ 差
// し戻し): --version must be forwarded to the entry point BEFORE the
// config-existence check, so a first-run host with no config yet can
// still answer it. This exercises the REAL, unmodified shim script bytes
// (copied verbatim, not reimplemented) against a fixture "deploy/ + dist/"
// layout that mirrors what scripts/build-runner-tarball.sh actually ships
// — only the entry point (dist/cli.js) is a stub, since building the real
// one here would require a full `pnpm -C runner build` this test suite
// does not depend on.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { formatBuildIdentity, type BuildInfo } from "../src/build_info.js";

const shimSource = readFileSync(
  fileURLToPath(new URL("../deploy/kaoiro-runner-launch.sh", import.meta.url)),
  "utf8",
);

// Mimics ONLY the --version contract cli.ts actually implements (reads a
// sibling build-info.json, prints the canonical identity, exits 0) — cli.ts's
// OWN behavior is pinned separately (args.test.ts / build_info.test.ts); this
// stub exists so the SHIM's forwarding logic can be tested without a real
// `pnpm -C runner build`.
const STUB_CLI = `
const fs = require("node:fs");
const path = require("node:path");
  if (process.argv.includes("--version")) {
  const info = JSON.parse(
    fs.readFileSync(path.join(__dirname, "build-info.json"), "utf8"),
  );
  const shortHash = info.revision === "unknown" ? "unknown" : info.revision.slice(0, 7);
  process.stdout.write(\`kaoiro \${info.channel ?? "dev"} runner v\${info.version ?? "unknown"} / \${shortHash}\\n\`);
  process.exit(0);
}
process.stdout.write("stub cli.js: no --version given\\n");
process.exit(1);
`;

function buildFixture(dir: string, buildInfo: BuildInfo): void {
  const deployDir = join(dir, "deploy");
  const distDir = join(dir, "dist");
  mkdirSync(deployDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });
  const shimPath = join(deployDir, "kaoiro-runner-launch.sh");
  writeFileSync(shimPath, shimSource);
  chmodSync(shimPath, 0o755);
  writeFileSync(join(distDir, "cli.js"), STUB_CLI);
  writeFileSync(join(distDir, "build-info.json"), JSON.stringify(buildInfo));
}

describe("kaoiro-runner-launch.sh --version (issue #228 round 2 MF-5)", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir !== undefined) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("config が存在しなくても --version は canonical form を返す (exit 0)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-shim-version-"));
    const buildInfo: BuildInfo = {
      revision: "0123456789abcdef0123456789abcdef01234567",
      dirty: true,
      built_at: "2026-08-12T00:00:00.000Z",
      version: "2026.9.0",
      channel: "release",
    };
    buildFixture(tmpDir, buildInfo);

    // KAOIRO_RUNNER_DIR points config resolution at a dir that deliberately
    // holds no runner.config.json — proving --version does not require one.
    const out = execFileSync(
      join(tmpDir, "deploy", "kaoiro-runner-launch.sh"),
      ["--version"],
      {
        encoding: "utf8",
        env: { ...process.env, KAOIRO_RUNNER_DIR: join(tmpDir, "no-config-here") },
      },
    );

    expect(out.trim()).toBe(formatBuildIdentity(buildInfo));
  });

  // Complementary regression pin: an ORDINARY launch (no --version) must
  // still hit the config-existence check and fail loudly — the --version
  // shortcut must not accidentally swallow the normal path too.
  it("--version 無しの通常起動は config 未設置なら exit 78 で失敗する", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-shim-version-"));
    buildFixture(tmpDir, {
      revision: "0123456789abcdef0123456789abcdef01234567",
      dirty: false,
      built_at: "2026-08-12T00:00:00.000Z",
    });

    expect(() =>
      execFileSync(join(tmpDir!, "deploy", "kaoiro-runner-launch.sh"), [], {
        encoding: "utf8",
        env: { ...process.env, KAOIRO_RUNNER_DIR: join(tmpDir!, "no-config-here") },
      }),
    ).toThrowError(expect.objectContaining({ status: 78 }));
  });
});
