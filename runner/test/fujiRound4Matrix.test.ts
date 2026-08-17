// Place this file under runner/test/ before running it with Vitest.
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  revisionOf,
  runScript,
  writeWorkspaceCheckout,
} from "./releaseFixture.js";

type Expected = "ok" | "build" | "install" | "anomaly";
type Context = {
  root: string;
  outsideRoot: string;
  runner: string;
};
type MatrixCase = readonly [
  name: string,
  expected: Expected,
  mutate: (context: Context) => void,
];

describe("fuji round 4: production shim path-role matrix", () => {
  let root: string;
  let outsideRoot: string;
  let runner: string;
  let confDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fuji259-r4-matrix-"));
    outsideRoot = `${root}-outside`;
    mkdirSync(outsideRoot);
    runner = writeWorkspaceCheckout(root, revisionOf("fuji-r4"));
    confDir = join(root, "config");
    mkdirSync(confDir, { recursive: true });
    writeFileSync(
      join(confDir, "runner.config.json"),
      JSON.stringify({ host_id: "fuji", server_url: "ws://localhost/x" }),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  });

  const launch = () =>
    runScript(join(runner, "deploy", "kaoiro-runner-launch.sh"), [], {
      KAOIRO_RUNNER_DIR: confDir,
    });

  function assertResult(expected: Expected): void {
    const result = launch();
    if (expected === "ok") {
      expect(result.status).toBe(0);
      return;
    }

    expect(result.status).toBe(78);
    if (expected === "build") {
      expect(result.stderr).toContain("a build artifact is missing");
      expect(result.stderr).toContain("pnpm -C wrapper build && pnpm -C runner build");
      expect(result.stderr).not.toContain("pnpm install");
      return;
    }
    if (expected === "install") {
      expect(result.stderr).toContain("workspace dependency link is missing");
      expect(result.stderr).toContain("pnpm install");
      expect(result.stderr).not.toContain("pnpm -C wrapper build");
      return;
    }

    expect(result.stderr).toContain("NOT a missing build");
    expect(result.stderr).not.toContain("pnpm -C wrapper build");
    expect(result.stderr).not.toContain("pnpm install");
  }

  const cases: readonly MatrixCase[] = [
    ["healthy checkout / ordinary tree", "ok", () => {}],

    ["runner container / missing", "build", ({ runner }) => {
      rmSync(join(runner, "dist"), { recursive: true });
    }],
    ["runner container / plain file", "anomaly", ({ runner }) => {
      rmSync(join(runner, "dist"), { recursive: true });
      writeFileSync(join(runner, "dist"), "");
    }],
    ["runner container / dangling symlink", "anomaly", ({ runner }) => {
      renameSync(join(runner, "dist"), join(runner, "dist-real"));
      symlinkSync("missing-dist", join(runner, "dist"));
    }],
    ["runner container / healthy in-bound symlink", "anomaly", ({ runner }) => {
      renameSync(join(runner, "dist"), join(runner, "dist-real"));
      symlinkSync("dist-real", join(runner, "dist"));
    }],

    ["runner leaf / missing", "build", ({ runner }) => {
      unlinkSync(join(runner, "dist", "cli.js"));
    }],
    ["runner leaf / directory", "anomaly", ({ runner }) => {
      const leaf = join(runner, "dist", "cli.js");
      unlinkSync(leaf);
      mkdirSync(leaf);
    }],
    ["runner leaf / dangling symlink", "anomaly", ({ runner }) => {
      const leaf = join(runner, "dist", "cli.js");
      unlinkSync(leaf);
      symlinkSync("missing-cli.js", leaf);
    }],
    ["runner leaf / healthy in-bound file symlink", "ok", ({ runner }) => {
      const leaf = join(runner, "dist", "cli.js");
      renameSync(leaf, join(dirname(leaf), "cli-real.js"));
      symlinkSync("cli-real.js", leaf);
    }],
    ["runner leaf / healthy out-of-bound file symlink", "anomaly", ({ runner, outsideRoot }) => {
      const leaf = join(runner, "dist", "cli.js");
      const outside = join(outsideRoot, "outside-cli.js");
      renameSync(leaf, outside);
      symlinkSync(outside, leaf);
    }],

    ["workspace ancestor node_modules / missing", "install", ({ runner }) => {
      rmSync(join(runner, "node_modules"), { recursive: true });
    }],
    ["workspace ancestor node_modules / dangling symlink", "anomaly", ({ runner }) => {
      const modules = join(runner, "node_modules");
      renameSync(modules, join(runner, "node_modules-real"));
      symlinkSync("missing-node-modules", modules);
    }],
    ["workspace ancestor @kaoiro / missing", "install", ({ runner }) => {
      rmSync(join(runner, "node_modules", "@kaoiro"), { recursive: true });
    }],
    ["workspace ancestor @kaoiro / plain file", "anomaly", ({ runner }) => {
      const scope = join(runner, "node_modules", "@kaoiro");
      rmSync(scope, { recursive: true });
      writeFileSync(scope, "");
    }],
    ["workspace ancestor @kaoiro / dangling symlink", "anomaly", ({ runner }) => {
      const scope = join(runner, "node_modules", "@kaoiro");
      renameSync(scope, join(runner, "node_modules", "@kaoiro-real"));
      symlinkSync("missing-scope", scope);
    }],
    ["workspace ancestor @kaoiro / healthy in-bound symlink", "ok", ({ runner }) => {
      const scope = join(runner, "node_modules", "@kaoiro");
      renameSync(scope, join(runner, "node_modules", "@kaoiro-real"));
      symlinkSync("@kaoiro-real", scope);
    }],

    ["workspace package link / missing", "install", ({ runner }) => {
      unlinkSync(join(runner, "node_modules", "@kaoiro", "claude-code"));
    }],
    ["workspace package link / plain file", "anomaly", ({ runner }) => {
      const link = join(runner, "node_modules", "@kaoiro", "claude-code");
      unlinkSync(link);
      writeFileSync(link, "");
    }],
    ["workspace package link / dangling symlink", "anomaly", ({ runner }) => {
      const link = join(runner, "node_modules", "@kaoiro", "claude-code");
      unlinkSync(link);
      symlinkSync("../../../wrapper/missing-claude", link);
    }],
    ["workspace package link / healthy workspace symlink", "ok", () => {}],
    ["workspace package link / symlink to plain file", "anomaly", ({ root, runner }) => {
      const target = join(root, "not-a-package");
      writeFileSync(target, "");
      const link = join(runner, "node_modules", "@kaoiro", "claude-code");
      unlinkSync(link);
      symlinkSync(target, link);
    }],

    ["linked package container / missing", "build", ({ root }) => {
      rmSync(join(root, "wrapper", "claude-code", "dist"), { recursive: true });
    }],
    ["linked package container / plain file", "anomaly", ({ root }) => {
      const dist = join(root, "wrapper", "claude-code", "dist");
      rmSync(dist, { recursive: true });
      writeFileSync(dist, "");
    }],
    ["linked package container / dangling symlink", "anomaly", ({ root }) => {
      const dist = join(root, "wrapper", "claude-code", "dist");
      renameSync(dist, join(root, "wrapper", "claude-code", "dist-real"));
      symlinkSync("missing-dist", dist);
    }],
    ["linked package container / healthy in-bound symlink", "anomaly", ({ root }) => {
      const dist = join(root, "wrapper", "claude-code", "dist");
      renameSync(dist, join(root, "wrapper", "claude-code", "dist-real"));
      symlinkSync("dist-real", dist);
    }],

    ["linked package leaf / missing", "build", ({ root }) => {
      unlinkSync(join(root, "wrapper", "claude-code", "dist", "cli.js"));
    }],
    ["linked package leaf / directory", "anomaly", ({ root }) => {
      const leaf = join(root, "wrapper", "claude-code", "dist", "cli.js");
      unlinkSync(leaf);
      mkdirSync(leaf);
    }],
    ["linked package leaf / dangling symlink", "anomaly", ({ root }) => {
      const leaf = join(root, "wrapper", "claude-code", "dist", "cli.js");
      unlinkSync(leaf);
      symlinkSync("missing-cli.js", leaf);
    }],
    ["linked package leaf / healthy in-bound file symlink", "ok", ({ root }) => {
      const leaf = join(root, "wrapper", "claude-code", "dist", "cli.js");
      renameSync(leaf, join(dirname(leaf), "cli-real.js"));
      symlinkSync("cli-real.js", leaf);
    }],
    ["linked package leaf / healthy out-of-bound file symlink", "anomaly", ({ root, outsideRoot }) => {
      const leaf = join(root, "wrapper", "claude-code", "dist", "cli.js");
      const outside = join(outsideRoot, "outside-wrapper-cli.js");
      renameSync(leaf, outside);
      symlinkSync(outside, leaf);
    }],
  ];

  it.each(cases)("%s => %s", (_name, expected, mutate) => {
    mutate({ root, outsideRoot, runner });
    assertResult(expected);
  });
});
