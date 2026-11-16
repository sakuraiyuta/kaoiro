import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import { deliveryAgent } from "../test/deliveryPolicyLoopback";

const origin = process.env.KAOIRO_MARKDOWN_TEST_ORIGIN;
test.skip(!origin, "Start the built Phoenix test server; see e2e/README.md");
test.use({ locale: "en-US", viewport: { width: 1440, height: 1000 } });
let socket: WebSocketRoute;
const agent = (id = "host.p") => ({ ...deliveryAgent, agent_id: id });
const entry = (text: string, n = 0, kind = "assistant", id = "host.p") => ({
  version: "0", agent_id: id, state: "thinking", type: "log", seq: n,
  ts: new Date(Date.UTC(2026, 10, 16, 0, 0, n)).toISOString(),
  payload: { kind, text },
});
const send = (event: string, payload: unknown) => socket.send(
  JSON.stringify([null, null, "agents:lobby", event, payload]),
);
const history = (texts: string[], id = "host.p") => send("history", {
  agents: { [id]: texts.map((text, n) => entry(text, n, "assistant", id)) },
});
const open = async (page: Page, index = 0) => {
  await page.locator('button[aria-label^="Open details of "]').nth(index).click();
  await expect(page.locator(".log")).toBeVisible();
};
const settled = async (page: Page) => {
  await expect(page.locator('[data-markdown-state="pending"]')).toHaveCount(0,
    { timeout: 25000 });
  await page.waitForTimeout(100);
};

test.beforeEach(async ({ page }) => {
  await page.route("**/session/**", route => route.fulfill({ json: {
    ticket: "fixture", token: true, oauth: [],
  } }));
  await page.route("**/api/**", route => route.fulfill({ json: {} }));
  await page.routeWebSocket("**/client/websocket**", ws => {
    socket = ws;
    ws.onMessage(raw => {
      const [join, ref, topic, event] = JSON.parse(String(raw));
      ws.send(JSON.stringify([join, ref, topic, "phx_reply", {
        status: "ok", response: {},
      }]));
      if (event === "phx_join") send("snapshot", {
        version: "0", agents: { "host.p": agent(), "host.q": agent("host.q") },
      });
    });
  });
  await page.addInitScript(() => {
    const w = window as any;
    w.md = { created: 0, terminated: 0, events: [], stopped: [], dispatch: 0, gaps: [], last: performance.now() };
    w.block = null;
    const NativeWorker = Worker;
    w.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options); w.md.created++;
      }
      set onmessage(fn: ((event: MessageEvent) => void) | null) {
        super.onmessage = fn === null ? null : event => {
          const block = w.block;
          const stall = () => {
            w.block = null;
            const start = performance.now();
            while (performance.now() - start < block.ms) { /* controlled UI stall */ }
          };
          if (event.data.kind === "started" && block?.when === "before") stall();
          w.md.events.push({ kind: event.data.kind, at: performance.now() });
          fn(event);
          if (event.data.kind === "started" && block?.when === "after") stall();
        };
      }
      postMessage(message: any) {
        w.md.dispatch = performance.now(); super.postMessage(message);
      }
      terminate() {
        w.md.stopped.push(performance.now() - w.md.dispatch);
        w.md.terminated++; super.terminate();
      }
    };
    setInterval(() => {
      const now = performance.now(); w.md.gaps.push(now - w.md.last); w.md.last = now;
    }, 10);
  });
});

