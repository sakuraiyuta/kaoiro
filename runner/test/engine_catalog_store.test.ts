import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const probe = vi.hoisted(() => vi.fn(
  async (_options: { engineExecutable?: string | undefined }) => ({
    ok: true, models: [{ value: "m", display_name: "Model" }], elapsed_ms: 1,
  }),
));
vi.mock("@kaoiro/claude-code/probe-client", () => ({ runClaudeProbe: probe }));

import { ClaudeCatalogCache } from "../src/claude_catalog_cache.js";
import {
  makeRefreshEngineCatalogHandler,
} from "../src/engine_catalog_refresh.js";
import { engineArtifact } from "../src/engines.js";

it("resolves the stored Claude executable for each catalog probe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kaoiro-catalog-store-"));
  const prior = process.env.KAOIRO_ENGINE_STORE_DIR;
  try {
    process.env.KAOIRO_ENGINE_STORE_DIR = dir;
    const artifact = engineArtifact("claude-code")!;
    const storeName = `${artifact.name.split("/")[1]}@${artifact.version}`;
    const stored = join(dir, storeName);
    const received: unknown[] = [];
    const handler = makeRefreshEngineCatalogHandler({
      getHostId: () => "host", cache: new ClaudeCatalogCache({ ttlMs: 0 }),
      getCurrentConfig: () => ({ host_id: "host", server_url: "ws://localhost",
        cwd_allowlist: [dir], capabilities: ["claude-code"] }),
      getCodexAuthMode: () => "unknown", getAntigravityCatalog: () => undefined,
      getAntigravityCliVersion: () => undefined, updateRegister: () => {},
      sendCatalogResult: (result) => received.push(result),
      buildInfo: { revision: "unknown", dirty: false, built_at: "unknown" },
    });
    handler({ engine: "claude-code", request_id: "a", force: true });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    mkdirSync(stored, { recursive: true });
    writeFileSync(join(stored, "claude"), "engine");
    handler({ engine: "claude-code", request_id: "b", force: true });
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(probe.mock.calls[0]?.[0]).toEqual({ engineExecutable: undefined });
    expect(probe.mock.calls[1]?.[0]).toEqual({
      engineExecutable: join(stored, "claude"),
    });
  } finally {
    if (prior === undefined) delete process.env.KAOIRO_ENGINE_STORE_DIR;
    else process.env.KAOIRO_ENGINE_STORE_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
