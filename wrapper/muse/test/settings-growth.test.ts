import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { checkUserAppend } from "../src/muse/process.js";

const fixture = vi.hoisted(() => ({ path: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: async (...args: Parameters<typeof original.open>) => {
    const file = await original.open(...args);
    if (args[0] !== fixture.path) return file;
    return new Proxy(file, {
      get(target, key) {
        if (key === "stat") return async () => {
          const stat = await target.stat();
          Object.defineProperty(stat, "size", { value: 0 });
          return stat;
        };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  } };
});

it("bounds the read even if a settings file grows after its stat", async () => {
  const root = mkdtempSync(join(tmpdir(), "muse-growth-"));
  try {
    mkdirSync(join(root, "muse"));
    fixture.path = join(root, "muse", "settings.json");
    const length = 1024 * 1024 + 1 - Buffer.byteLength('{"value":""}');
    writeFileSync(fixture.path, `{"value":"${"x".repeat(length)}"}`);
    await expect(checkUserAppend({ XDG_CONFIG_HOME: root }))
      .rejects.toThrow(/muse user settings could not be checked/);
  } finally {
    fixture.path = "";
    rmSync(root, { recursive: true, force: true });
  }
});