test("built App isolates hostile bodies, preserves text, reuses and recovers", async ({ page, browser }, info) => {
  const response = await page.goto(origin!);
  expect(response!.headers()["content-security-policy"]).toContain("script-src 'self'");
  expect(response!.headers()["x-content-type-options"]).toBe("nosniff");
  await open(page);
  for (const [n, kind] of ["assistant", "user", "inter_agent_message"].entries()) {
    const hostile = "*a _b ".repeat(6000);
    await page.evaluate(() => { (window as any).md.gaps = []; });
    if (kind === "inter_agent_message") send("envelope", {
      ...entry(hostile, n), type: kind, payload: { to: "host.q", kind: "inform",
        conversation_id: "fixture", turn_number: 1, body: hostile,
        meta: { done: false }, owner: { kind: "agent", id: "host.p" } },
    });
    else send("envelope", entry(hostile, n, kind));
    const body = page.locator(".async-markdown").last();
    await expect(body).toHaveAttribute("data-markdown-state", "pending");
    await expect(body.locator(".markdown-source")).toHaveText(hostile);
    await expect(body).toHaveAttribute("data-markdown-state", "plain");
    const elapsed = await page.evaluate(() => (window as any).md.stopped.at(-1));
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(1500);
    const gaps = await page.evaluate(() => Math.max(...(window as any).md.gaps));
    expect(gaps).toBeLessThan(250);
    await info.attach(`hostile-${kind}`, { body: JSON.stringify({ elapsed, gaps }), contentType: "application/json" });
  }
  send("envelope", entry("**normal** [ref][x]\n\n[x]: https://e.test", 4));
  await expect(page.locator(".msg.assistant strong").last()).toHaveText("normal");
  const count = await page.evaluate(() => (window as any).md.created);
  send("envelope", entry("next **normal**", 5)); await settled(page);
  expect(await page.evaluate(() => (window as any).md.created)).toBe(count);
  // Terminated workers can stay listed and close at any time, so wait for
  // every listed one, attached in the same tick as the listing.
  const workers = page.workers().filter(w => w.url().includes("markdown.worker"));
  const closed = Promise.all(workers.map(w => w.waitForEvent("close")));
  const worker = workers.at(-1)!;
  expect(worker).toBeTruthy();
  const asset = await page.request.get(worker.url());
  expect(asset.status()).toBe(200);
  expect(asset.headers()["content-type"]).toMatch(/javascript/);
  expect(asset.headers()["x-content-type-options"]).toBe("nosniff");
  expect(new URL(worker.url()).origin).toBe(new URL(origin!).origin);
  await info.attach("browser", { body: browser.version(), contentType: "text/plain" });
  await page.goto("about:blank"); await closed;
});

for (const warm of [false, true]) for (const when of ["before", "after"]) {
  test(`Chromium ordering: ${warm ? "warm" : "cold"} normal result after UI stall ${when} start`, async ({ page }) => {
    await page.goto(origin!); await open(page);
    if (warm) { history(["warm"]); await expect(page.locator('[data-markdown-state="html"]')).toHaveCount(1); }
    await page.evaluate(when => { (window as any).block = { when, ms: 1500 }; }, when);
    send("envelope", entry("**success**", 9));
    await expect(page.locator(".async-markdown strong").last()).toHaveText("success", { timeout: 5000 });
    // Chromium 151 observation, not a cross-browser timer/message ordering promise.
    expect(await page.evaluate(() => (window as any).md.terminated)).toBe(0);
  });
}

test("delayed asset is pending time; blocked CSP fails until reload", async ({ page }) => {
  await page.route("**/assets/markdown.worker-*.js", async route => {
    await new Promise(resolve => setTimeout(resolve, 1200)); await route.continue();
  });
  await page.goto(origin!); await open(page); history(["**loaded**"]);
  await expect(page.locator(".async-markdown strong")).toHaveText("loaded");
  await page.unroute("**/assets/markdown.worker-*.js");
  await page.route("**/index.html", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(),
      "content-security-policy": response.headers()["content-security-policy"] + "; worker-src 'none'",
    } });
  });
  await page.reload(); await open(page); history(["**blocked**", "second"]);
  await expect(page.locator('[data-markdown-state="plain"]')).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).md.created)).toBe(1);
  send("envelope", entry("third", 3));
  await expect(page.locator('[data-markdown-state="plain"]')).toHaveCount(3);
  expect(await page.evaluate(() => (window as any).md.created)).toBe(1);
});

const short = (i: number) =>
  `Reply **${i}** with \`code\` and a [link](https://example.org).\n\n- one\n- two\n`;

for (const [count, size, limit] of [[200, 72, 1500], [200, 2000, 1500], [2000, 72, 4000], [2000, 2000, 22000]]) {
  test(`FIFO mounted batch ${count} x ${size}`, async ({ page }, info) => {
    await page.goto(origin!); await open(page);
    history(Array.from({ length: count! }, (_, i) => short(i)
      + (size === 2000
        ? "A normal sentence of prose with *emphasis* here.\n".repeat(40) : "")));
    if (count! > 200) await page.locator(".load-earlier").click();
    await expect(page.locator(".async-markdown")).toHaveCount(count!);
    const start = Date.now();
    await page.evaluate(() => { (window as any).md.gaps = []; });
    await expect(page.locator('[data-markdown-state="html"]')).toHaveCount(count!, { timeout: limit! });
    const elapsed = Date.now() - start;
    const gaps = await page.evaluate(() => Math.max(...(window as any).md.gaps));
    expect(elapsed).toBeLessThan(limit!);
    expect(gaps).toBeLessThan(count! > 200 ? 500 : 250);
    expect(await page.evaluate(() => (window as any).md.created)).toBe(1);
    await info.attach("timing", { body: JSON.stringify({ elapsed, gaps }), contentType: "application/json" });
  });
}

