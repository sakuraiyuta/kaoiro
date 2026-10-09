// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { DeliveryPolicyError, deliveryPolicyLabel, parseDeliveryPolicy, parseLaunchDeliveryPolicy,
  launchDeliveryDefault, type DeliveryPolicyView } from "../src/lib/deliveryPolicy";
import { DeliveryPolicyStore } from "../src/lib/deliveryPolicyStore.svelte";
import type { Envelope, KaoiroConnection } from "../src/lib/protocol";

export const modes = { operator_early: "none", inter_agent_early: "steer", inter_agent_yield: "none" } as const;
const view = (revision = 1, policy: "on" | "off" = "on"): DeliveryPolicyView => ({ policy, revision,
  applied_revision: revision, confirmed: true, pending: false, wrapper_support: true, mechanisms: modes });
const envelope = (id = "a", policy = view()): Envelope => ({ version: "0", agent_id: id, ts: "T",
  type: "state_change", state: "idle", ext: { delivery_policy: policy } });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function setup() {
  const access = { operator: true, connected: true, connection: { setDeliveryPolicy: vi.fn(), getDeliveryPolicy: vi.fn() } as unknown as KaoiroConnection };
  const store = new DeliveryPolicyStore(() => access); store.available = true;
  store.snapshot({ a: envelope(), b: envelope("b") });
  return { store, access, write: vi.mocked(access.connection.setDeliveryPolicy), read: vi.mocked(access.connection.getDeliveryPolicy) };
}

describe("delivery policy decoding and current-owner display", () => {
  it("requires exact supporting ack and never derives support from an engine", () => {
    expect(deliveryPolicyLabel(view(), true)).toBe("on（確認済み）");
    const pending = parseDeliveryPolicy({ ...view(), applied_revision: 2 });
    expect(deliveryPolicyLabel(pending, true)).toBe("確認待ち");
    expect(deliveryPolicyLabel({ ...view(), wrapper_support: false }, true)).toBe("実行中の切替は未対応");
    for (const engine of ["codex", "antigravity"]) {
      const noModes = parseDeliveryPolicy({ ...view(), engine, mechanisms: { operator_early: "none", inter_agent_early: "none", inter_agent_yield: "none" } });
      expect(deliveryPolicyLabel(noModes, true)).toBe("非対応・通常配送のみ");
    }
    expect(deliveryPolicyLabel({ ...view(2, "off"), pending: true }, true)).toContain("wrapper 確認待ち");
    expect(deliveryPolicyLabel(view(), false)).toBe("接続待ち");
    expect(parseDeliveryPolicy({ ...view(), revision: 0 }).policy).toBe("unknown");
    expect(parseDeliveryPolicy({ ...view(), policy: ["on"] }).policy).toBe("unknown");
    expect(parseDeliveryPolicy({ ...view(), mechanisms: { ...modes, operator_early: ["steer"] } }).mechanisms).toBeUndefined();
  });
  it("decodes complete metadata, exact overrides, and independent defaults fail closed", () => {
    const raw = { version: "v1", ceiling: true, mechanisms: modes,
      persona_overrides: JSON.parse('{"__proto__":{"operator_early":"fold","inter_agent_early":"fold","inter_agent_yield":"tool_boundary"}}') };
    const parsed = parseLaunchDeliveryPolicy(raw)!;
    expect(Object.hasOwn(parsed.persona_overrides!, "__proto__")).toBe(true);
    expect(parsed.mechanisms.operator_early).toBe("none");
    for (const invalid of [{ ...raw, version: "v2" }, { ...raw, ceiling: false },
      { ...raw, persona_overrides: { p: { inter_agent_early: "steer" } } },
      { ...raw, persona_overrides: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, modes])) },
      { ...raw, extra: "é".repeat(4096) }]) expect(parseLaunchDeliveryPolicy(invalid)).toBeUndefined();
    expect(launchDeliveryDefault(undefined, "codex")).toEqual({ policy: "on", source: "fallback" });
    expect(launchDeliveryDefault({ codex: false }, "codex")).toEqual({ policy: "off", source: "host" });
    expect(launchDeliveryDefault({ codex: "false" }, "codex").source).toBe("unknown");
    expect(launchDeliveryDefault(null, "codex").source).toBe("unknown");
  });
  it("keeps both exact metadata boundaries independently", () => {
    const raw = { version: "v1", ceiling: true, mechanisms: modes,
      persona_overrides: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`p${i}`, modes])), padding: "" };
    const size = () => new TextEncoder().encode(JSON.stringify(raw)).length;
    raw.padding = "x".repeat(8192 - size());
    expect(size()).toBe(8192); expect(parseLaunchDeliveryPolicy(raw)).toBeDefined();
    raw.padding += "x"; expect(size()).toBe(8193); expect(parseLaunchDeliveryPolicy(raw)).toBeUndefined();
    raw.padding = ""; raw.persona_overrides.p64 = modes;
    expect(size()).toBeLessThan(8192); expect(parseLaunchDeliveryPolicy(raw)).toBeUndefined();
  });

});

