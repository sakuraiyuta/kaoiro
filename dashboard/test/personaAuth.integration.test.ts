// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Envelope, KaoiroHandlers, PersonaManifest } from "../src/lib/protocol";
const captured = vi.hoisted(() => ({ handlers: null as KaoiroHandlers | null, disconnect: vi.fn() }));
vi.mock("../src/lib/protocol", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/protocol")>(),
  connectKaoiro: (_url: string, handlers: KaoiroHandlers) => {
    captured.handlers = handlers;
    return { disconnect: captured.disconnect, notifyOnline: vi.fn(), reconnect: vi.fn() };
  },
}));
const App = (await import("../src/App.svelte")).default;
let component: object | null;
let authenticated: boolean;
let pending: { resolve: (value: Response) => void; signal: AbortSignal }[];
let exchange: ((value: Response) => void) | undefined;
const manifest = (set = "p", version = "one"): PersonaManifest => ({ version, personas: {
  [set]: { states: { idle: { url: `/personas/${set}/idle.png?v=${version}&auth=1`, hash: version } } },
} });
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const envelope = (id = "one", set = "p", state = "idle") => ({ version: "0", agent_id: id,
  persona: { id: set, name: set, sprite_set: set }, ts: "2026-10-03T00:00:00Z",
  type: "state_change", state, payload: {},
}) as Envelope;
const settle = async () => { await tick(); await Promise.resolve(); await tick(); };
const imgs = () => [...document.querySelectorAll<HTMLImageElement>("img.portrait-sprite")];
async function start() {
  component = mount(App, { target: document.body });
  await vi.waitFor(() => expect(captured.handlers).not.toBeNull());
  captured.handlers!.onJoined?.();
  return captured.handlers!;
}
beforeEach(() => {
  component = null; authenticated = true; pending = []; exchange = undefined;
  captured.handlers = null; captured.disconnect.mockClear();
  history.replaceState(null, "", "/");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("fetch", vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/personas") return new Promise<Response>(resolve => pending.push({ resolve, signal: init!.signal as AbortSignal }));
    if (url === "/session/new") return new Promise<Response>(resolve => { exchange = resolve; });
    if (url === "/session/ticket") return Promise.resolve(response({ ticket: "test" }, authenticated ? 200 : 401));
    if (url === "/session/auth-methods") return Promise.resolve(response({ token: true, oauth: [] }));
    return Promise.resolve(response({}));
  }));
});
afterEach(async () => {
  if (component) await unmount(component);
  document.body.innerHTML = "";
  history.replaceState(null, "", "/");
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
it("default App fetches only after cookie authentication, join and first snapshot; coalesces membership", async () => {
  const h = await start();
  expect(pending).toHaveLength(0);
  h.onSnapshot({ one: envelope() }); await settle();
  expect(pending).toHaveLength(1);
  expect(fetch).toHaveBeenCalledWith("/api/personas", { credentials: "same-origin", cache: "no-store", signal: pending[0]!.signal });
  pending[0]!.resolve(response(manifest())); await settle();
  expect(imgs().length).toBeGreaterThan(0);
  h.onEnvelope(envelope("one", "p", "thinking"));
  h.onEnvelope(envelope("two")); await settle();
  expect(pending).toHaveLength(1);
  h.onEnvelope(envelope("one", "p", "disconnected")); await settle();
  expect(pending).toHaveLength(1);
  h.onAgentDeleted?.("two"); await settle();
  expect(pending).toHaveLength(2);
  expect(imgs()).toHaveLength(0);
  h.onEnvelope(envelope("three", "q"));
  h.onEnvelope(envelope("four", "r")); await settle();
  expect(pending).toHaveLength(3);
  expect(pending[1]!.signal.aborted).toBe(true);
  h.onJoined?.(); await settle();
  expect(pending[2]!.signal.aborted).toBe(true);
  expect(pending).toHaveLength(3);
  h.onSnapshot({ three: envelope("three", "q") }); await settle();
  expect(pending).toHaveLength(4);
});
it("ignores stale success even when abort does not stop fetch", async () => {
  const h = await start();
  h.onSnapshot({ one: envelope() }); await settle();
  h.onEnvelope(envelope("two", "q")); await settle();
  pending[1]!.resolve(response(manifest("q"))); await settle();
  expect(imgs().some(img => img.src.includes("/q/"))).toBe(true);
  pending[0]!.resolve(response(manifest("p", "stale"))); await settle();
  expect(imgs().some(img => img.src.includes("stale"))).toBe(false);
 });
it("ignores stale 401 even when abort does not stop fetch", async () => {
  const h = await start();
  h.onSnapshot({ one: envelope() }); await settle();
  h.onEnvelope(envelope("two", "q")); await settle();
  pending[1]!.resolve(response(manifest("q"))); await settle();
  pending[0]!.resolve(response({}, 401)); await settle();
  expect(captured.disconnect).not.toHaveBeenCalled();
  expect(imgs().some(img => img.src.includes("/q/"))).toBe(true);
});
it("refreshes for a custom persona using the default set, but not the reserved persona", async () => {
  const h = await start();
  h.onSnapshot({ one: envelope() }); await settle();
  pending[0]!.resolve(response(manifest())); await settle();
  h.onEnvelope(envelope("reserved", "default")); await settle();
  expect(pending).toHaveLength(1);
  const custom = envelope("custom", "default");
  custom.persona!.id = "custom-default-set";
  h.onEnvelope(custom); await settle();
  expect(pending).toHaveLength(2);
  pending[1]!.resolve(response(manifest("default"))); await settle();
  expect(imgs().some(img => img.src.includes("/personas/default/idle.png"))).toBe(true);
  h.onEnvelope({ ...custom, state: "thinking" }); await settle();
  expect(pending).toHaveLength(2);
  h.onEnvelope({ ...custom, state: "disconnected" }); await settle();
  expect(pending).toHaveLength(3);
  pending[2]!.resolve(response(manifest())); await settle();
  expect(imgs().some(img => img.src.includes("/personas/default/"))).toBe(false);
  h.onEnvelope(custom); await settle();
  expect(pending).toHaveLength(4);
});
it("current 401 returns to login and retries after a fresh login and snapshot", async () => {
  const h = await start(); h.onSnapshot({ one: envelope() }); await settle();
  pending[0]!.resolve(response({}, 401)); await settle();
  expect(captured.disconnect).toHaveBeenCalled();
  expect(document.querySelector('input[type="password"]')).not.toBeNull();
  expect(imgs()).toHaveLength(0);
  const input = document.querySelector<HTMLInputElement>('input[type="password"]')!;
  input.value = "v"; input.dispatchEvent(new Event("input", { bubbles: true })); await settle();
  input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await settle();
  exchange!(response({})); await settle();
  captured.handlers!.onJoined?.(); captured.handlers!.onSnapshot({ one: envelope() }); await settle();
  expect(pending).toHaveLength(2);
  pending[1]!.resolve(response(manifest())); await settle();
  expect(imgs().length).toBeGreaterThan(0);
});
it("unavailable manifest keeps the grid usable and retries on membership change", async () => {
  const h = await start(); h.onSnapshot({ one: envelope() }); await settle();
  pending[0]!.resolve(response({}, 503)); await settle();
  expect(document.querySelector('.card .face')).not.toBeNull();
  expect(captured.disconnect).not.toHaveBeenCalled();
  h.onEnvelope(envelope("one", "p", "thinking")); await settle();
  expect(pending).toHaveLength(1);
  h.onEnvelope(envelope("one", "q")); await settle();
  expect(pending).toHaveLength(2);
});
it("URL token is scrubbed immediately and cookie exchange must finish before ticket or manifest", async () => {
  history.replaceState(null, "", "/?token=secret&keep=yes");
  component = mount(App, { target: document.body }); await settle();
  expect(location.search).toBe("?keep=yes");
  expect(exchange).toBeDefined();
  expect(captured.handlers).toBeNull(); expect(pending).toHaveLength(0);
  exchange!(response({})); await settle();
  expect(captured.handlers).not.toBeNull(); expect(pending).toHaveLength(0);
  captured.handlers!.onJoined?.(); captured.handlers!.onSnapshot({ one: envelope() }); await settle();
  expect(pending).toHaveLength(1);
});
it.each([ ["logout", 200], ["logout", 401], ["unmount", 200], ["unmount", 401] ] as const)("%s aborts manifest and makes late %s inert", async (action, status) => {
  const h = await start(); h.onSnapshot({ one: envelope() }); await settle();
  pending[0]!.resolve(response(manifest())); await settle();
  expect(imgs().length).toBeGreaterThan(0);
  h.onEnvelope(envelope("two", "q")); await settle();
  if (action === "logout") {
    document.querySelector<HTMLButtonElement>("button.logout")!.click(); await settle();
  } else { await unmount(component!); component = null; }
  expect(pending[1]!.signal.aborted).toBe(true);
  const disconnects = captured.disconnect.mock.calls.length;
  pending[1]!.resolve(response(manifest("q"), status)); await settle();
  expect(captured.disconnect).toHaveBeenCalledTimes(disconnects);
  expect(imgs()).toHaveLength(0);
});
it("anonymous initial load issues neither manifest nor image requests", async () => {
  authenticated = false;
  component = mount(App, { target: document.body }); await settle();
  expect(captured.handlers).toBeNull(); expect(pending).toHaveLength(0);
  expect(imgs()).toHaveLength(0);
  expect(document.querySelector('input[type="password"]')).not.toBeNull();
});

it.each([200, 401])("late %s from a previous session cannot affect the next login", async status => {
  const h = await start(); h.onSnapshot({ one: envelope() }); await settle();
  document.querySelector<HTMLButtonElement>("button.logout")!.click(); await settle();
  const input = document.querySelector<HTMLInputElement>('input[type="password"]')!;
  input.value = "v"; input.dispatchEvent(new Event("input", { bubbles: true })); await settle();
  input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await settle();
  exchange!(response({})); await settle();
  captured.handlers!.onJoined?.(); captured.handlers!.onSnapshot({ two: envelope("two", "q") }); await settle();
  pending[1]!.resolve(response(manifest("q"))); await settle();
  const disconnects = captured.disconnect.mock.calls.length;
  pending[0]!.resolve(response(manifest("p", "stale"), status)); await settle();
  expect(captured.disconnect).toHaveBeenCalledTimes(disconnects);
  expect(imgs().some(img => img.src.includes("/q/"))).toBe(true);
  expect(imgs().some(img => img.src.includes("stale"))).toBe(false);
});
