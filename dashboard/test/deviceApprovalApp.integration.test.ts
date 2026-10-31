import "./isolation.setup";
// @vitest-environment jsdom
// The device approval view inside the real App (issue 801, design §4.3 / §6.4):
// the entry paths (a)-(f), what `confirm` shows, and the way out of each error.
import { mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KaoiroHandlers } from "../src/lib/protocol";
import { DEVICE_STORAGE_KEY } from "../src/lib/deviceApproval";
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
  type DeviceFake,
  type FakeReply,
} from "./deviceApprovalFake";

vi.mock("../src/lib/protocol", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/protocol")>()),
  connectKaoiro: (_url: string, _handlers: KaoiroHandlers) => ({
    disconnect: vi.fn(),
    notifyOnline: vi.fn(),
    reconnect: vi.fn(),
  }),
}));
const App = (await import("../src/App.svelte")).default;

// jsdom does not implement HTMLDialogElement.showModal (see
// modal.integration.test.ts); the real focus trap and Escape are the browser's.
if (typeof HTMLDialogElement.prototype.showModal !== "function") {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}

const CODE = "BCD-FGH-JKL";
let component: object | null;
let fake: DeviceFake;

beforeEach(() => {
  component = null;
  sessionStorage.clear();
  history.replaceState(null, "", "/");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  // An anchor click that jsdom would turn into a navigation is only observed.
  document.addEventListener("click", preventNavigation);
  fake = createDeviceFake();
  installDeviceFetch(fake);
});

