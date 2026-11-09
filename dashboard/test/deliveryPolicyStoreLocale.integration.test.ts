import "./isolation.setup";
// @vitest-environment jsdom
// Issue #269 U2: "the save result is unconfirmed" is a state, not a wording. A
// language switch between the lost write and the failed re-read must not turn
// the warning into a plain re-read failure.
import { describe, expect, it, vi } from "vitest";
import { DeliveryPolicyError } from "../src/lib/deliveryPolicy";
import { DeliveryPolicyStore } from "../src/lib/deliveryPolicyStore.svelte";
import { en } from "../src/lib/i18n/en";
import { ja } from "../src/lib/i18n/ja";
import { setLocale, type Locale } from "../src/lib/i18n/index.svelte";
import type { KaoiroConnection } from "../src/lib/protocol";

const view = {
  policy: "on", revision: 1, applied_revision: 1, confirmed: true, pending: false,
  wrapper_support: true,
  mechanisms: { operator_early: "none", inter_agent_early: "steer", inter_agent_yield: "none" },
};

// The write times out (the outcome is unknown), the re-read is held until the
// language has been chosen, then the re-read fails.
async function lostWriteThenFailedRead(from: Locale, to: Locale) {
  setLocale(from);
  let failRead!: (error: Error) => void;
  const read = vi.fn(() => new Promise<never>((_, reject) => { failRead = reject; }));
  const write = vi.fn(async () => { throw new DeliveryPolicyError("timeout", undefined, undefined, true); });
  const connection = { getDeliveryPolicy: read, setDeliveryPolicy: write } as unknown as KaoiroConnection;
  const store = new DeliveryPolicyStore(() => ({ connection, operator: true, connected: true }));
  store.available = true;
  store.snapshot({ a: { version: "0", agent_id: "a", ts: "T", type: "state_change", state: "idle",
    ext: { delivery_policy: view } } as never });
  const pending = store.set("a", "off", true);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  const before = store.notices.a;
  setLocale(to);
  failRead(new Error("read failed"));
  await pending;
  return { before, after: store.notices.a };
}

describe("DeliveryPolicyStore notices and the language", () => {
  it("keeps the unconfirmed warning when the language stays the same", async () => {
    const ja2 = await lostWriteThenFailedRead("ja", "ja");
    expect(ja2.before).toBe(ja.deliveryPolicy.saveUnconfirmed);
    expect(ja2.after).toBe(ja.deliveryPolicy.saveUnconfirmedRefreshFailed);
    const en2 = await lostWriteThenFailedRead("en", "en");
    expect(en2.before).toBe(en.deliveryPolicy.saveUnconfirmed);
    expect(en2.after).toBe(en.deliveryPolicy.saveUnconfirmedRefreshFailed);
  });

  it("keeps the unconfirmed warning when the language is switched in between", async () => {
    const jaToEn = await lostWriteThenFailedRead("ja", "en");
    expect(jaToEn.before).toBe(ja.deliveryPolicy.saveUnconfirmed);
    expect(jaToEn.after).toBe(en.deliveryPolicy.saveUnconfirmedRefreshFailed);
    const enToJa = await lostWriteThenFailedRead("en", "ja");
    expect(enToJa.before).toBe(en.deliveryPolicy.saveUnconfirmed);
    expect(enToJa.after).toBe(ja.deliveryPolicy.saveUnconfirmedRefreshFailed);
  });

  it("a plain re-read failure stays a plain re-read failure", async () => {
    setLocale("en");
    const read = vi.fn(async () => { throw new Error("read failed"); });
    const connection = { getDeliveryPolicy: read } as unknown as KaoiroConnection;
    const store = new DeliveryPolicyStore(() => ({ connection, operator: true, connected: true }));
    store.available = true;
    store.snapshot({ a: { version: "0", agent_id: "a", ts: "T", type: "state_change", state: "idle",
      ext: { delivery_policy: view } } as never });
    await store.refresh("a");
    expect(store.notices.a).toBe(en.deliveryPolicy.refreshFailed);
  });
});