test("three hostile predecessors, then 197 normal bodies", async ({ page }, info) => {
  await page.goto(origin!); await open(page);
  const hostile = "*a _b ".repeat(6000);
  history([hostile, hostile, hostile, ...Array.from({ length: 197 }, (_, i) => short(i))]);
  await expect(page.locator(".async-markdown")).toHaveCount(200);
  const start = Date.now();
  await page.evaluate(() => { (window as any).md.gaps = []; });
  await expect(page.locator('[data-markdown-state="html"]')).toHaveCount(197, { timeout: 4000 });
  const elapsed = Date.now() - start;
  await expect(page.locator('[data-markdown-state="plain"]')).toHaveCount(3);
  const gaps = await page.evaluate(() => Math.max(...(window as any).md.gaps));
  expect(elapsed).toBeLessThan(4000);
  expect(gaps).toBeLessThan(250);
  expect(await page.evaluate(() => (window as any).md.terminated)).toBe(3);
  await info.attach("timing", { body: JSON.stringify({ elapsed, gaps }), contentType: "application/json" });
});

// Formatting changes these bodies' heights, so every geometry case below is
// checked after all late layout has settled (r2 settled-scroll contracts).
const tall = (i: number) =>
  `marker-${i}\n\n## Heading ${i}\n\n` + "- item with **bold** text\n".repeat(8);
const settle = async (page: Page) => {
  await expect(page.locator('[data-markdown-state="pending"]')).toHaveCount(0,
    { timeout: 25000 });
  let previous = -1;
  for (let i = 0; i < 50; i++) {
    const top = await page.locator(".log").evaluate(el => el.scrollTop);
    if (top === previous) return;
    previous = top; await page.waitForTimeout(150);
  }
  throw new Error("scrollTop did not settle");
};
const firstVisibleRow = (page: Page) => page.locator(".log").evaluate(log => {
  const top = log.getBoundingClientRect().top;
  const row = [...log.querySelectorAll<HTMLElement>("[data-envelope-key]")]
    .find(r => r.getBoundingClientRect().bottom > top + 1)!;
  return { key: row.dataset.envelopeKey!, offset: row.getBoundingClientRect().top - top };
});
const rowOffset = (page: Page, key: string) => page.locator(".log").evaluate((log, k) => {
  const row = [...log.querySelectorAll<HTMLElement>("[data-envelope-key]")]
    .find(r => r.dataset.envelopeKey === k);
  return row ? row.getBoundingClientRect().top - log.getBoundingClientRect().top : null;
}, key);

test("show-earlier keeps the previously visible row through late formatting", async ({ page }) => {
  await page.goto(origin!); await open(page);
  history(Array.from({ length: 260 }, (_, i) => tall(i)));
  await settle(page);
  await page.locator(".log").hover(); await page.mouse.wheel(0, -1_000_000);
  await settle(page);
  const before = await firstVisibleRow(page);
  await page.locator(".load-earlier").click();
  await expect(page.locator(".async-markdown")).toHaveCount(260);
  await settle(page);
  expect(Math.abs((await rowOffset(page, before.key))! - before.offset)).toBeLessThanOrEqual(2);
});

test("returning to an agent restores its row and offset through late formatting", async ({ page }) => {
  await page.goto(origin!); await open(page);
  send("history", { agents: {
    "host.p": Array.from({ length: 120 }, (_, i) => entry(tall(i), i)),
    "host.q": [entry("q reply", 0, "assistant", "host.q")],
  } });
  await settle(page);
  await page.locator(".log").hover(); await page.mouse.wheel(0, -3000);
  await settle(page);
  const before = await firstVisibleRow(page);
  await page.getByRole("button", { name: /^Go to the next agent/ }).click();
  await expect(page.locator(".msg", { hasText: "q reply" })).toBeVisible();
  await settle(page);
  await page.getByRole("button", { name: /^Go to the previous agent/ }).click();
  await expect(page.locator(".async-markdown")).toHaveCount(120);
  await settle(page);
  expect(Math.abs((await rowOffset(page, before.key))! - before.offset)).toBeLessThanOrEqual(2);
});

test("timeline jump lands the body at the 24 px gap through late formatting", async ({ page }) => {
  await page.goto(origin!);
  await expect(page.locator('button[aria-label^="Open details of "]').first()).toBeVisible();
  send("hosts", { version: "0", hosts: {} }); // operator-only response timeline
  history(Array.from({ length: 150 }, (_, i) => tall(i)));
  await page.locator(".timeline .row", { hasText: "marker-130" }).click();
  await settle(page);
  const gap = await page.locator(".log").evaluate(log => {
    const body = log.querySelector('[data-envelope-key*="|130|log|"] .msg');
    return body!.getBoundingClientRect().top - log.getBoundingClientRect().top;
  });
  expect(Math.abs(gap - 24)).toBeLessThanOrEqual(2);
});