afterEach(async () => {
  document.removeEventListener("click", preventNavigation);
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  sessionStorage.clear();
  history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function preventNavigation(event: Event): void {
  event.preventDefault();
}

async function start(url: string): Promise<void> {
  if (component) await unmount(component);
  document.body.innerHTML = "";
  history.replaceState(null, "", url);
  component = mount(App, { target: document.body });
  // Past the first auth check: the login card or the dashboard is showing.
  await vi.waitFor(() => expect(document.querySelector(".login-card, header .brand")).not.toBeNull());
}

const dialog = (): HTMLDialogElement | null => document.querySelector("dialog[open]");
const dialogText = (): string => dialog()?.textContent?.replace(/\s+/g, " ") ?? "";
const codeInput = (): HTMLInputElement | null => document.querySelector("#device-user-code");
const stored = (): unknown => {
  const raw = sessionStorage.getItem(DEVICE_STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw);
};
const calls = (path: string) => fake.calls.filter((c) => c.path === path);

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no button "${label}" in: ${dialogText()}`);
  return found;
}

async function typeCode(value: string): Promise<void> {
  const input = codeInput()!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.waitFor(() => expect(button("確認").disabled).toBe(value.trim() === ""));
}

async function submitCode(value: string): Promise<void> {
  await typeCode(value);
  button("確認").form!.requestSubmit();
}

const login = async (): Promise<void> => {
  fake.loggedIn = true;
};

/** The OAuth round trip: the page leaves and comes back as a bare /index.html. */
async function returnFromOAuth(): Promise<void> {
  await login();
  await start("/index.html");
}

describe("entry paths", () => {
  it("(a) logged in + typed code: opens on an empty entry, then confirm", async () => {
    await start("/index.html?device=1");
    await vi.waitFor(() => expect(codeInput()).not.toBeNull());
    expect(codeInput()!.value).toBe("");
    await submitCode(CODE);
    await vi.waitFor(() => expect(dialogText()).toContain("承認する identity"));
    expect(calls("/session/device/lookup")).toEqual([
      expect.objectContaining({ method: "POST", contentType: "application/json", body: { user_code: CODE } }),
    ]);
  });

  it("(b) logged in + complete URI: the code is prefilled and confirm is still shown", async () => {
    await start(`/index.html?device=1#code=${CODE}`);
    await vi.waitFor(() => expect(codeInput()?.value).toBe(CODE));
    expect(calls("/session/device/lookup")).toHaveLength(0);
    button("確認").form!.requestSubmit();
    await vi.waitFor(() => expect(dialogText()).toContain("承認する identity"));
  });

  it("(c) logged out + complete URI -> OAuth -> a prefilled entry", async () => {
    fake.loggedIn = false;
    await start(`/index.html?device=1#code=${CODE}`);
    expect(document.querySelector("[data-device-login]")).not.toBeNull();
    expect(dialog()).toBeNull();
    // Before leaving for OAuth the state is saved.
    expect(stored()).toEqual({ started: true, code: CODE });

    await returnFromOAuth();
    await vi.waitFor(() => expect(codeInput()?.value).toBe(CODE));
    expect(document.querySelector("[data-device-login]")).toBeNull();
    button("確認").form!.requestSubmit();
    await vi.waitFor(() => expect(dialogText()).toContain("承認する identity"));
  });

  it("(d) logged out + /device with no code -> OAuth -> an empty entry -> typed -> confirm", async () => {
    fake.loggedIn = false;
    await start("/index.html?device=1");
    expect(document.querySelector("[data-device-login]")).not.toBeNull();
    expect(stored()).toEqual({ started: true, code: null });

    await returnFromOAuth();
    await vi.waitFor(() => expect(codeInput()).not.toBeNull());
    expect(codeInput()!.value).toBe("");
    await submitCode(CODE);
    await vi.waitFor(() => expect(dialogText()).toContain("承認する identity"));
  });

  it("(d') a token login on the login card also reaches the entry", async () => {
    fake.loggedIn = false;
    await start("/index.html?device=1");
    const token = document.querySelector<HTMLInputElement>('input[type="password"]')!;
    token.value = "secret";
    token.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>(".login-card button[type=submit]")!.disabled).toBe(false));
    document.querySelector<HTMLFormElement>(".login-card")!.requestSubmit();
    await vi.waitFor(() => expect(codeInput()).not.toBeNull());
    expect(stored()).toBeNull();
  });

  it("(e) negative control: an ordinary start shows no device view, even with a stray #code=", async () => {
    await start("/");
    expect(dialog()).toBeNull();
    expect(document.querySelector("[data-device-login]")).toBeNull();
    expect(stored()).toBeNull();

    await start(`/index.html#code=${CODE}`);
    expect(dialog()).toBeNull();
    expect(location.hash).toBe(`#code=${CODE}`);
    expect(stored()).toBeNull();

    fake.loggedIn = false;
    await start("/");
    expect(document.querySelector("[data-device-login]")).toBeNull();
  });

  it("(f) the URL is scrubbed at once; storage is kept until the entry is reached, then removed", async () => {
    fake.loggedIn = false;
    await start(`/index.html?device=1#code=${CODE}`);
    expect(location.search).toBe("");
    expect(location.hash).toBe("");
    expect(stored()).toEqual({ started: true, code: CODE });

    await returnFromOAuth();
    await vi.waitFor(() => expect(codeInput()).not.toBeNull());
    expect(stored()).toBeNull();
  });

  it("(f') a logged-in start scrubs the URL and leaves nothing in storage", async () => {
    await start(`/index.html?device=1&keep=1#code=${CODE}`);
    await vi.waitFor(() => expect(codeInput()).not.toBeNull());
    expect(location.search).toBe("?keep=1");
    expect(location.hash).toBe("");
    expect(stored()).toBeNull();
  });
});

