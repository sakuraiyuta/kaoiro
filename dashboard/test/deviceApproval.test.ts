import "./isolation.setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureDeviceEntry,
  clearDeviceEntry,
  decideDeviceCode,
  DEVICE_STORAGE_KEY,
  formatRemainingJa,
  lookupDeviceCode,
  readStoredDeviceEntry,
  writeDeviceEntry,
  type DeviceStorage,
} from "../src/lib/deviceApproval";
import { fetchAuthMethods } from "../src/lib/protocol";
import {
  ALREADY_DECIDED,
  createDeviceFake,
  decisionOk,
  EXPIRED,
  installDeviceFetch,
  lookupOk,
  OAUTH_SESSION_REQUIRED,
  RATE_LIMITED,
  reply,
  UNAUTHORIZED,
  UNKNOWN_CODE,
} from "./deviceApprovalFake";

function memoryStorage(initial: Record<string, string> = {}): DeviceStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const refusingStorage: DeviceStorage = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
  removeItem: () => {
    throw new Error("denied");
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("captureDeviceEntry", () => {
  const at = (href: string) => ({ href: `https://kaoiro.test${href}` });

  it("starts on device=1, reads the code, persists it and removes both from the URL", () => {
    const storage = memoryStorage();
    const captured = captureDeviceEntry(at("/index.html?device=1#code=BCD-FGH-JKL"), storage);
    expect(captured.entry).toEqual({ started: true, code: "BCD-FGH-JKL" });
    expect(captured.scrubbedHref).toBe("https://kaoiro.test/index.html");
    expect(JSON.parse(storage.data.get(DEVICE_STORAGE_KEY)!)).toEqual({
      started: true,
      code: "BCD-FGH-JKL",
    });
  });

  it("starts with no code when the fragment carries none", () => {
    const storage = memoryStorage();
    const captured = captureDeviceEntry(at("/index.html?device=1"), storage);
    expect(captured.entry).toEqual({ started: true, code: null });
    expect(JSON.parse(storage.data.get(DEVICE_STORAGE_KEY)!)).toEqual({
      started: true,
      code: null,
    });
  });

  it("removes only device and the fragment: other parameters belong to their own scrubs", () => {
    const captured = captureDeviceEntry(
      at("/index.html?token=t&device=1&auth_error=x#code=BCD"),
      memoryStorage(),
    );
    expect(captured.scrubbedHref).toBe("https://kaoiro.test/index.html?token=t&auth_error=x");
  });

  it("a new start replaces what the tab held", () => {
    const storage = memoryStorage({
      [DEVICE_STORAGE_KEY]: JSON.stringify({ started: true, code: "OLD" }),
    });
    const captured = captureDeviceEntry(at("/index.html?device=1"), storage);
    expect(captured.entry).toEqual({ started: true, code: null });
    expect(JSON.parse(storage.data.get(DEVICE_STORAGE_KEY)!)).toEqual({
      started: true,
      code: null,
    });
  });

  it("without device=1 it resumes the stored state and leaves the URL alone", () => {
    const storage = memoryStorage({
      [DEVICE_STORAGE_KEY]: JSON.stringify({ started: true, code: "BCD" }),
    });
    const captured = captureDeviceEntry(at("/index.html"), storage);
    expect(captured.entry).toEqual({ started: true, code: "BCD" });
    expect(captured.scrubbedHref).toBeNull();
  });

  it("negative control: nothing stored and no device=1 is not a start, and a stray #code= is ignored", () => {
    const storage = memoryStorage();
    const captured = captureDeviceEntry(at("/index.html#code=BCD-FGH-JKL"), storage);
    expect(captured).toEqual({ entry: null, scrubbedHref: null });
    expect(storage.data.size).toBe(0);
  });

  it("device=0 and other values are not a start", () => {
    for (const value of ["0", "true", ""]) {
      const captured = captureDeviceEntry(at(`/index.html?device=${value}`), memoryStorage());
      expect(captured).toEqual({ entry: null, scrubbedHref: null });
    }
  });

  it("a storage that refuses reads and writes does not stop the start", () => {
    const captured = captureDeviceEntry(at("/index.html?device=1#code=BCD"), refusingStorage);
    expect(captured.entry).toEqual({ started: true, code: "BCD" });
    expect(captured.scrubbedHref).toBe("https://kaoiro.test/index.html");
    expect(captureDeviceEntry(at("/index.html"), refusingStorage).entry).toBeNull();
    expect(() => clearDeviceEntry(refusingStorage)).not.toThrow();
  });
});

describe("readStoredDeviceEntry", () => {
  const read = (raw: string) => readStoredDeviceEntry(memoryStorage({ [DEVICE_STORAGE_KEY]: raw }));

  it("accepts exactly started:true with a string or null code", () => {
    expect(read('{"started":true,"code":null}')).toEqual({ started: true, code: null });
    expect(read('{"started":true,"code":"BCD"}')).toEqual({ started: true, code: "BCD" });
  });

  it("rejects anything else", () => {
    for (const raw of [
      "not json",
      "null",
      "[]",
      '"started"',
      '{"started":false,"code":null}',
      '{"started":"true","code":null}',
      '{"code":"BCD"}',
      '{"started":true}',
      '{"started":true,"code":5}',
    ]) {
      expect(read(raw), raw).toBeNull();
    }
  });

  it("round trips through write and clear", () => {
    const storage = memoryStorage();
    writeDeviceEntry(storage, { started: true, code: "BCD" });
    expect(readStoredDeviceEntry(storage)).toEqual({ started: true, code: "BCD" });
    clearDeviceEntry(storage);
    expect(readStoredDeviceEntry(storage)).toBeNull();
  });
});

describe("lookupDeviceCode / decideDeviceCode", () => {
  it("lookup posts the code as typed, as JSON, and parses the answer", async () => {
    const fake = createDeviceFake({ lookup: () => lookupOk({ expires_in: 61 }) });
    installDeviceFetch(fake);
    const result = await lookupDeviceCode("bcd fgh jkl");
    expect(fake.calls).toEqual([
      {
        path: "/session/device/lookup",
        method: "POST",
        contentType: "application/json",
        body: { user_code: "bcd fgh jkl" },
      },
    ]);
    expect(result).toEqual({
      ok: true,
      value: {
        userCode: "BCD-FGH-JKL",
        clientId: "kaoiro-client.nvim",
        issuedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
        expiresIn: 61,
        identity: { provider: "github", uid: "alice" },
        role: "operator",
      },
    });
  });

  it("decision posts the code and the decision and returns the state", async () => {
    const fake = createDeviceFake({ decision: () => decisionOk("denied") });
    installDeviceFetch(fake);
    expect(await decideDeviceCode("BCD-FGH-JKL", "deny")).toEqual({ ok: true, value: "denied" });
    expect(fake.calls).toEqual([
      {
        path: "/session/device/decision",
        method: "POST",
        contentType: "application/json",
        body: { user_code: "BCD-FGH-JKL", decision: "deny" },
      },
    ]);
  });

  const failures: [string, ReturnType<typeof reply>, unknown][] = [
    ["404 unknown_code", UNKNOWN_CODE, { kind: "unknown_code" }],
    ["410 expired", EXPIRED, { kind: "expired" }],
    ["429 rate_limited", RATE_LIMITED, { kind: "rate_limited", retryAfter: 30 }],
    ["403 oauth_session_required", OAUTH_SESSION_REQUIRED, { kind: "oauth_session_required" }],
    ["401", UNAUTHORIZED, { kind: "unauthorized" }],
    ["409 already_decided", ALREADY_DECIDED, { kind: "already_decided" }],
    ["400", reply(400, { error: "invalid_request" }), { kind: "generic" }],
    ["415", reply(415, { error: "unsupported_media_type" }), { kind: "generic" }],
    ["500", reply(500, { error: "server_error" }), { kind: "generic" }],
    ["a status with the wrong error code", reply(404, { error: "nope" }), { kind: "generic" }],
    ["429 without retry_after", reply(429, { error: "rate_limited" }), { kind: "generic" }],
    ["429 with a negative retry_after", reply(429, { error: "rate_limited", retry_after: -1 }), { kind: "generic" }],
    ["403 with another code", reply(403, { error: "forbidden" }), { kind: "generic" }],
    ["a body that is not an object", reply(500, "oops"), { kind: "generic" }],
  ];

  for (const [name, answer, kind] of failures) {
    it(`both calls map ${name}`, async () => {
      installDeviceFetch(createDeviceFake({ lookup: () => answer, decision: () => answer }));
      expect(await lookupDeviceCode("x")).toEqual({ ok: false, error: kind });
      expect(await decideDeviceCode("x", "approve")).toEqual({ ok: false, error: kind });
    });
  }

  it("a request that fails to complete is a generic error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    expect(await lookupDeviceCode("x")).toEqual({ ok: false, error: { kind: "generic" } });
    expect(await decideDeviceCode("x", "approve")).toEqual({ ok: false, error: { kind: "generic" } });
  });

  it("a 200 whose body cannot be read as the contract is a generic error", async () => {
    const bad: unknown[] = [
      null,
      "text",
      {},
      { user_code: "X" },
      { ...(lookupOk().body as object), expires_in: "540" },
      { ...(lookupOk().body as object), expires_in: null },
      { ...(lookupOk().body as object), identity: null },
      { ...(lookupOk().body as object), identity: { provider: "github" } },
      { ...(lookupOk().body as object), role: 1 },
      { ...(lookupOk().body as object), client_id: undefined },
      { ...(lookupOk().body as object), issued_at: 1793000000 },
    ];
    for (const body of bad) {
      installDeviceFetch(createDeviceFake({ lookup: () => reply(200, body) }));
      expect(await lookupDeviceCode("x"), JSON.stringify(body)).toEqual({
        ok: false,
        error: { kind: "generic" },
      });
    }
    installDeviceFetch(createDeviceFake({ decision: () => reply(200, { state: 1 }) }));
    expect(await decideDeviceCode("x", "approve")).toEqual({ ok: false, error: { kind: "generic" } });
  });
});

describe("fetchAuthMethods device flag", () => {
  const serve = (body: unknown) =>
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => body }) as Response));

  it("passes a boolean device flag through and tolerates its absence", async () => {
    serve({ token: true, oauth: ["github"], device: false });
    expect(await fetchAuthMethods()).toEqual({ token: true, oauth: ["github"], device: false });
    serve({ token: true, oauth: [] });
    expect(await fetchAuthMethods()).toEqual({ token: true, oauth: [] });
  });

  it("a device flag that is not a boolean is a malformed body", async () => {
    serve({ token: true, oauth: [], device: "yes" });
    expect(await fetchAuthMethods()).toBeNull();
  });
});

describe("formatRemainingJa", () => {
  it("formats seconds, minutes and the floor at zero", () => {
    expect(formatRemainingJa(540)).toBe("9 分 0 秒");
    expect(formatRemainingJa(61)).toBe("1 分 1 秒");
    expect(formatRemainingJa(59.9)).toBe("59 秒");
    expect(formatRemainingJa(-5)).toBe("0 秒");
  });
});
