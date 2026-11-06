import "../../../scripts/test/fixtures/test-isolation.mjs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { runCodexCli } from "../src/cli.js";

it("refuses exec through the direct wrapper loader before opening a link or Host", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-retired-exec-"));
  const path = join(root, "wrapper.json");
  await writeFile(path, JSON.stringify({ agent_id: "fixture", persona: { id: "p", name: "P", sprite_set: "p" },
    display_name: "P", server_url: "ws://fixture/wrapper", codex_backend: "exec" }));
  const createHost = vi.fn(() => { throw new Error("unexpected Host"); });
  const createServerLink = vi.fn(() => { throw new Error("unexpected link"); });
  try {
    await expect(runCodexCli({ parseCliArgs: () => ({ configPath: path }), createHost, createServerLink })).rejects.toThrow("exec is retired");
    expect(createHost).not.toHaveBeenCalled();expect(createServerLink).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});