describe("confirm", () => {
  async function toConfirm(answer: FakeReply = lookupOk()): Promise<void> {
    fake.lookup = () => answer;
    await start(`/index.html?device=1#code=${CODE}`);
    await vi.waitFor(() => expect(codeInput()?.value).toBe(CODE));
    button("確認").form!.requestSubmit();
    await vi.waitFor(() => expect(dialogText()).toContain("承認する identity"));
  }

  it("shows the normalized code, the client's own claim, the time, the identity and role, and the cross-check advice", async () => {
    await toConfirm(lookupOk({ user_code: CODE, client_id: "some-client", expires_in: 540 }));
    const text = dialogText();
    expect(text).toContain(CODE);
    expect(text).toContain("some-client");
    expect(text).toContain("client の自己申告");
    expect(text).toContain("たった今");
    expect(text).toContain("9 分 0 秒");
    expect(text).toContain("github / alice");
    expect(text).toContain("operator");
    expect(text).toContain("この identity と role で device が接続する");
    expect(text).toContain("device に表示された code と一致することを確かめる");
    expect(text).toContain("自分が今始めた login でなければ拒否する");
    expect(button("承認")).toBeTruthy();
    expect(button("拒否")).toBeTruthy();
  });

  it("omits the issue time when it cannot be read, and shows another role as given", async () => {
    await toConfirm(lookupOk({ issued_at: "garbage", role: "viewer" }));
    expect(dialogText()).not.toContain("発行");
    expect(dialogText()).toContain("viewer");
  });

  it("approve sends the server's normalized code and shows the result", async () => {
    await toConfirm();
    fake.decision = () => decisionOk("approved");
    button("承認").click();
    await vi.waitFor(() => expect(dialogText()).toContain("承認した"));
    expect(calls("/session/device/decision")).toEqual([
      expect.objectContaining({
        method: "POST",
        contentType: "application/json",
        body: { user_code: CODE, decision: "approve" },
      }),
    ]);
    expect(dialogText()).toContain("数秒で接続する");
  });

  it("a code typed loosely is looked up as typed, and the decision uses the server's normalized form", async () => {
    fake.lookup = () => lookupOk({ user_code: CODE });
    await start("/index.html?device=1");
    await vi.waitFor(() => expect(codeInput()).not.toBeNull());
    await submitCode("  bcd fgh jkl ");
    await vi.waitFor(() => expect(dialogText()).toContain("承認する identity"));
    expect(calls("/session/device/lookup")[0]!.body).toEqual({ user_code: "bcd fgh jkl" });
    button("承認").click();
    await vi.waitFor(() => expect(dialogText()).toContain("承認した"));
    expect(calls("/session/device/decision")[0]!.body).toEqual({ user_code: CODE, decision: "approve" });
  });

  it("deny sends deny", async () => {
    await toConfirm();
    fake.decision = () => decisionOk("denied");
    button("拒否").click();
    await vi.waitFor(() => expect(dialogText()).toContain("拒否した"));
    expect(calls("/session/device/decision")[0]!.body).toEqual({ user_code: CODE, decision: "deny" });
  });

  it("done closes into the ordinary dashboard and the flow is over", async () => {
    await toConfirm();
    button("承認").click();
    await vi.waitFor(() => expect(dialogText()).toContain("承認した"));
    button("閉じる").click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(stored()).toBeNull();
  });

  it("while a decision is in flight the dialog cannot be closed; once answered it can", async () => {
    await toConfirm();
    let release!: (value: FakeReply) => void;
    fake.decision = () => new Promise<FakeReply>((resolve) => (release = resolve));
    button("承認").click();
    await vi.waitFor(() => expect(calls("/session/device/decision")).toHaveLength(1));
    expect(button("承認").disabled).toBe(true);
    expect(button("拒否").disabled).toBe(true);
    dialog()!.dispatchEvent(new Event("cancel", { cancelable: true }));
    dialog()!.click();
    document.querySelector<HTMLButtonElement>("dialog .close")!.click();
    await Promise.resolve();
    expect(dialog()).not.toBeNull();
    expect(calls("/session/device/decision")).toHaveLength(1);

    release(decisionOk("approved"));
    await vi.waitFor(() => expect(dialogText()).toContain("承認した"));
    dialog()!.dispatchEvent(new Event("cancel", { cancelable: true }));
    await vi.waitFor(() => expect(dialog()).toBeNull());
  });
});

describe("closing", () => {
  it("Escape and the backdrop close the view and drop the started state", async () => {
    await start("/index.html?device=1");
    await vi.waitFor(() => expect(codeInput()).not.toBeNull());
    dialog()!.dispatchEvent(new Event("cancel", { cancelable: true }));
    await vi.waitFor(() => expect(dialog()).toBeNull());

    await start("/index.html?device=1");
    await vi.waitFor(() => expect(codeInput()).not.toBeNull());
    dialog()!.click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(stored()).toBeNull();
  });

  it("an empty or blank code cannot be submitted", async () => {
    await start("/index.html?device=1");
    await vi.waitFor(() => expect(codeInput()).not.toBeNull());
    await typeCode("   ");
    button("確認").form!.requestSubmit();
    await Promise.resolve();
    expect(calls("/session/device/lookup")).toHaveLength(0);
  });
});

