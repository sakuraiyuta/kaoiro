// Device authorization approval (issue 801, design §4.3): the entry state kept
// per tab across the OAuth round trip, and the two browser API calls the
// approval view makes. The view itself is DeviceApproval.svelte. Plain TS with
// no dependency on the rest of the dashboard.

/** sessionStorage key for the "device approval started" state. */
export const DEVICE_STORAGE_KEY = "kaoiro:device";

export interface DeviceEntry {
  started: true;
  /** What the operator typed or the verification URI carried, un-normalized. */
  code: string | null;
}

/** The subset of `Storage` this module uses, so a test can pass a double. */
export type DeviceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readStoredDeviceEntry(storage: DeviceStorage): DeviceEntry | null {
  try {
    const raw = storage.getItem(DEVICE_STORAGE_KEY);
    if (raw === null) return null;
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null) return null;
    const { started, code } = value as { started?: unknown; code?: unknown };
    if (started !== true) return null;
    if (code !== null && typeof code !== "string") return null;
    return { started: true, code };
  } catch {
    return null;
  }
}

// A storage that refuses writes (private mode, quota) only costs the OAuth
// round trip its memory; it must not stop the dashboard from starting.
export function writeDeviceEntry(storage: DeviceStorage, entry: DeviceEntry): void {
  try {
    storage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // see above
  }
}

export function clearDeviceEntry(storage: DeviceStorage): void {
  try {
    storage.removeItem(DEVICE_STORAGE_KEY);
  } catch {
    // see above
  }
}

export interface CapturedDeviceEntry {
  entry: DeviceEntry | null;
  /** Where to `history.replaceState` so the code leaves the URL and history;
   *  null when the URL carried nothing to remove. */
  scrubbedHref: string | null;
}

/**
 * The startup step (design §4.3, steps 1-2). A `device=1` query starts the
 * flow and its `#code=` fragment is read; either replaces what the tab already
 * held. Without `device=1` the stored state from before an OAuth round trip is
 * used as is, and a stray `#code=` is ignored. Only `device` and the fragment
 * are removed from the URL (decision D7): other parameters belong to their own
 * scrubs.
 */
export function captureDeviceEntry(
  location: Pick<Location, "href">,
  storage: DeviceStorage,
): CapturedDeviceEntry {
  const url = new URL(location.href);
  if (url.searchParams.get("device") !== "1") {
    return { entry: readStoredDeviceEntry(storage), scrubbedHref: null };
  }
  const code = new URLSearchParams(url.hash.slice(1)).get("code");
  const entry: DeviceEntry = { started: true, code };
  writeDeviceEntry(storage, entry);
  url.searchParams.delete("device");
  url.hash = "";
  return { entry, scrubbedHref: url.href };
}

export interface DeviceLookup {
  /** Normalized by the server. */
  userCode: string;
  /** The client's own claim about itself; not a basis for trust. */
  clientId: string;
  issuedAt: string;
  /** Seconds left, as of the response. */
  expiresIn: number;
  identity: { provider: string; uid: string };
  role: string;
}

export type DeviceErrorKind =
  | "unknown_code"
  | "expired"
  | "rate_limited"
  | "already_decided"
  // 401: the session ended; 403: a shared-token session, which cannot approve.
  | "unauthorized"
  | "oauth_session_required"
  // `auth-methods` said this server does not offer device approval.
  | "unavailable"
  | "generic";

export interface DeviceError {
  kind: DeviceErrorKind;
  /** Seconds, for `rate_limited`. */
  retryAfter?: number;
}

export type DeviceResult<T> = { ok: true; value: T } | { ok: false; error: DeviceError };

const GENERIC: DeviceResult<never> = { ok: false, error: { kind: "generic" } };

async function post(path: string, body: unknown): Promise<Response | null> {
  try {
    return await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = (await res.json()) as unknown;
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// The status and `error` code of a non-2xx answer (design §4.2 / §4.8).
async function failure(res: Response): Promise<DeviceResult<never>> {
  const body = await readJson(res);
  const code = body !== null && typeof body.error === "string" ? body.error : null;
  switch (res.status) {
    case 401:
      return { ok: false, error: { kind: "unauthorized" } };
    case 403:
      return code === "oauth_session_required"
        ? { ok: false, error: { kind: "oauth_session_required" } }
        : GENERIC;
    case 404:
      return code === "unknown_code" ? { ok: false, error: { kind: "unknown_code" } } : GENERIC;
    case 409:
      return code === "already_decided"
        ? { ok: false, error: { kind: "already_decided" } }
        : GENERIC;
    case 410:
      return code === "expired" ? { ok: false, error: { kind: "expired" } } : GENERIC;
    case 429: {
      const retryAfter = body?.retry_after;
      return code === "rate_limited" && typeof retryAfter === "number" && retryAfter >= 0
        ? { ok: false, error: { kind: "rate_limited", retryAfter } }
        : GENERIC;
    }
    default:
      return GENERIC;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseLookup(body: Record<string, unknown>): DeviceLookup | null {
  const { user_code, client_id, issued_at, expires_in, identity, role } = body;
  if (
    typeof user_code !== "string" ||
    typeof client_id !== "string" ||
    typeof issued_at !== "string" ||
    typeof expires_in !== "number" ||
    !Number.isFinite(expires_in) ||
    !isRecord(identity) ||
    typeof identity.provider !== "string" ||
    typeof identity.uid !== "string" ||
    typeof role !== "string"
  ) {
    return null;
  }
  return {
    userCode: user_code,
    clientId: client_id,
    issuedAt: issued_at,
    expiresIn: expires_in,
    identity: { provider: identity.provider, uid: identity.uid },
    role,
  };
}

/** `POST /session/device/lookup`. The code goes as typed; the server
 *  normalizes it. */
export async function lookupDeviceCode(userCode: string): Promise<DeviceResult<DeviceLookup>> {
  const res = await post("/session/device/lookup", { user_code: userCode });
  if (res === null) return GENERIC;
  if (!res.ok) return failure(res);
  const body = await readJson(res);
  const info = body === null ? null : parseLookup(body);
  return info === null ? GENERIC : { ok: true, value: info };
}

export type DeviceDecision = "approve" | "deny";

/** `POST /session/device/decision`. Resolves to the new state name. */
export async function decideDeviceCode(
  userCode: string,
  decision: DeviceDecision,
): Promise<DeviceResult<string>> {
  const res = await post("/session/device/decision", { user_code: userCode, decision });
  if (res === null) return GENERIC;
  if (!res.ok) return failure(res);
  const body = await readJson(res);
  return body !== null && typeof body.state === "string"
    ? { ok: true, value: body.state }
    : GENERIC;
}

/** 「N 分 M 秒」 for a remaining time in seconds. */
export function formatRemainingJa(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return minutes === 0 ? `${rest} 秒` : `${minutes} 分 ${rest} 秒`;
}
