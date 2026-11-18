import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_ARTIFACTS } from "@kaoiro/agent-common";
import { expect, it } from "vitest";

it("builds the target identity from the pinned native package", () => {
  const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-build-"));
  try {
    const pin = ENGINE_ARTIFACTS.find(
      (row) => row.name === "@openai/codex-linux-x64",
    )!;
    const packageDir = join(root, "node_modules/.pnpm",
      `@openai+codex@${pin.version}-linux-x64`, "node_modules/@openai/codex");
    const vendor = join(packageDir, "vendor/x86_64-unknown-linux-musl/bin");
    const binary = join(vendor, "codex");
    mkdirSync(vendor, { recursive: true });
    mkdirSync(join(root, "dist"));
    writeFileSync(binary, "native fixture");
    const manifest = join(packageDir, "package.json");
    const script = fileURLToPath(
      new URL("../../scripts/write-codex-native.mjs", import.meta.url),
    );
    const run = () => spawnSync(process.execPath, [script, root, "linux-x64"], {
      encoding: "utf8",
    });
    writeFileSync(manifest, JSON.stringify({
      version: `${pin.version}-linux-x64`,
    }));
    const good = run();
    expect(good.status, good.stderr).toBe(0);
    const identity = JSON.parse(
      readFileSync(join(root, "dist/codex-native.json"), "utf8"),
    );
    expect(identity.version).toBe(pin.version);
    expect(identity.sha256).toBe(
      createHash("sha256").update("native fixture").digest("hex"),
    );
    expect(join(root, identity.path)).toBe(binary);
    writeFileSync(manifest, JSON.stringify({ version: "wrong" }));
    const bad = run();
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("Codex version mismatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
