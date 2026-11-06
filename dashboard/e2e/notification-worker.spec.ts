import { test, expect } from "@playwright/test";
import { createServer, request, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

const phoenix = process.env.KAOIRO_NOTIFICATION_TEST_ORIGIN;
test.skip(!phoenix, "KAOIRO_NOTIFICATION_TEST_ORIGIN must point to the built Phoenix dashboard");
test.use({ channel: "chromium" });

test.describe.configure({ mode: "serial" });
for (const expiry of [false, true]) {
  test(`first live wait while worker response is held: ${expiry ? "expires" : "activates"}`, async ({ browser }) => {
    let held: { upstream: NodeJS.ReadableStream; response: ServerResponse } | undefined;
    let requested!: () => void;
    const workerRequested = new Promise<void>((resolve) => { requested = resolve; });
    const proxy = createServer((incoming, response) => {
      const upstream = request(new URL(incoming.url!, phoenix), { method: incoming.method, headers: { ...incoming.headers, host: new URL(phoenix!).host } }, (res) => {
        response.writeHead(res.statusCode!, res.headers);
        if (incoming.url === "/notification-worker/sw.js" && !held) {
          held = { upstream: res, response };
          requested();
        } else res.pipe(response);
      });
      upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      incoming.pipe(upstream);
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const origin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const context = await browser.newContext();
    try {
      await context.grantPermissions(["notifications"], { origin });
      const page = await context.newPage();
      await page.addInitScript(() => {
        const w = window as any;
        w.notificationCalls = 0;
        w.soundCalls = 0;
        const OriginalNotification = window.Notification;
        function RejectingNotification() { w.notificationCalls++; throw new TypeError("mobile constructor"); }
        Object.assign(RejectingNotification, { permission: "granted", requestPermission: OriginalNotification.requestPermission.bind(OriginalNotification) });
        w.Notification = RejectingNotification;
        w.Audio = function () { return { volume: 0, play() { w.soundCalls++; return Promise.resolve(); } }; };
        const originalFetch = window.fetch;
        window.fetch = async (input, init) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (url.includes("/session/ticket")) return Response.json({ ticket: "e2e" });
          if (url.includes("/session/auth-methods")) return Response.json({ token: true, oauth: [] });
          if (url.includes("/session/refresh")) return Response.json({});
          if (url.includes("/api/personas")) return Response.json({ version: "0", personas: {} });
          return originalFetch(input, init);
        };
        class FakeSocket {
          static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
          readyState = 0; binaryType = "arraybuffer"; protocol = "";
          onopen: ((event: unknown) => void) | null = null;
          onmessage: ((event: { data: string }) => void) | null = null;
          onclose: ((event: unknown) => void) | null = null;
          onerror = null;
          constructor(_url: string) { setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 0); }
          deliver(frame: unknown[]) { this.onmessage?.({ data: JSON.stringify(frame) }); }
          send(data: string) {
            const [joinRef, ref, topic, event] = JSON.parse(data);
            setTimeout(() => {
              this.deliver([joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]);
              if (event !== "phx_join" || topic !== "agents:lobby") return;
              this.deliver([null, null, topic, "snapshot", { agents: {} }]);
              w.emitFirstWait = () => this.deliver([null, null, topic, "envelope", {
                version: "0", agent_id: "test-agent", display_name: "Test agent", ts: "2026-11-07T00:00:00Z", type: "state_change", state: "waiting_input",
              }]);
            }, 0);
          }
          close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
        }
        w.WebSocket = FakeSocket;
      });
      const warning = expiry ? page.waitForEvent("console", { predicate: message => message.type() === "warning" && message.text().includes("Unable to show a hand-wait notification"), timeout: 10000 }) : undefined;
      await page.goto(origin);
      await workerRequested;
      await page.waitForFunction(() => typeof (window as any).emitFirstWait === "function");
      expect(await page.evaluate(async () => ({
        permission: Notification.permission,
        active: (await navigator.serviceWorker.getRegistration("/notification-worker/"))?.active?.state ?? null,
      }))).toEqual({ permission: "granted", active: null });
      await page.evaluate(() => (window as any).emitFirstWait());
      await expect.poll(() => page.evaluate(() => [(window as any).notificationCalls, (window as any).soundCalls])).toEqual([1, 1]);
      if (expiry) await warning;
      held!.upstream.pipe(held!.response);
      await expect.poll(() => page.evaluate(async () => {
        const r = await navigator.serviceWorker.getRegistration("/notification-worker/");
        return r?.active?.state ?? null;
      })).toBe("activated");
      if (expiry) {
        await page.waitForTimeout(250);
        await expect.poll(() => page.evaluate(async () => (await (await navigator.serviceWorker.getRegistration("/notification-worker/"))!.getNotifications()).length)).toBe(0);
      } else {
        await expect.poll(() => page.evaluate(async () => (await (await navigator.serviceWorker.getRegistration("/notification-worker/"))!.getNotifications()).map(n => ({ title: n.title, body: n.body, tag: n.tag })))).toEqual([{ title: "Test agent", body: "your turn", tag: "kaoiro:test-agent" }]);
        const workerResponse = await page.request.get(`${origin}/notification-worker/sw.js`);
        expect(await workerResponse.text()).toBe("");
        await page.goto(`${origin}/notification-worker/missing-document`);
        const document = await page.reload();
        expect(document?.status()).toBe(404);
        expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
      }
    } finally {
      held?.response.destroy();
      await context.close();
      proxy.close();
      await once(proxy, "close");
    }
  });
}
