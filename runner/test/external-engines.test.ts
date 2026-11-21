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
  vi.unstubAllEnvs();
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
const broken = { ...declaration, id: "broken" };
const model = { value: "one", display_name: "One", effort_levels: ["low"] };
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
  return { root, found, config, register: found.register(base, config) };
}
const output = (raw: unknown) => "process.stdout.write(" + JSON.stringify(JSON.stringify(raw)) + ")";
const valid = fixture("sample", `
  require("node:fs").writeFileSync("argv", JSON.stringify({
    args: process.argv.slice(1), homePresent: "CODEX_HOME" in process.env
  }));
  ${output(declaration)}
`);

describe("external engine registration", () => {
  it("runs configured argv in the config directory and retains only the public catalog", async () => {
    vi.stubEnv("CODEX_HOME", "/test-only-codex-home");
    const { root, register, found } = await discover([valid]);
    expect(JSON.parse(readFileSync(join(root, "argv"), "utf8")))
      .toEqual({ args: ["fixed arg", "", "describe"], homePresent: false });
    expect(register.engines).toEqual([...(base.engines ?? []), catalog]);
    expect(register.capabilities).toEqual(["grok", "sample"]);
    expect(found.command("sample")).toEqual(valid.command);
  });

  it.each([
    ["bad command key", [{ ...valid, enabled: false }]],
    ["duplicate with an invalid first row", [{ id: "sample", command: [] }, valid]],
    ["relative executable", [{ ...valid, command: ["node", ...valid.command.slice(1)] }]],
    ...["codex", "Sample", "a".repeat(65)].map(id =>
      [id, [fixture(id, output({ ...declaration, id }))]] as const),
  ] as const)("does not execute an invalid or duplicated row (%s)", async (_, rows) => {
    const { root, found } = await discover([...rows]);
    expect(found.command(rows[0].id)).toBeUndefined();
    expect(() => readFileSync(join(root, "argv"))).toThrow();
  });

  it("registers only the first sixteen eligible engines", async () => {
    const ids = Array.from({ length: 17 }, (_, i) => "engine-" + i);
    const { found, register } = await discover(ids.map(id =>
      fixture(id, output({ ...declaration, id }))));
    expect(register.capabilities).toEqual(["grok", ...ids.slice(0, 16)]);
    expect(found.command("engine-16")).toBeUndefined();
  });

  it.each([
    ["oversize", 'process.stdout.write(' + JSON.stringify(JSON.stringify(broken).padEnd(16_385)) + ')'],
    ["nonzero exit", output(broken) + "; process.exitCode = 3"],
  ])("rejects otherwise valid describe output (%s)", async (_, script) => {
    const { register } = await discover([fixture("broken", script), valid]);
    expect(register.capabilities).toEqual(["grok", "sample"]);
  });

  it("reapplies capability selection and the byte budget on register", async () => {
    const { found, config } = await discover([valid]);
    expect(found.register(base, { ...config, capabilities: ["grok"] })).toEqual(base);
    const nearLimit = { ...base, cwd_allowlist: ["/" + "x".repeat(20_300)] };
    expect(found.register(nearLimit, config)).toEqual(nearLimit);
  });

  it("advertises a model that has no effort controls", async () => {
    const minimal = { value: "standard", display_name: "Standard" };
    const { register } = await discover([
      fixture("sample", output({ ...declaration, models: [minimal] })),
    ]);
    expect(register.engines?.find(row => row.id === "sample")?.models)
      .toEqual([minimal]);
  });

  it("distinguishes invalid UTF-8 from an execution failure", async () => {
    const write = vi.spyOn(process.stderr, "write");
    try {
      const { found, register, config } = await discover([
        fixture("broken", "process.stdout.write(Buffer.from([255]))"), valid,
      ]);
      expect(write).toHaveBeenCalledWith("runner: external engine broken unavailable: invalid_utf8\n");
      expect(register.capabilities).toEqual(["grok", "sample"]);
      const advertised = { ...base, capabilities: ["grok", "broken"] };
      expect(found.register(advertised, config).capabilities).toEqual(["grok", "sample"]);
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
    ["different id", declaration],
    ["operation version", { ...broken, operations: { version: 2, spawn: true } }],
    ["spawn false", { ...broken, operations: { version: 1, spawn: false } }],
    ["resume true", { ...broken, operations: { ...catalog.operations, resume: true } }],
    ["33 models", { ...broken, models: Array.from({ length: 33 }, (_, i) => ({ ...model, value: String(i) })) }],
    ["duplicate model", { ...broken, models: [model, model] }],
    ["257-byte model value", { ...broken, models: [{ ...model, value: "x".repeat(257) }] }],
    ["17 effort levels", { ...broken, models: [{ ...model, effort_levels: Array.from({ length: 17 }, (_, i) => String(i)) }] }],
    ["65-byte effort", { ...broken, models: [{ ...model, effort_levels: ["x".repeat(65)] }] }],
    ["duplicate effort", { ...broken, models: [{ ...model, effort_levels: ["low", "low"] }] }],
    ["undeclared default", { ...broken, models: [{ ...model, default_effort: "high" }] }],
    ["root key", { ...broken, unknown: false }],
    ["operation key", { ...broken, operations: { ...catalog.operations, unknown: false } }],
    ["model key", { ...broken, models: [{ ...catalog.models[0], description: "no" }] }],
    ["non-string default", { ...broken, models: [{
      value: "v", display_name: "v", effort_levels: ["low"], default_effort: 1,
    }] }],
    ["default alone", { ...broken, models: [{ value: "v", display_name: "v", default_effort: "x" }] }],
    ["unknown ABI", { ...broken, version: 2 }],
  ] as const)("isolates a bad declaration (%s) from a healthy sibling", async (_name, raw) => {
    const { found, register } = await discover([
      fixture("broken", output(raw)), valid,
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
  { apply_resume_snapshot: true, model: "one" },
  { apply_resume_snapshot: true, resume_snapshot: { model: "one", model_source: "other" } },
  { apply_resume_snapshot: true, resume_snapshot: { model_source: "config" } },
  { apply_resume_snapshot: true, resume_snapshot: { model: "gone" } },
  { apply_resume_snapshot: true, resume_snapshot: { sandbox: false } },
])("rejects unsupported external launch or restore data %j", payload => {
  expect(parse(payload)).toBeNull();
});
