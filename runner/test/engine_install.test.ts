import "../../scripts/test/fixtures/test-isolation.mjs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installArtifact, installEngines, runEngines,
} from "../src/engine_install.js";
import { engineBinaryPath } from "../src/engines.js";

describe("engine acquisition", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a missing config and rejects invalid configuration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-engine-config-"));
    dirs.push(dir);
    const config = join(dir, "runner.json");
    await installEngines(dir, config);
    expect(readdirSync(dir)).toEqual([]);
    writeFileSync(config, "{");
    await expect(installEngines(dir, config)).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(["runner.json"]);
  });

  it("requires install arguments and a config location", async () => {
    await expect(runEngines([])).rejects
      .toThrow("usage: kaoiro engines install");
    const previous = process.env.KAOIRO_RUNNER_CONFIG;
    try {
      delete process.env.KAOIRO_RUNNER_CONFIG;
      await expect(runEngines(["install", "--install-dir", "/unused"]))
        .rejects.toThrow("KAOIRO_RUNNER_CONFIG is required");
    } finally {
      if (previous === undefined) delete process.env.KAOIRO_RUNNER_CONFIG;
      else process.env.KAOIRO_RUNNER_CONFIG = previous;
    }
  });

  it("rejects an enabled engine without a matching host artifact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-engine-platform-"));
    dirs.push(dir);
    const config = join(dir, "runner.json");
    writeFileSync(config, JSON.stringify({ host_id: "h", cwd_allowlist: [dir],
      server_url: "ws://localhost/runner", capabilities: ["claude-code"] }));
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { value: "unsupported" });
      await expect(installEngines(dir, config))
        .rejects.toThrow("No artifact for claude-code");
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  });

  it("fetches once and preserves an existing package", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-engine-test-"));
    dirs.push(dir);
    const source = join(dir, "source");
    mkdirSync(join(source, "package"), { recursive: true });
    writeFileSync(join(source, "package", "claude"), "engine");
    const archive = join(dir, "engine.tgz");
    expect(spawnSync("tar", ["-czf", archive, "-C", source, "package"]).status)
      .toBe(0);
    const bytes = readFileSync(archive);
    const artifact = { name: "@test/engine", version: "1", integrity:
      `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
    let requests = 0;
    const server = createServer((_req, res) => { requests++; res.end(bytes); });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("no address");
      }
      const registry = `http://127.0.0.1:${address.port}`;
      const root = join(dir, "root");
      await installArtifact(root, "claude-code", artifact, registry);
      const destination = join(root, "engines", "engine@1");
      expect(readFileSync(join(destination, "claude"), "utf8")).toBe("engine");
      writeFileSync(join(destination, "marker"), "kept");
      await installArtifact(root, "claude-code", artifact, registry);
      expect(requests).toBe(1);
      expect(readFileSync(join(destination, "marker"), "utf8")).toBe("kept");
      expect(readdirSync(join(root, "engines"))).toEqual(["engine@1"]);
      await expect(installArtifact(join(dir, "bad"), "claude-code", {
        ...artifact, integrity: "sha512-invalid",
      }, registry)).rejects.toThrow("integrity mismatch");
      expect(readdirSync(join(dir, "bad", "engines"))).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
    }
  });

  it.each(["missing", "empty", "populated"])(
    "publishes against a %s destination created during fetch",
    async (condition) => {
      const dir = mkdtempSync(join(tmpdir(), "kaoiro-engine-race-"));
      dirs.push(dir);
      const source = join(dir, "source");
      mkdirSync(join(source, "package"), { recursive: true });
      writeFileSync(join(source, "package", "claude"), "new");
      const archive = join(dir, "engine.tgz");
      const result = spawnSync("tar", [
        "-czf", archive, "-C", source, "package",
      ]);
      expect(result.status).toBe(0);
      const bytes = readFileSync(archive);
      const artifact = { name: "@test/engine", version: "1", integrity:
        `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
      const root = join(dir, "root");
      const dest = join(root, "engines", "engine@1");
      const server = createServer((_req, res) => {
        if (condition !== "missing") mkdirSync(dest);
        if (condition === "populated") {
          writeFileSync(join(dest, "marker"), "old");
        }
        res.end(bytes);
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("no address");
        }
        await installArtifact(root, "claude-code", artifact,
          `http://127.0.0.1:${address.port}`);
        expect(readdirSync(join(root, "engines"))).toEqual(["engine@1"]);
        if (condition === "populated") {
          expect(readFileSync(join(dest, "marker"), "utf8")).toBe("old");
        } else {
          expect(readFileSync(join(dest, "claude"), "utf8")).toBe("new");
        }
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => err ? reject(err) : resolve());
        });
      }
    },
  );

  it.each(["truncated", "unpack"])(
    "leaves no published package after %s failure", async (failure) => {
      const dir = mkdtempSync(join(tmpdir(), "kaoiro-engine-failure-"));
      dirs.push(dir);
      const bytes = Buffer.from("not a tarball");
      const artifact = { name: "@test/engine", version: "1", integrity:
        `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
      const server = createServer((_req, res) => {
        if (failure === "truncated") {
          res.setHeader("Content-Length", bytes.length + 10);
        }
        res.end(bytes);
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("no address");
        }
        const root = join(dir, "root");
        const outcome = expect(installArtifact(root, "claude-code", artifact,
          `http://127.0.0.1:${address.port}`)).rejects;
        if (failure === "unpack") await outcome.toThrow("Engine unpack failed");
        else await outcome.toThrow();
        expect(readdirSync(join(root, "engines"))).toEqual([]);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((err) => err ? reject(err) : resolve());
        });
      }
    }, 15_000,
  );

  it.each([404, 204])("rejects registry response %s", async (status) => {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-engine-http-"));
    dirs.push(dir);
    const server = createServer((_req, res) => {
      res.statusCode = status;
      res.end("missing");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("no address");
      }
      await expect(installArtifact(dir, "claude-code", {
        name: "@test/engine", version: "1", integrity: "sha512-invalid",
      }, `http://127.0.0.1:${address.port}`))
        .rejects.toThrow(`Engine fetch failed: ${status}`);
      expect(readdirSync(join(dir, "engines"))).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
    }
  });

  it("refuses a Codex acquisition without release identity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-codex-identity-"));
    dirs.push(dir);
    const source = join(dir, "source");
    mkdirSync(join(source, "package"), { recursive: true });
    writeFileSync(join(source, "package", "marker"), "payload");
    const archive = join(dir, "engine.tgz");
    expect(spawnSync("tar", ["-czf", archive, "-C", source, "package"]).status)
      .toBe(0);
    const bytes = readFileSync(archive);
    const artifact = { name: "@openai/codex-linux-x64", version: "1", integrity:
      `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url!);
      res.end(bytes);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("no address");
      }
      await expect(installArtifact(dir, "codex", artifact,
        `http://127.0.0.1:${address.port}`,
        join(dir, "missing-identity.json"))).rejects.toThrow(/missing-identity\.json/);
      expect(requests).toEqual(["/@openai/codex/-/codex-1-linux-x64.tgz"]);
      expect(readdirSync(join(dir, "engines"))).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
    }
  });

  it("checks the Codex version and native hash before publication", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-codex-check-"));
    dirs.push(dir);
    const source = join(dir, "source");
    const binary = engineBinaryPath("codex", join(source, "package"));
    mkdirSync(dirname(binary), { recursive: true });
    writeFileSync(binary, "native fixture");
    const archive = join(dir, "engine.tgz");
    expect(spawnSync("tar", ["-czf", archive, "-C", source, "package"]).status)
      .toBe(0);
    const bytes = readFileSync(archive);
    const artifact = { name: "@openai/codex-linux-x64", version: "1", integrity:
      `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
    const identity = join(dir, "identity.json");
    const nativeHash = createHash("sha256").update("native fixture").digest("hex");
    const server = createServer((_req, res) => res.end(bytes));
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("no address");
      }
      const registry = `http://127.0.0.1:${address.port}`;
      for (const value of [
        { version: "2", sha256: nativeHash },
        { version: "1", sha256: "incorrect" },
      ]) {
        writeFileSync(identity, JSON.stringify(value));
        await expect(installArtifact(dir, "codex", artifact, registry, identity))
          .rejects.toThrow("Codex native identity mismatch");
        expect(readdirSync(join(dir, "engines"))).toEqual([]);
      }
      writeFileSync(identity, JSON.stringify({ version: "1", sha256: nativeHash }));
      await installArtifact(dir, "codex", artifact, registry, identity);
      expect(readdirSync(join(dir, "engines"))).toEqual(["codex-linux-x64@1"]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
    }
  });
});