describe("errors", () => {
  async function toError(answer: FakeReply, via: "lookup" | "decision" = "lookup"): Promise<void> {
    fake.lookup = () => (via === "lookup" ? answer : lookupOk());
    fake.decision = () => answer;
    await start(`/index.html?device=1#code=${CODE}`);
    await vi.waitFor(() => expect(codeInput()?.value).toBe(CODE));
    button("確認").form!.requestSubmit();
    if (via === "decision") {
      await vi.waitFor(() => expect(dialogText()).toContain("承認する identity"));
      button("承認").click();
    }
    await vi.waitFor(() => expect(document.querySelector("dialog [role=alert]")).not.toBeNull());
  }

  it("404 unknown_code: says so and goes back to the entry with the code kept", async () => {
    await toError(UNKNOWN_CODE);
    expect(dialogText()).toContain("見つかりません");
    button("入力し直す").click();
    await vi.waitFor(() => expect(codeInput()?.value).toBe(CODE));
  });

  it("410 expired: tells the operator to log in again on the device", async () => {
    await toError(EXPIRED);
    expect(dialogText()).toContain("期限が切れています");
    expect(dialogText()).toContain("device で login をやり直し");
    expect(button("入力し直す")).toBeTruthy();
  });

  it("429 rate_limited: shows retry_after and keeps the input", async () => {
    await toError(RATE_LIMITED);
    expect(dialogText()).toContain("30 秒");
    button("入力し直す").click();
    await vi.waitFor(() => expect(codeInput()?.value).toBe(CODE));
  });

  it("409 already_decided on a decision", async () => {
    await toError(ALREADY_DECIDED, "decision");
    expect(dialogText()).toContain("すでに承認または拒否されています");
  });

  it("410 on a decision (it expired while the operator read the screen)", async () => {
    await toError(EXPIRED, "decision");
    expect(dialogText()).toContain("期限が切れています");
  });

  it("400, 415, 5xx and an unreadable body are one generic error that returns to the entry", async () => {
    for (const answer of [
      reply(400, { error: "invalid_request" }),
      reply(415, { error: "unsupported_media_type" }),
      reply(500, { error: "server_error" }),
      reply(200, { unexpected: true }),
    ]) {
      await toError(answer);
      expect(dialogText()).toContain("処理に失敗しました");
      button("入力し直す").click();
      await vi.waitFor(() => expect(codeInput()?.value).toBe(CODE));
    }
  });

  it("a request that fails to complete is the same generic error", async () => {
    fake.lookup = () => Promise.reject(new TypeError("offline"));
    await start(`/index.html?device=1#code=${CODE}`);
    await vi.waitFor(() => expect(codeInput()?.value).toBe(CODE));
    button("確認").form!.requestSubmit();
    await vi.waitFor(() => expect(dialogText()).toContain("処理に失敗しました"));
  });

  it("403 oauth_session_required: offers each provider and saves the started state before leaving", async () => {
    fake.authMethods = { token: true, oauth: ["github", "google"], device: true };
    await toError(OAUTH_SESSION_REQUIRED);
    expect(dialogText()).toContain("共有 token の session では承認できません");
    expect(stored()).toBeNull();
    const links = [...document.querySelectorAll<HTMLAnchorElement>("dialog a.button")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/auth/github", "/auth/google"]);
    expect(links.map((a) => a.textContent?.trim())).toEqual(["GitHub でログイン", "Google でログイン"]);
    links[0]!.click();
    expect(stored()).toEqual({ started: true, code: CODE });
  });

  it("401: says the session ended and goes to OAuth the same way", async () => {
    await toError(UNAUTHORIZED);
    expect(dialogText()).toContain("session が切れました");
    document.querySelector<HTMLAnchorElement>("dialog a.button")!.click();
    expect(stored()).toEqual({ started: true, code: CODE });
    // Back from OAuth the entry is open again with the code in place.
    await returnFromOAuth();
    await vi.waitFor(() => expect(codeInput()?.value).toBe(CODE));
  });

  it("with no OAuth provider a 401 has no login link, only a way to close", async () => {
    fake.authMethods = { token: true, oauth: [], device: true };
    await toError(UNAUTHORIZED);
    expect(document.querySelector("dialog a.button")).toBeNull();
    button("閉じる").click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
  });

  it("device:false on the server shows an error instead of the entry and asks nothing", async () => {
    fake.authMethods = { token: true, oauth: ["github"], device: false };
    await start("/index.html?device=1");
    await vi.waitFor(() => expect(dialogText()).toContain("この server は device 承認を提供していません"));
    expect(codeInput()).toBeNull();
    expect(() => button("入力し直す")).toThrow();
    expect(calls("/session/device/lookup")).toHaveLength(0);
  });

  it("a server that does not report device at all (older) proceeds to the entry", async () => {
    fake.authMethods = { token: true, oauth: ["github"] };
    await start("/index.html?device=1");
    await vi.waitFor(() => expect(codeInput()).not.toBeNull());
  });
});
