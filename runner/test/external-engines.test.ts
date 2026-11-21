import "../../scripts/test/fixtures/test-isolation.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineCatalogEntry, RunnerRegister } from "@kaoiro/protocol";
import { ExternalEngines } from "../src/external-engines.js";
import { parseSpawn } from "../src/supervisor.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const base: RunnerRegister = {
  version: "0", host_id: "host", cwd_allowlist: [], capabilities: ["grok"],
  engines: [{ id: "grok", models: [] }],
};
const catalog: EngineCatalogEntry = {
  id: "sample", models: [{ value: "one", display_name: "One", effort_levels: ["low"] }],
  operations: { version: 1, spawn: true },
};
const declaration = { version: 1, ...catalog };
const fixture = (id: string, script: string) => ({
  id, command: [process.execPath, "-e", script, "fixed arg", ""],
});
async function discover(rows: unknown[], capabilities?: string[]) {
  const root = mkdtempSync(join(tmpdir(), "external engine "));
  roots.push(root);
  const config = { host_id: "host", server_url: "ws://localhost", cwd_allowlist: [],
    external_engines: rows, ...(capabilities && { capabilities }) };
  const found = await ExternalEngines.discover(config, join(root, "runner.json"),
    new AbortController().signal);
  return { root, found, register: found.register(base, config) };
}
const output = (raw: unknown) => "process.stdout.write(" + JSON.stringify(JSON.stringify(raw)) + ")";
const valid = fixture("sample", `
  require("node:fs").writeFileSync("argv", JSON.stringify(process.argv.slice(1)));
  ${output(declaration)}
`);

describe("external engine registration", () => {
  it("runs configured argv in the config directory and retains only the public catalog", async () => {
    const { root, register, found } = await discover([valid]);
    expect(JSON.parse(readFileSync(join(root, "argv"), "utf8")))
      .toEqual(["fixed arg", "", "describe"]);
    expect(register.engines).toEqual([...(base.engines ?? []), catalog]);
    expect(register.capabilities).toEqual(["grok", "sample"]);
    expect(found.command("sample")).toEqual(valid.command);
  });

  it.each([
    ["bad command key", { ...valid, enabled: false }],
    ["duplicate with an invalid first row", { id: "sample", command: [] }],
  ])("does not execute an invalid or duplicated ID (%s)", async (label, other) => {
    const rows = label === "bad command key" ? [other] : [other, valid];
    const { root, found } = await discover(rows);
    expect(found.command("sample")).toBeUndefined();
    expect(() => readFileSync(join(root, "argv"))).toThrow();
  });

  it("distinguishes invalid UTF-8 from an execution failure", async () => {
    const write = vi.spyOn(process.stderr, "write");
    try {
      const { register } = await discover([
        fixture("broken", "process.stdout.write(Buffer.from([255]))"), valid,
      ]);
      expect(write).toHaveBeenCalledWith("runner: external engine broken unavailable: invalid_utf8\n");
      expect(register.capabilities).toEqual(["grok", "sample"]);
    } finally {
      write.mockRestore();
    }
  });

  it("skips an unselected external command before discovery", async () => {
    const { root, found } = await discover([valid], ["claude-code"]);
    expect(found.needsRestart(["sample"])).toBe(true);
    expect(found.command("sample")).toBeUndefined();
    expect(() => readFileSync(join(root, "argv"))).toThrow();
  });

  it.each([
    ["root key", { ...declaration, unknown: false }],
    ["operation key", { ...declaration, operations: { ...catalog.operations, unknown: false } }],
    ["model key", { ...declaration, models: [{ ...catalog.models[0], description: "no" }] }],
    ["non-string default", { ...declaration, models: [{
      value: "v", display_name: "v", effort_levels: ["low"], default_effort: 1,
    }] }],
    ["default alone", { ...declaration, models: [{ value: "v", display_name: "v", default_effort: "x" }] }],
    ["unknown ABI", { ...declaration, version: 2 }],
  ])("isolates a bad declaration (%s) from a healthy sibling", async (_name, raw) => {
    const { found, register } = await discover([
      fixture("broken", output({ ...raw, id: "broken" })), valid,
    ]);
    expect(found.command("broken")).toBeUndefined();
    expect(register.capabilities).toEqual(["grok", "sample"]);
  });
});

const spawn = {
  agent_id: "host.one", cwd: "/work", engine: "sample",
  persona: { id: "p", name: "P", sprite_set: "p" }, request_id: "restore",
};
const parse = (extra: object) => parseSpawn({ ...spawn, ...extra }, () => catalog);
it("restores a fresh external session with catalog-validated source pairs", () => {
  expect(parse({ apply_resume_snapshot: true, resume_snapshot: {
    model: "one", model_source: "env", effort: "low",
  } })).toMatchObject({ engine: "sample", requestId: "restore", model: "one",
    modelSource: "env", effort: "low", effortSource: "config" });
  expect(parse({ apply_resume_snapshot: true })).not.toBeNull();
  expect(parse({ apply_resume_snapshot: true, resume_snapshot: {
    model: "former-default", model_source: "default",
  } })).not.toHaveProperty("model");
});
it.each([
  { resume_session_id: "sid" }, { resume_snapshot: {} }, { sandbox: null },
  { permission_mode: "default" }, { approval: false }, { network_access: false },
  { model: "gone" }, { model: "one", effort: "gone" }, { effort: "low" },
  { apply_resume_snapshot: true, resume_snapshot: { model_source: "config" } },
  { apply_resume_snapshot: true, resume_snapshot: { model: "gone" } },
  { apply_resume_snapshot: true, resume_snapshot: { sandbox: false } },
])("rejects unsupported external launch or restore data %j", payload => {
  expect(parse(payload)).toBeNull();
});
