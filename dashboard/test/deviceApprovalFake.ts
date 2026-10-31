// A stand-in for the server side of the device approval flow (issue 801).
// Every body here is written from the design's browser API table (§4.2 / §4.8)
// alone, not copied from the server's implementation or its tests; the two are
// compared when the server lands (decision D9).
import "./isolation.setup";
import { vi } from "vitest";

export interface FakeCall {
  path: string;
  method: string;
  contentType: string | null;
  body: unknown;
}

export interface FakeReply {
  status: number;
  body: unknown;
}

export const reply = (status: number, body: unknown): FakeReply => ({ status, body });

/** `issued_at` is ISO 8601 in UTC with second precision (decision D1). */
export const isoSeconds = (date = new Date()): string =>
  date.toISOString().replace(/\.\d{3}Z$/, "Z");

export const lookupOk = (overrides: Record<string, unknown> = {}): FakeReply =>
  reply(200, {
    user_code: "BCD-FGH-JKL",
    client_id: "kaoiro-client.nvim",
    issued_at: isoSeconds(),
    expires_in: 540,
    identity: { provider: "github", uid: "alice" },
    role: "operator",
    ...overrides,
  });

export const UNKNOWN_CODE = reply(404, { error: "unknown_code" });
export const EXPIRED = reply(410, { error: "expired" });
export const RATE_LIMITED = reply(429, { error: "rate_limited", retry_after: 30 });
export const OAUTH_SESSION_REQUIRED = reply(403, { error: "oauth_session_required" });
export const UNAUTHORIZED = reply(401, { error: "unauthorized" });
export const ALREADY_DECIDED = reply(409, { error: "already_decided" });
export const decisionOk = (state: "approved" | "denied"): FakeReply => reply(200, { state });

export interface DeviceFake {
  loggedIn: boolean;
  authMethods: Record<string, unknown>;
  lookup: (body: unknown) => FakeReply | Promise<FakeReply>;
  decision: (body: unknown) => FakeReply | Promise<FakeReply>;
  calls: FakeCall[];
}

export function createDeviceFake(overrides: Partial<DeviceFake> = {}): DeviceFake {
  return {
    loggedIn: true,
    authMethods: { token: true, oauth: ["github"], device: true },
    lookup: () => lookupOk(),
    decision: () => decisionOk("approved"),
    calls: [],
    ...overrides,
  };
}

const toResponse = ({ status, body }: FakeReply): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

/** Stubs the global `fetch`. A token login (`/session/new`) logs in. */
export function installDeviceFetch(fake: DeviceFake): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const path = String(input);
      const headers = new Headers(init?.headers);
      const raw = typeof init?.body === "string" ? init.body : undefined;
      fake.calls.push({
        path,
        method: init?.method ?? "GET",
        contentType: headers.get("content-type"),
        body: raw === undefined ? undefined : JSON.parse(raw),
      });
      const body = fake.calls[fake.calls.length - 1]!.body;
      if (path === "/session/ticket") {
        return toResponse(fake.loggedIn ? reply(200, { ticket: "test" }) : UNAUTHORIZED);
      }
      if (path === "/session/auth-methods") return toResponse(reply(200, fake.authMethods));
      if (path === "/session/new") {
        fake.loggedIn = true;
        return toResponse(reply(200, {}));
      }
      if (path === "/session/device/lookup") return toResponse(await fake.lookup(body));
      if (path === "/session/device/decision") return toResponse(await fake.decision(body));
      return toResponse(reply(200, {}));
    }),
  );
}