test("tool jump centers the partner through late formatting", async ({ page }) => {
  await page.goto(origin!); await open(page);
  const logs = Array.from({ length: 80 }, (_, i) => entry(tall(i), i));
  logs[20] = { ...entry("", 20), payload: {
    kind: "tool_use", tool_use_id: "toolu_fixture", name: "Read", input: { path: "a" } } };
  logs[75] = { ...entry("", 75), payload: {
    kind: "tool_result", tool_use_id: "toolu_fixture", text: "done" } };
  send("history", { agents: { "host.p": logs } });
  await page.locator('[data-kind="tool_result"] .tlink').click();
  await settle(page);
  const offCenter = await page.locator(".log").evaluate(log => {
    const target = log.querySelector('[data-tuid="toolu_fixture"][data-kind="tool_use"]')!;
    const r = target.getBoundingClientRect(), l = log.getBoundingClientRect();
    return r.top + r.height / 2 - (l.top + log.clientHeight / 2);
  });
  expect(Math.abs(offCenter)).toBeLessThanOrEqual(2);
});

for (const [name, text] of [
  ["flat emphasis 4 KB", "*a _b ".repeat(683)],
  ["flat emphasis 8 KB", "*a _b ".repeat(1366)],
  ["flat emphasis 16 KB", "*a _b ".repeat(2731)],
  ["flat emphasis 36 KB", "*a _b ".repeat(6000)],
  ["strike 60 KB", "~~a ".repeat(15000)],
  ["100,000 nested quotes", ">".repeat(100000) + " q"],
  ["normal 36 KB prose (control)", "A normal sentence of prose here\n".repeat(1125)],
] as const) {
  test(`hostile series: ${name}`, async ({ page }, info) => {
    await page.goto(origin!); await open(page);
    await page.evaluate(() => { (window as any).md.gaps = []; });
    send("envelope", entry(text, 1));
    const body = page.locator(".async-markdown").last();
    await expect(body).not.toHaveAttribute("data-markdown-state", "pending", { timeout: 5000 });
    const state = await body.getAttribute("data-markdown-state");
    if (state === "plain") await expect(body.locator(".markdown-source")).toHaveText(text);
    const gaps = await page.evaluate(() => Math.max(...(window as any).md.gaps));
    const stopped = await page.evaluate(() => (window as any).md.stopped.at(-1) ?? null);
    await info.attach("outcome", { body: JSON.stringify({ state, gaps, stopped }), contentType: "application/json" });
    expect(gaps).toBeLessThan(250);
    if (name.startsWith("normal")) expect(state).toBe("html");
  });
}

test("switching agents during a backlog starts at most one new worker", async ({ page }) => {
  await page.goto(origin!); await open(page);
  send("history", { agents: {
    "host.p": Array.from({ length: 2000 }, (_, i) => entry(`Reply **${i}**\n`, i)),
    "host.q": [entry("**q reply**", 0, "assistant", "host.q")],
  } });
  await page.locator(".load-earlier").click();
  await expect(page.locator(".async-markdown")).toHaveCount(2000);
  expect(await page.locator('[data-markdown-state="pending"]').count()).toBeGreaterThan(0);
  await page.getByRole("button", { name: /^Go to the next agent/ }).click();
  await expect(page.locator(".msg strong", { hasText: "q reply" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).md.created)).toBeLessThanOrEqual(2);
});

test("tail pin survives late formatting and reading away never repins", async ({ page }) => {
  await page.goto(origin!); await open(page);
  history(Array.from({ length: 40 }, (_, i) => `row ${i}\n\n` + "paragraph\n\n".repeat(6)));
  await settled(page);
  const gap = () => page.locator(".log").evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
  await expect.poll(gap).toBeLessThanOrEqual(8);
  await page.locator(".msg.assistant").last().evaluate(el => { el.style.minHeight = "1800px"; });
  await expect.poll(gap).toBeLessThanOrEqual(8);
  await page.locator(".log").hover(); await page.mouse.wheel(0, -800);
  await expect.poll(gap).toBeGreaterThan(200);
  const before = await page.locator(".log").evaluate(el => el.scrollTop);
  send("envelope", entry("**later**\n\n".repeat(20), 50)); await settled(page);
  expect(await page.locator(".log").evaluate(el => el.scrollTop)).toBeCloseTo(before, 0);
});
