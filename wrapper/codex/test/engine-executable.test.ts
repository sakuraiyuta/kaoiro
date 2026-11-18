import "../../../scripts/test/fixtures/test-isolation.mjs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AppServerRpc } from "../src/app_server_rpc.js";

it("starts the app-server from the explicit executable", async () => {
  const root = mkdtempSync(join(tmpdir(), "momo1193-codex-"));
  const executable = join(root, "codex");
  const marker = join(root, "started");
  writeFileSync(executable, `#!/bin/sh\nprintf started > '${marker}'\n`, { mode: 0o755 });
  try {
    const rpc = new AppServerRpc({ engineExecutable: executable });
    await vi.waitFor(() => expect(readFileSync(marker, "utf8")).toBe("started"));
    await rpc.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
