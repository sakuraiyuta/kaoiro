import { expect, it, vi } from "vitest";
import { appServerTurnSettings } from "../src/app_server_settings.js";
import { AppServerConnectionError, AppServerRpcError } from "../src/app_server_rpc.js";

it("samples changed config on every reset and preserves an explicit effort without reading defaults", async () => {
  const request = vi.fn().mockResolvedValueOnce({ config: { model_reasoning_effort: "medium" } })
    .mockResolvedValueOnce({ config: { model_reasoning_effort: "low" } });
  const settings = { model: "target", resetEffort: true };
  expect(await appServerTurnSettings(settings, request)).toEqual({ model: "target", effort: "medium" });
  expect(await appServerTurnSettings(settings, request)).toEqual({ model: "target", effort: "low" });
  expect(await appServerTurnSettings({ model: "target", effort: "high" }, request)).toEqual({ model: "target", effort: "high" });
  expect(request).toHaveBeenCalledTimes(2);
});

it("uses the target model from later catalog pages, not the current or default model", async () => {
  const request = vi.fn().mockResolvedValueOnce({ config: {} })
    .mockResolvedValueOnce({ data: [{ model: "current", defaultReasoningEffort: "high" }], nextCursor: "page-2" })
    .mockResolvedValueOnce({ data: [{ model: "target", defaultReasoningEffort: "low" }], nextCursor: null });
  expect(await appServerTurnSettings({ model: "target", resetEffort: true }, request)).toEqual({ model: "target", effort: "low" });
  expect(request).toHaveBeenLastCalledWith("model/list", { includeHidden: true, cursor: "page-2" });
});

it.each([
  [{ config: null }], [{ config: { model_reasoning_effort: 1 } }], [{ config: { model_reasoning_effort: "" } }],
  [{ config: {} }, { data: [], nextCursor: null }],
  [{ config: {} }, { data: [{ model: "target" }], nextCursor: null }],
  [{ config: {} }, { data: null }],
  [{ config: {} }, { data: [], nextCursor: "loop" }, { data: [], nextCursor: "loop" }],
].map(responses => ({ responses })))("rejects unavailable or malformed defaults without inventing an effort (%j)", async ({ responses }) => {
  let index = 0;
  const request = vi.fn(async () => responses[index++]);
  await expect(appServerTurnSettings({ model: "target", resetEffort: true }, request)).rejects.toMatchObject({ reason: "default_effort_unavailable" });
  expect(request).toHaveBeenCalledTimes(responses.length);
});

it("bounds a catalog whose cursor never ends", async () => {
  let pages = 0;
  const request = vi.fn(async method => method === "config/read" ? { config: {} } : { data: [], nextCursor: String(++pages) });
  await expect(appServerTurnSettings({ model: "target", resetEffort: true }, request)).rejects.toMatchObject({ reason: "default_effort_unavailable" });
  expect(pages).toBe(100);
});

it("uses a closed reason for RPC rejection but preserves connection failures", async () => {
  const request = vi.fn().mockRejectedValueOnce(new AppServerRpcError(-32600, "private vendor message"));
  await expect(appServerTurnSettings({ model: "target", resetEffort: true }, request)).rejects.toMatchObject({ message: "App-server settings rejected: default_effort_unavailable" });
  const failure = new AppServerConnectionError("closed");request.mockRejectedValueOnce(failure);
  await expect(appServerTurnSettings({ model: "target", resetEffort: true }, request)).rejects.toBe(failure);
});

it.each([
  { permission: null }, { effort: null }, { effort: "" }, { model: "" }, { cwd: "relative" }, { resetEffort: true },
  { model: "target", effort: "high", resetEffort: true }, { resetEffort: "yes" },
  { permission: { sandbox: "future", networkAccess: false } },
  { permission: { sandbox: "workspace-write", networkAccess: "yes" } },
])("rejects invalid settings before any RPC (%j)", async settings => {
  const request = vi.fn();
  await expect(appServerTurnSettings(settings as never, request)).rejects.toMatchObject({ reason: "invalid_settings" });
  expect(request).not.toHaveBeenCalled();
});

it.each([
  ["read-only", true, { type: "readOnly", networkAccess: false }],
  ["workspace-write", true, { type: "workspaceWrite", networkAccess: true }],
  ["danger-full-access", false, { type: "dangerFullAccess" }],
] as const)("maps %s without widening its effective network policy", async (sandbox, networkAccess, sandboxPolicy) => {
  expect(await appServerTurnSettings({ permission: { sandbox, networkAccess } }, vi.fn())).toEqual({ sandboxPolicy });
});

it("keeps explicit intent across model changes and resolves only reset or default intent", async () => {
  const { appServerSettingsForAttempt: prepare, appServerSettingsAfterSuccess: commit, successfulResetEffort } = await import("../src/app_server_settings.js");
  const baseline = { model: "old", effort: "high", effortIntent: "explicit" as const };
  const pending = { model: "new", effort: null, effortReset: false };
  expect(prepare(baseline, pending)).toEqual({ model: "new", effort: "high" });
  expect(prepare(baseline, { ...pending, effort: "medium", effortReset: true })).toEqual({ model: "new", effort: "medium" });
  expect(prepare(baseline, { ...pending, effortReset: true })).toEqual({ model: "new", resetEffort: true });
  expect(prepare({ ...baseline, effortIntent: "default" }, pending)).toEqual({ model: "new", resetEffort: true });
  expect(prepare({ ...baseline, effortIntent: "default" }, { ...pending, model: null })).toEqual({});
  expect(commit(baseline, pending, { model: "new", effort: "high" })).toEqual({ ...baseline, model: "new" });
  expect(commit(baseline, { ...pending, effortReset: true }, { model: "new", effort: "medium" })).toEqual({ model: "new", effort: "medium", effortIntent: "default" });
  expect(successfulResetEffort("medium", "low")).toBe("medium");
  expect(successfulResetEffort(undefined, "low")).toBe("low");
  expect(successfulResetEffort(undefined, null)).toBeNull();
});

it("resends the successful baseline on rollback and resamples default intent", async () => {
  const { appServerSettingsForAttempt: prepare, appServerSettingsAfterSuccess: commit } = await import("../src/app_server_settings.js");
  const baseline = { model: "good", effort: "high", effortIntent: "explicit" as const };
  const pending = { model: null, effort: null, effortReset: false };
  expect(prepare(baseline, pending, true)).toEqual({ model: "good", effort: "high" });
  const defaults = { ...baseline, effortIntent: "default" as const };
  expect(prepare(defaults, pending, true)).toEqual({ model: "good", resetEffort: true });
  expect(commit(defaults, pending, { model: "good", effort: "medium" }, true)).toEqual({ ...defaults, effort: "medium" });
  for (const unknown of [null, { ...baseline, model: "" }, { ...baseline, effort: null }]) {
    expect(() => prepare(unknown, pending, true)).toThrow(expect.objectContaining({ reason: "default_effort_unavailable" }));
  }
  expect(() => commit(defaults, { ...pending, model: "new" }, {})).toThrow(expect.objectContaining({ reason: "default_effort_unavailable" }));
});
