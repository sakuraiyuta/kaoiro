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

let resizeObserverLoops: string[] = [];
test.afterEach(() => {
  expect(resizeObserverLoops).toEqual([]);
});

test.beforeEach(async ({ page }) => {
  resizeObserverLoops = [];
  page.on("console", m => {
    if (m.text().includes("ResizeObserver loop")) resizeObserverLoops.push(m.text());
  });
  page.on("pageerror", e => {
    if (e.message.includes("ResizeObserver loop")) resizeObserverLoops.push(e.message);
  });
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

test("a body too deep to transfer back stays plain; the next one formats", async ({ page }) => {
  await page.goto(origin!); await open(page);
  const deep = "*a _b ".repeat(600) + "x" + " b_ a*".repeat(600);
  send("envelope", entry(deep, 1));
  const body = page.locator(".async-markdown").last();
  await expect(body).toHaveAttribute("data-markdown-state", "plain", { timeout: 5000 });
  await expect(body.locator(".markdown-source")).toHaveText(deep);
  send("envelope", entry("**after**", 2));
  await expect(page.locator(".msg.assistant strong", { hasText: "after" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).md.created)).toBe(2);
});

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

// Issue #617: the operator's scroll is judged by position, never pulled back
// to the tail, and never shifted by a layout change it coincides with.
test.describe("operator scrolls during formatting", () => {
  test.beforeEach(async ({ page }) => {
    // Optional delay of each lexer result, modelling a slower lexer so the
    // drain spans about 50 batches; the product path is unchanged.
    await page.addInitScript(() => {
      const w = window as any; w.slowMs = 0;
      const Base = w.Worker;
      w.Worker = class extends Base {
        set onmessage(fn: ((event: MessageEvent) => void) | null) {
          super.onmessage = fn === null ? null : (event: MessageEvent) => {
            if (w.slowMs > 0 && event.data?.kind !== "started") setTimeout(() => fn(event), w.slowMs);
            else fn(event);
          };
        }
      };
    });
  });
  const gapOf = (page: Page) => page.locator(".log").evaluate(
    el => el.scrollHeight - el.clientHeight - el.scrollTop);
  const bodyGap = (page: Page, n: number) => page.locator(".log").evaluate((log, k) => {
    const body = log.querySelector(`[data-envelope-key*="|${k}|log|"] .msg`)!;
    return body.getBoundingClientRect().top - log.getBoundingClientRect().top;
  }, n);
  const waiting = () => Array.from({ length: 200 }, (_, i) => `row ${i}\n\n` +
    `# Big heading ${i}\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\n`.repeat(4));
  // Records frames, lexer batches (mutation callbacks in which pending bodies
  // dropped, i.e. the task that applied them), the product's scrollTop writes
  // and scroll events. Optionally leaves (scrollTop -= 1500) inside batch k.
  const instrument = (page: Page, slowMs: number, leaveAt = -1) => page.evaluate(([slow, k]) => {
    const w = window as any, log = document.querySelector(".log") as HTMLElement;
    const base = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
    const R = w.r = { frames: [] as any[], batches: [] as any[], writes: [] as any[],
      scrolls: [] as any[], keys: [] as number[], leave: null as any, seq: 0, last: 200 };
    w.slowMs = slow;
    const top = () => base.get!.call(log) as number;
    const gap = () => log.scrollHeight - log.clientHeight - top();
    const pending = () => document.querySelectorAll('[data-markdown-state="pending"]').length;
    Object.defineProperty(log, "scrollTop", { configurable: true, get: top, set(v: number) {
      base.set!.call(log, v); R.writes.push({ t: performance.now(), gap: gap() });
    } });
    log.addEventListener("scroll", () => R.scrolls.push({ t: performance.now(), gap: gap() }));
    window.addEventListener("keydown", () => R.keys.push(performance.now()), { capture: true });
    window.addEventListener("wheel", () => R.keys.push(performance.now()), { capture: true });
    const frame = () => {
      R.frames.push({ seq: R.seq, gap: gap(), p: pending() }); requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    new MutationObserver(() => {
      const p = pending();
      if (document.querySelectorAll(".msg.assistant").length < 200 || p >= R.last) return;
      R.last = p; R.batches.push({ t: performance.now(), seq: ++R.seq });
      if (R.seq !== k) return;
      const f = R.frames, i = f.length - 1;
      R.leave = { t: performance.now(), stable: f[i].seq === f[i - 1]?.seq ? f[i].gap : null };
      base.set!.call(log, top() - 1500);
    }).observe(document.body, { subtree: true, attributes: true,
      attributeFilter: ["data-markdown-state"] });
  }, [slowMs, leaveAt] as const);
  const record = (page: Page) => page.evaluate(() => (window as any).r);
  // Premise of the inputs below: the pin holds at the tail over three frames
  // with no batch between them while bodies still wait.
  const atTailWhileWaiting = (page: Page) => page.waitForFunction(() => {
    const f = (window as any).r.frames, [a, b, c] = f.slice(-3);
    return c && a.seq === c.seq && a.gap <= 8 && b.gap <= 8 && c.gap <= 8 &&
      a.p > 20 && (window as any).r.seq >= 2;
  });

  const pinnedLog = async (page: Page) => {
    await page.goto(origin!); await open(page);
    history(Array.from({ length: 40 }, (_, i) =>
      `row ${i} [link ${i}](https://example.org/${i})\n\n` + "paragraph\n\n".repeat(6)));
    await settled(page);
    await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(8);
  };
  const awayAfterEnvelope = async (page: Page) => {
    await page.waitForTimeout(600);
    expect(await gapOf(page)).toBeGreaterThan(200);
    send("envelope", entry("**later**\n\n".repeat(20), 60)); await settled(page);
    await page.waitForTimeout(400);
    expect(await gapOf(page)).toBeGreaterThan(200);
  };
  test("M2: PageUp after a click and an envelope leaves the tail", async ({ page }) => {
    await pinnedLog(page);
    await page.locator(".msg.assistant").last().click({ position: { x: 300, y: 10 } });
    send("envelope", entry("append one", 50)); await settled(page);
    await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(8);
    for (let i = 0; i < 3; i++) await page.keyboard.press("PageUp");
    await awayAfterEnvelope(page);
  });
  test("M2: focus moving to a link in an earlier row leaves the tail", async ({ page }) => {
    await pinnedLog(page);
    await page.locator(".msg.assistant a").nth(3).evaluate((a: HTMLElement) => a.focus());
    await awayAfterEnvelope(page);
  });
  test("M2: a scroll without input events leaves the tail", async ({ page }) => {
    await pinnedLog(page);
    await page.locator(".log").evaluate(el => { el.scrollTop = 200; });
    await awayAfterEnvelope(page);
  });
  for (const input of ["wheel", "click"] as const) {
    test(`M3: a ${input} that moves nothing at the tail keeps the pin`, async ({ page }) => {
      await page.goto(origin!); await open(page);
      await page.locator(".log").hover();
      history(waiting());
      await expect(page.locator(".msg.assistant")).toHaveCount(200);
      expect(await page.locator('[data-markdown-state="pending"]').count()).toBeGreaterThan(0);
      if (input === "wheel") await page.mouse.wheel(0, 400);
      else await page.locator(".log").click({ position: { x: 700, y: 400 } });
      await settle(page);
      expect(await gapOf(page)).toBeLessThanOrEqual(8);
      send("envelope", entry("**later**\n\n".repeat(20), 500)); await settle(page);
      expect(await gapOf(page)).toBeLessThanOrEqual(8);
    });
  }
  const timeline = async (page: Page, marker = 100) => {
    await page.goto(origin!);
    await expect(page.locator('button[aria-label^="Open details of "]').first()).toBeVisible();
    send("hosts", { version: "0", hosts: {} });
    history(Array.from({ length: 150 }, (_, i) => tall(i)));
    await page.locator(".timeline .row", { hasText: `marker-${marker}` }).click();
  };
  test("P8: a scroll without input after a timeline jump stays", async ({ page }) => {
    await timeline(page); await settle(page);
    expect(Math.abs(await bodyGap(page, 100) - 24)).toBeLessThanOrEqual(2);
    await page.locator(".log").evaluate(el => { el.scrollTop += 1500; });
    await page.waitForTimeout(600);
    send("envelope", entry("**later**", 400)); await settle(page);
    expect(await bodyGap(page, 100)).toBeLessThan(-1000);
  });
  test("a timeline jump that lands at the end of the log follows later output", async ({ page }) => {
    // The newest body lands in the tail padding, which is the end of the log.
    await timeline(page, 149); await settle(page);
    expect(Math.abs(await bodyGap(page, 149) - 24)).toBeLessThanOrEqual(2);
    expect(await gapOf(page)).toBeLessThanOrEqual(8);
    // More output than the padding and the viewport hold, with no scroll.
    for (let i = 400; i < 412; i++) send("envelope", entry(tall(i), i));
    await expect(page.locator(".log")).toContainText("marker-411");
    await settle(page);
    expect(await gapOf(page)).toBeLessThanOrEqual(8);
  });
  test("P9: a scroll without input after returning to an agent stays", async ({ page }) => {
    await page.goto(origin!); await open(page);
    send("history", { agents: {
      "host.p": Array.from({ length: 120 }, (_, i) => entry(tall(i), i)),
      "host.q": [entry("q reply", 0, "assistant", "host.q")],
    } });
    await settle(page);
    await page.locator(".log").hover(); await page.mouse.wheel(0, -3000); await settle(page);
    await page.getByRole("button", { name: /^Go to the next agent/ }).click();
    await expect(page.locator(".msg", { hasText: "q reply" })).toBeVisible();
    await page.getByRole("button", { name: /^Go to the previous agent/ }).click();
    await settle(page);
    const restored = await page.locator(".log").evaluate(el => el.scrollTop);
    await page.locator(".log").evaluate(el => { el.scrollTop -= 1000; });
    await page.waitForTimeout(600);
    send("envelope", entry("**later**", 400)); await settle(page);
    expect(await page.locator(".log").evaluate(el => el.scrollTop)).toBeLessThan(restored - 900);
  });
  const toolLogs = () => {
    const logs = Array.from({ length: 80 }, (_, i) => entry(tall(i), i));
    logs[20] = { ...entry("", 20), payload: {
      kind: "tool_use", tool_use_id: "toolu_fixture", name: "Read", input: { path: "a" } } };
    logs[75] = { ...entry("", 75), payload: {
      kind: "tool_result", tool_use_id: "toolu_fixture", text: "done" } };
    return logs;
  };
  const toolOffCenter = (page: Page) => page.locator(".log").evaluate(log => {
    const t = log.querySelector('[data-tuid="toolu_fixture"][data-kind="tool_use"]')!;
    const r = t.getBoundingClientRect(), l = log.getBoundingClientRect();
    return r.top + r.height / 2 - (l.top + log.clientHeight / 2);
  });
  const holds = async (page: Page) =>
    (await page.locator(".log").getAttribute("style") ?? "").includes("overflow-anchor: none");
  // Each intent, once settled, hands the log over with the operator's first
  // scroll kept exactly and no write of its own. The timeline target is the
  // last body, so it lands in the tail padding.
  const intents: Record<string, (page: Page) => Promise<void>> = {
    pin: pinnedLog,
    anchor: async page => {
      await page.goto(origin!); await open(page);
      send("history", { agents: {
        "host.p": Array.from({ length: 120 }, (_, i) => entry(tall(i), i)),
        "host.q": [entry("q reply", 0, "assistant", "host.q")],
      } });
      await settle(page);
      await page.locator(".log").hover(); await page.mouse.wheel(0, -3000); await settle(page);
      await page.getByRole("button", { name: /^Go to the next agent/ }).click();
      await expect(page.locator(".msg", { hasText: "q reply" })).toBeVisible();
      await page.getByRole("button", { name: /^Go to the previous agent/ }).click();
      await settle(page);
    },
    timeline: async page => {
      await timeline(page, 149); await settle(page);
      expect(Math.abs(await bodyGap(page, 149) - 24)).toBeLessThanOrEqual(2);
      expect(await page.locator(".log").evaluate(el =>
        parseFloat(el.style.getPropertyValue("--timeline-scroll-tail")))).toBeGreaterThan(100);
    },
    tool: async page => {
      await page.goto(origin!); await open(page);
      send("history", { agents: { "host.p": toolLogs() } });
      await page.locator('[data-kind="tool_result"] .tlink').click(); await settle(page);
    },
  };
  for (const [kind, holdIntent] of Object.entries(intents)) {
    test(`a 50 px scroll from the ${kind} intent moves the log 50 px`, async ({ page }) => {
      await holdIntent(page);
      expect(await holds(page)).toBe(true);
      const r = await page.locator(".log").evaluate(async log => {
        const base = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
        let writes = 0;
        Object.defineProperty(log, "scrollTop", { configurable: true,
          get: () => base.get!.call(log), set(v: number) { writes++; base.set!.call(log, v); } });
        const before = base.get!.call(log) as number;
        base.set!.call(log, before - 50);
        await new Promise(resolve => setTimeout(resolve, 300));
        return { moved: (base.get!.call(log) as number) - before, writes };
      });
      expect(Math.abs(r.moved + 50)).toBeLessThanOrEqual(2);
      expect(r.writes).toBe(0);
      expect(await holds(page)).toBe(false);
    });
  }
  test("without scrollend, a settled jump ends once the log stops and the next scroll stays", async ({ page }) => {
    // Models a browser without scrollend (Safari before 26.2).
    await page.addInitScript(() => {
      const w = window as any; w.droppedScrollend = 0;
      for (const o of [window, Window.prototype, Document.prototype,
        HTMLElement.prototype, Element.prototype]) delete (o as any).onscrollend;
      const add = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function (this: EventTarget, type: string,
        ...rest: any[]) {
        if (type === "scrollend") { w.droppedScrollend++; return; }
        return (add as any).call(this, type, ...rest);
      };
    });
    await page.goto(origin!); await open(page);
    expect(await page.evaluate(() => "onscrollend" in document.createElement("div"))).toBe(false);
    send("history", { agents: { "host.p": toolLogs() } });
    // Settled first: a late layout change would end the jump without scrollend.
    await settled(page);
    await page.locator('[data-kind="tool_result"] .tlink').click(); await settle(page);
    expect(await page.evaluate(() => (window as any).droppedScrollend)).toBeGreaterThan(0);
    expect(Math.abs(await toolOffCenter(page))).toBeLessThanOrEqual(2);
    await page.locator(".log").evaluate(el => { el.scrollTop += 1500; });
    await page.waitForTimeout(600);
    const away = await page.locator(".log").evaluate(el => el.scrollTop);
    send("envelope", entry("**later**", 400)); await settle(page);
    expect(Math.abs(await page.locator(".log").evaluate(el => el.scrollTop) - away))
      .toBeLessThanOrEqual(2);
  });
  test("a wheel stops each jump; a click during the timeline jump does not", async ({ page }) => {
    await timeline(page);
    await page.locator(".log").hover(); await page.waitForTimeout(60);
    await page.mouse.wheel(0, 1500); await settle(page);
    expect(Math.abs(await bodyGap(page, 100) - 24)).toBeGreaterThan(200);
    await timeline(page);
    await page.waitForTimeout(60);
    await page.locator(".log").click({ position: { x: 700, y: 300 } }); await settle(page);
    expect(Math.abs(await bodyGap(page, 100) - 24)).toBeLessThanOrEqual(2);
    await page.goto(origin!); await open(page);
    send("history", { agents: { "host.p": toolLogs() } });
    await page.locator('[data-kind="tool_result"] .tlink').click();
    await page.waitForTimeout(60);
    await page.locator(".log").hover(); await page.mouse.wheel(0, 1500); await settle(page);
    const offCenter = await page.locator(".log").evaluate(log => {
      const t = log.querySelector('[data-tuid="toolu_fixture"][data-kind="tool_use"]')!;
      const r = t.getBoundingClientRect(), l = log.getBoundingClientRect();
      return r.top + r.height / 2 - (l.top + log.clientHeight / 2);
    });
    expect(Math.abs(offCenter)).toBeGreaterThan(200);
  });
  for (const [lexer, slowMs, leaveAt] of [["fast", 0, 1], ["slow", 15, 20]] as const) {
    test(`a leave in the same task as a batch keeps the operator's 1,500 px (${lexer} lexer)`, async ({ page }) => {
      await page.goto(origin!); await open(page);
      await instrument(page, slowMs, leaveAt);
      history(waiting());
      await expect(page.locator(".msg.assistant")).toHaveCount(200);
      await settle(page);
      const r = await record(page);
      expect(r.leave).not.toBeNull();
      expect(r.leave.stable).not.toBeNull();
      expect(r.leave.stable).toBeLessThanOrEqual(8);
      const after = r.scrolls.find((s: any) => s.t > r.leave.t);
      expect(Math.abs(after.gap - 1500)).toBeLessThanOrEqual(2);
      const writes = r.writes.filter((x: any) => x.t > r.leave.t);
      expect(writes.filter((x: any) => x.gap <= 8)).toEqual([]);
    });
  }
  test("the tail pin corrects an unannounced layout change before that frame paints", async ({ page }) => {
    await pinnedLog(page);
    const nextFrameGap = await page.evaluate(() => new Promise<number>(resolve => {
      const log = document.querySelector(".log")!;
      requestAnimationFrame(() => {
        const bodies = document.querySelectorAll<HTMLElement>(".msg.assistant");
        bodies[bodies.length - 1].style.minHeight = "1800px";
        // Requested before this frame's ResizeObserver callback runs, so it
        // runs first in the next frame.
        requestAnimationFrame(() => resolve(log.scrollHeight - log.clientHeight - log.scrollTop));
      });
    }));
    expect(nextFrameGap).toBeLessThanOrEqual(8);
  });
  test("a tool jump made while bodies wait keeps the partner centered", async ({ page }) => {
    await page.goto(origin!); await open(page);
    await page.evaluate(() => { (window as any).slowMs = 25; });
    send("history", { agents: { "host.p": toolLogs() } });
    await expect(page.locator('[data-kind="tool_result"] .tlink')).toBeVisible();
    expect(await page.locator('[data-markdown-state="pending"]').count()).toBeGreaterThan(20);
    await page.locator('[data-kind="tool_result"] .tlink').click(); await settle(page);
    expect(Math.abs(await toolOffCenter(page))).toBeLessThanOrEqual(2);
  });
  test("a settled tool jump corrects an unannounced layout change above it before that frame paints", async ({ page }) => {
    await page.goto(origin!); await open(page);
    send("history", { agents: { "host.p": toolLogs() } });
    await settled(page);
    await page.locator('[data-kind="tool_result"] .tlink').click(); await settle(page);
    const offCenter = await page.evaluate(() => new Promise<number>(resolve => {
      const log = document.querySelector(".log") as HTMLElement;
      requestAnimationFrame(() => {
        document.querySelectorAll<HTMLElement>(".msg.assistant")[5].style.minHeight = "1800px";
        requestAnimationFrame(() => {
          const t = log.querySelector('[data-tuid="toolu_fixture"][data-kind="tool_use"]')!;
          const r = t.getBoundingClientRect(), l = log.getBoundingClientRect();
          resolve(r.top + r.height / 2 - (l.top + log.clientHeight / 2));
        });
      });
    }));
    expect(Math.abs(offCenter)).toBeLessThanOrEqual(2);
  });
  test("the tail pin corrects a shorter log before that frame paints", async ({ page }) => {
    await pinnedLog(page);
    const gap = await page.evaluate(() => new Promise<number>(resolve => {
      const log = document.querySelector(".log") as HTMLElement;
      requestAnimationFrame(() => {
        log.style.maxHeight = `${log.clientHeight - 300}px`;
        requestAnimationFrame(() => resolve(log.scrollHeight - log.clientHeight - log.scrollTop));
      });
    }));
    expect(gap).toBeLessThanOrEqual(8);
  });
  // These repeat the input, and each run needs bodies still waiting, so they
  // use a slower lexer and a longer test timeout than the single-shot cases.
  test("ArrowUp at the tail while bodies wait moves about 40 px", async ({ page }) => {
    test.setTimeout(120_000);
    let overlapped = 0;
    for (let n = 0; n < 5; n++) {
      await page.goto(origin!); await open(page);
      await instrument(page, 25);
      history(waiting());
      await expect(page.locator(".msg.assistant")).toHaveCount(200);
      // Focus a body near the tail without moving the log.
      await page.locator(".msg.assistant").last().click({ position: { x: 300, y: 5 } });
      await atTailWhileWaiting(page);
      const seq = (await record(page)).seq;
      await page.waitForFunction(s => (window as any).r.seq > s, seq, { polling: "raf" });
      await page.waitForTimeout(n * 14);
      await page.keyboard.press("ArrowUp");
      await page.waitForTimeout(700);
      const r = await record(page);
      const t0 = r.keys.at(-1), out = r.scrolls.find((s: any) => s.t > t0 && s.gap > 8);
      if (out && r.batches.some((b: any) => b.t >= t0 && b.t <= out.t)) overlapped++;
      const gap = await gapOf(page);
      expect(gap).toBeGreaterThanOrEqual(30);
      expect(gap).toBeLessThanOrEqual(50);
    }
    expect(overlapped).toBeGreaterThan(0);
  });
  test("small wheel steps at the tail while bodies wait leave the tail", async ({ page }) => {
    test.setTimeout(120_000);
    for (let n = 0; n < 3; n++) {
      await page.goto(origin!); await open(page);
      await instrument(page, 25);
      history(waiting());
      await expect(page.locator(".msg.assistant")).toHaveCount(200);
      await page.locator(".log").hover();
      await atTailWhileWaiting(page);
      for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -2); await page.waitForTimeout(16); }
      await page.waitForTimeout(700);
      expect(await gapOf(page)).toBeGreaterThan(8);
    }
  });
  test("returning to the end resumes the pin", async ({ page }) => {
    await pinnedLog(page);
    await page.locator(".log").hover(); await page.mouse.wheel(0, -800);
    await expect.poll(() => gapOf(page)).toBeGreaterThan(200);
    await page.mouse.wheel(0, 100_000);
    await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(1);
    await page.locator(".msg.assistant").last().evaluate(el => { el.style.minHeight = "1800px"; });
    await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(8);
  });
});
