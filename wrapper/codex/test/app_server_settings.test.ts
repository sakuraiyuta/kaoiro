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