describe("policy projection and asynchronous control", () => {
  it("buffers one event per visible agent, keeps unknown live state ahead of cached envelopes and deletes", () => {
    const { store } = setup(); store.reset();
    store.event("a", view(2, "off")); store.event("outside", view());
    store.snapshot({ a: envelope() });
    expect(store.views.a?.policy).toBe("off"); expect(store.views.outside).toBeUndefined();
    store.event("a", parseDeliveryPolicy(null)); store.seed(envelope());
    expect(store.views.a?.policy).toBe("unknown");
    store.event("outsider", view()); expect(store.views.outsider).toBeUndefined();
    store.remove("a"); expect(store.views.a).toBeUndefined();
  });
  it("accepted writes stay pending behind their revision floor and allow off before ack", async () => {
    const { store, write } = setup(); write.mockResolvedValue({ revision: 2, status: "pending" });
    await store.set("a", "off", true);
    expect(store.views.a).toMatchObject({ policy: "off", revision: 2, confirmed: false, pending: true });
    store.event("a", view(1)); expect(store.views.a?.revision).toBe(2);
    store.event("a", { ...view(2), pending: true, confirmed: false });
    write.mockResolvedValue({ revision: 3, status: "pending" }); await store.set("a", "off", true);
    expect(write).toHaveBeenLastCalledWith("a", "off", 2);
  });
  it("a newer event beats a late acceptance and a read racing that event", async () => {
    const { store, write, read } = setup(); const ack = deferred<{ revision: number; status: "pending" }>();
    write.mockReturnValue(ack.promise); const pending = store.set("a", "off", true);
    store.event("a", view(3)); ack.resolve({ revision: 2, status: "pending" }); await pending;
    expect(store.views.a?.revision).toBe(3);
    const result = deferred<DeliveryPolicyView>(); read.mockReturnValue(result.promise);
    const fetching = store.refresh("a"); store.event("a", view(4, "off")); result.resolve(view(3)); await fetching;
    expect(store.views.a?.revision).toBe(4);
  });
  it("conflict refreshes without retry and lost replies remain uncertain until observed", async () => {
    const { store, write, read } = setup();
    write.mockRejectedValue(new DeliveryPolicyError("revision_conflict", 2, "off")); read.mockResolvedValue(view(2, "off"));
    await store.set("a", "off", true); expect(write).toHaveBeenCalledTimes(1);
    expect(store.notices.a).toContain("選び直してください"); expect(store.views.a?.policy).toBe("off");
    write.mockRejectedValue(new DeliveryPolicyError("timeout", undefined, undefined, true)); read.mockRejectedValue(new Error());
    await store.set("a", "on", true); expect(store.notices.a).toContain("保存結果未確認");
    store.event("a", view(3)); expect(store.notices.a).toBe("");
  });
  it("generation replacement discards old writes and accepts lower revisions; requests stay on their agent", async () => {
    const { store, write } = setup(); const ack = deferred<{ revision: number; status: "pending" }>();
    write.mockReturnValue(ack.promise); const pending = store.set("a", "off", true);
    expect(store.views.b?.policy).toBe("on");
    store.reset(); store.available = true; store.snapshot({ a: envelope() });
    ack.resolve({ revision: 9, status: "pending" }); await pending; expect(store.views.a?.revision).toBe(1);
  });
  it("role, readiness, owner and no-op guards prevent writes independently", async () => {
    const { store, write, access } = setup();
    await store.set("a", "on", true); await store.set("a", "off", false);
    access.operator = false; await store.set("a", "off", true);
    access.operator = true; store.available = false; await store.set("a", "off", true);
    expect(write).not.toHaveBeenCalled();
  });
  it("unknown event wins over a delayed successful write and removal invalidates requests", async () => {
    const { store, write } = setup(); const ack = deferred<{ revision: number; status: "pending" }>();
    write.mockReturnValue(ack.promise); const pending = store.set("a", "off", true);
    store.event("a", parseDeliveryPolicy(null)); ack.resolve({ revision: 2, status: "pending" });
    await pending; expect(store.views.a?.policy).toBe("unknown");
    store.event("a", view()); const late = deferred<{ revision: number; status: "pending" }>();
    write.mockReturnValue(late.promise); const removing = store.set("a", "off", true);
    store.remove("a"); store.seed(envelope()); late.resolve({ revision: 3, status: "pending" });
    await removing; expect(store.views.a?.revision).toBe(1);
  });
  it("bounds pre-snapshot buffering and clears only local navigation notices", () => {
    const { store } = setup(); store.reset();
    for (let i = 0; i < 201; i++) store.event(`p${i}`, view(2, "off"));
    store.snapshot(Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`p${i}`, envelope(`p${i}`)])));
    expect(store.views.p199?.policy).toBe("off"); expect(store.views.p200?.policy).toBe("on");
    store.notices.p199 = "conflict"; store.clearNotice("p199");
    expect(store.notices.p199).toBe(""); expect(store.views.p199?.policy).toBe("off");
  });

});
