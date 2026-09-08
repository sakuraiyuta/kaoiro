import { chromium } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const repoRoot = path.resolve(root, "..");
const baselineRevision = "2ea8f80bcd18aaac2bb6f47b9a685dbcfe3ebb7e";
const outputRoot = path.resolve(
  process.env.ISSUE304_OUTPUT_ROOT ?? path.join(os.tmpdir(), "momo304-raw"),
);
const actions = 60;
const runs = Number.parseInt(process.env.ISSUE304_RUNS ?? "3", 10);
const negative = process.env.ISSUE304_NEGATIVE;

const scenarios = [
  { name: "h1000-expanded", history: 1_000, expand: true, tick: 100 },
  { name: "h5000-tail", history: 5_000, expand: false, tick: 100 },
  { name: "h1000-tail", history: 1_000, expand: false, tick: 100 },
  { name: "h1000-tail-tick-off", history: 1_000, expand: false, tick: 0 },
];
const modes = ["ascii", "ime"];
const variants = ["baseline", "after"];
const selectedScenarios = process.env.ISSUE304_SCENARIOS
  ? scenarios.filter((scenario) =>
      process.env.ISSUE304_SCENARIOS.split(",").includes(scenario.name),
    )
  : scenarios;
const selectedModes = process.env.ISSUE304_MODES
  ? modes.filter((mode) => process.env.ISSUE304_MODES.split(",").includes(mode))
  : modes;
const selectedVariants = process.env.ISSUE304_VARIANTS
  ? variants.filter((variant) =>
      process.env.ISSUE304_VARIANTS.split(",").includes(variant),
    )
  : variants;

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashFile(file) {
  return hash(fs.readFileSync(file));
}

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  if (sorted.length === 0) return { count: 0, median: null, p95: null, max: null };
  return {
    count: sorted.length,
    median: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    max: sorted.at(-1),
  };
}

function createBaselineSource() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "momo304-baseline-"));
  const archive = execFileSync(
    "git",
    ["archive", "--format=tar", baselineRevision, "dashboard/src"],
    { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 },
  );
  const extracted = spawnSync("tar", ["-xf", "-", "-C", directory], {
    input: archive,
    encoding: "utf8",
  });
  if (extracted.status !== 0) {
    throw new Error(`could not extract baseline source: ${extracted.stderr}`);
  }
  fs.symlinkSync(
    path.join(root, "node_modules"),
    path.join(directory, "dashboard/node_modules"),
    "dir",
  );
  return {
    directory,
    app: path.join(directory, "dashboard/src/App.svelte"),
    source: path.join(directory, "dashboard/src"),
  };
}

function formatCountPlugin() {
  return {
    name: "issue-304-format-count",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith("/src/lib/AgentDetail.svelte")) return null;
      const signature = "function formatTime(ts: string): string {";
      if (!code.includes(signature)) {
        throw new Error("could not instrument AgentDetail formatTime");
      }
      return code.replace(
        signature,
        `${signature}\n    const issue304Window = window as typeof window & { __issue304FormatCalls?: number };\n    issue304Window.__issue304FormatCalls = (issue304Window.__issue304FormatCalls ?? 0) + 1;`,
      );
    },
  };
}

async function buildVariant(name, app, buildRoot) {
  const outDir = path.join(buildRoot, name);
  await build({
    root,
    configFile: false,
    logLevel: "error",
    plugins: [svelte(), formatCountPlugin()],
    resolve: {
      alias: {
        phoenix: path.join(root, "bench/fakePhoenix.ts"),
        "@issue304-app": app,
      },
    },
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: true,
      minify: false,
      rollupOptions: {
        input: path.join(root, "bench/issue304Harness.html"),
      },
    },
  });
  const server = await preview({
    root,
    configFile: false,
    logLevel: "error",
    preview: { port: 0 },
    build: { outDir },
  });
  const address = server.httpServer?.address();
  const port = typeof address === "object" && address ? address.port : address;
  if (typeof port !== "number") throw new Error("preview server has no port");
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => new Promise((resolve) => server.httpServer.close(resolve)),
    buildHash: hash(
      fs
        .readdirSync(path.join(outDir, "assets"))
        .sort()
        .map((file) => `${file}:${hashFile(path.join(outDir, "assets", file))}`)
        .join("\n"),
    ),
  };
}

async function openScenario(page, baseUrl, scenario) {
  await page.goto(`${baseUrl}/bench/issue304Harness.html?token=issue304`, { waitUntil: "load" });
  await page.evaluate(() => window.__issue304Bench.waitReady());
  await page.evaluate((history) => {
    window.__issue304Bench.seed(
      Array.from({ length: 5 }, (_, index) => ({
        agentId: index === 0 ? "agent-viewed" : `agent-bg-${index}`,
        historyCount: history,
      })),
    );
  }, scenario.history);
  await page.waitForTimeout(1_000);
  await page.locator("button.open", { hasText: "agent-viewed" }).click();
  await page.waitForSelector(".log", { timeout: 30_000 });
  if (scenario.expand) {
    await page.locator(".load-earlier").click();
  }
  await page.waitForTimeout(500);
  const textarea = page.locator("textarea").first();
  await textarea.focus();
  return textarea;
}

async function readShape(page, scenario) {
  if (negative === "missing-required-read") {
    const count = await page.locator(".issue304-required-row-does-not-exist").count();
    if (count !== 1) throw new Error("required transcript row read is unavailable");
    return count;
  }
  const rows = await page.locator(".transcript-entry").count();
  const expected = scenario.expand ? scenario.history : 200;
  if (rows !== expected) {
    throw new Error(
      `invalid transcript shape: expected ${expected} rows, received ${rows}`,
    );
  }
  return rows;
}

async function verifyFormatWork(page, baseUrl, scenario, variant) {
  const textarea = await openScenario(page, baseUrl, scenario);
  await readShape(page, scenario);
  await page.evaluate(() => {
    window.__issue304FormatCalls = 0;
  });
  await page.evaluate((seq) => window.__issue304Bench.sendLog("agent-bg-1", seq), scenario.history + 1);
  await page.waitForTimeout(120);
  const backgroundCalls = await page.evaluate(() => window.__issue304FormatCalls ?? -1);
  await page.evaluate(() => {
    window.__issue304FormatCalls = 0;
  });
  for (let step = 0; step < 10; step += 1) {
    await page.evaluate(
      ({ history, step }) => window.__issue304Bench.sendLog("agent-viewed", history + 2 + step),
      { history: scenario.history, step },
    );
    await page.waitForTimeout(80);
  }
  const viewedCalls = await page.evaluate(() => window.__issue304FormatCalls ?? -1);
  await textarea.fill("typing-only");
  await page.waitForTimeout(50);
  const afterTypingCalls = await page.evaluate(() => window.__issue304FormatCalls ?? -1);
  const typingOnlyCalls = afterTypingCalls - viewedCalls;
  const result = { backgroundCalls, viewedCalls, typingOnlyCalls };
  if (variant === "after" && (backgroundCalls !== 0 || viewedCalls !== 10 || typingOnlyCalls !== 0)) {
    throw new Error(`format work mismatch: ${JSON.stringify(result)}`);
  }
  return result;
}

async function armMetrics(page, tick) {
  await page.evaluate(({ tick, disconnected }) => {
    const metrics = {
      inputs: [],
      rAF: [],
      longTasks: [],
      ticks: [],
      pageErrors: [],
      timer: undefined,
    };
    window.__issue304Metrics = metrics;
    const textarea = document.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("input observer target is missing");
    }
    if (!disconnected) {
      textarea.addEventListener("input", (event) => {
        const item = {
          at: performance.timeOrigin + performance.now(),
          inputType: event.inputType,
          composing: event.isComposing,
        };
        metrics.inputs.push(item);
        requestAnimationFrame(() => {
          item.raf = performance.timeOrigin + performance.now();
          metrics.rAF.push(item.raf - item.at);
        });
      });
    }
    if (typeof PerformanceObserver === "undefined") {
      throw new Error("required PerformanceObserver is unavailable");
    }
    const observer = new PerformanceObserver((list) => {
      metrics.longTasks.push(
        ...list.getEntries().map((entry) => ({
          start: entry.startTime,
          duration: entry.duration,
        })),
      );
    });
    observer.observe({ type: "longtask" });
    if (tick > 0) {
      let sequence = 20_000;
      metrics.timer = window.setInterval(() => {
        const started = performance.now();
        window.__issue304Bench.sendLog("agent-viewed", sequence);
        window.__issue304Bench.sendLog("agent-bg-1", sequence);
        sequence += 1;
        metrics.ticks.push(performance.now() - started);
      }, tick);
    }
  }, { tick, disconnected: negative === "disconnect-input-observer" });
}

function monotonicNow() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

async function calibrateBrowserClock(cdp) {
  const parentBefore = monotonicNow();
  const result = await cdp.send("Runtime.evaluate", {
    expression: "performance.timeOrigin + performance.now()",
    returnByValue: true,
  });
  const parentAfter = monotonicNow();
  if (typeof result.result.value !== "number") {
    throw new Error("could not read browser clock");
  }
  const parentMidpoint = (parentBefore + parentAfter) / 2;
  return {
    browserEpoch: result.result.value,
    parentMidpoint,
    offset: result.result.value - parentMidpoint,
    uncertainty: (parentAfter - parentBefore) / 2,
  };
}

async function queueBusyRenderer(page) {
  await page.evaluate(() => {
    window.setTimeout(() => {
      const deadline = performance.now() + 120;
      while (performance.now() < deadline) {
        // Deliberately occupy the renderer for the negative control.
      }
    }, 0);
  });
  await page.waitForTimeout(10);
}

async function sendInputs(page, cdp, mode, clock) {
  let expectedInputs = 0;
  const dispatches = [];
  const browserNow = () => monotonicNow() + clock.offset;
  for (let action = 0; action < actions; action += 1) {
    if (negative === "busy-renderer") await queueBusyRenderer(page);
    if (mode === "ascii") {
      dispatches.push(browserNow());
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "a",
        code: "KeyA",
        text: "a",
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "a",
        code: "KeyA",
      });
      expectedInputs += 1;
    } else {
      const text = ["に", "にほ", "にほん", "日本", "日本語"][action % 5];
      dispatches.push(browserNow());
      await cdp.send("Input.imeSetComposition", {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
      expectedInputs += 1;
      if (action % 5 === 4) {
        dispatches.push(browserNow());
        await cdp.send("Input.insertText", { text: "日本語" });
        expectedInputs += 1;
      }
    }
    await page.waitForFunction(
      (count) => window.__issue304Metrics.inputs.length >= count,
      expectedInputs,
      { timeout: 5_000 },
    );
    await page.waitForTimeout(30);
  }
  return { expectedInputs, dispatches };
}

class MeasurementFailure extends Error {
  constructor(error, record) {
    super(error instanceof Error ? error.message : String(error));
    this.record = record;
  }
}

async function measureRun(browser, server, variant, scenario, mode, run, source) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  let stage = "open";
  let shape = {};
  let partialRaw = null;
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  try {
    stage = "format-work";
    const textarea = await openScenario(page, server.baseUrl, scenario);
    const initialRows = await readShape(page, scenario);
    shape.initialRows = initialRows;
    const formatWork = await verifyFormatWork(page, server.baseUrl, scenario, variant);
    stage = "seed";
    await page.goto(`${server.baseUrl}/bench/issue304Harness.html?token=issue304`, { waitUntil: "load" });
    await page.evaluate(() => window.__issue304Bench.waitReady());
    await page.evaluate((history) => {
      window.__issue304Bench.seed(
        Array.from({ length: 5 }, (_, index) => ({
          agentId: index === 0 ? "agent-viewed" : `agent-bg-${index}`,
          historyCount: history,
        })),
      );
    }, scenario.history);
    await page.waitForTimeout(1_000);
    await page.locator("button.open", { hasText: "agent-viewed" }).click();
    await page.waitForSelector(".log", { timeout: 30_000 });
    if (scenario.expand) await page.locator(".load-earlier").click();
    await page.waitForTimeout(500);
    stage = "initial-shape";
    shape.initialRows = await readShape(page, scenario);
    await textarea.count();
    await page.locator("textarea").first().focus();
    const cdp = await context.newCDPSession(page);
    stage = "clock-calibration";
    const startClock = await calibrateBrowserClock(cdp);
    if (startClock.uncertainty > 20) {
      throw new Error(`clock calibration uncertainty exceeds 20ms: ${startClock.uncertainty}`);
    }
    stage = "arm-metrics";
    await armMetrics(page, negative === "busy-renderer" ? 0 : scenario.tick);
    stage = "inputs";
    const { expectedInputs, dispatches } = await sendInputs(page, cdp, mode, startClock);
    await page.evaluate(() => window.clearInterval(window.__issue304Metrics.timer));
    await page.waitForTimeout(100);
    stage = "read-metrics";
    const raw = await page.evaluate(() => ({
      ...window.__issue304Metrics,
      timer: undefined,
      formatCalls: window.__issue304FormatCalls ?? null,
    }));
    partialRaw = raw;
    stage = "final-shape";
    const finalRows = await page.locator(".transcript-entry").count();
    const expectedFinalRows = scenario.expand
      ? scenario.history + raw.ticks.length
      : 200;
    if (finalRows !== expectedFinalRows) {
      throw new Error(
        `invalid final transcript shape: expected ${expectedFinalRows} rows, received ${finalRows}`,
      );
    }
    shape = { ...shape, finalRows, expectedFinalRows };
    stage = "clock-drift";
    const endClock = await calibrateBrowserClock(cdp);
    const clock = {
      start: startClock,
      end: endClock,
      drift: endClock.offset - startClock.offset,
    };
    if (endClock.uncertainty > 20 || Math.abs(clock.drift) > 5) {
      throw new Error(`clock drift is incompatible with this run: ${JSON.stringify(clock)}`);
    }
    const dispatchToInput = raw.inputs.map((input, index) => input.at - dispatches[index]);
    const dispatchToRaf = raw.inputs.map((input, index) => input.raf - dispatches[index]);
    if (
      raw.inputs.length !== expectedInputs ||
      dispatches.length !== expectedInputs ||
      dispatchToInput.some((value) => !Number.isFinite(value) || value < 0) ||
      dispatchToRaf.some((value) => !Number.isFinite(value) || value < 0) ||
      raw.rAF.length !== expectedInputs ||
      pageErrors.length > 0
    ) {
      throw new Error(
        `incomplete measurement: inputs=${raw.inputs.length}/${expectedInputs}, dispatches=${dispatches.length}, raf=${raw.rAF.length}, errors=${pageErrors.length}`,
      );
    }
    if (negative === "busy-renderer" && stats(dispatchToInput).p95 < 100) {
      throw new Error(`busy renderer did not delay input: p95=${stats(dispatchToInput).p95}`);
    }
    return {
      schema: 1,
      issue: 304,
      variant,
      scenario: scenario.name,
      mode,
      run,
      source,
      clock,
      shape: {
        initialRows,
        finalRows,
        expectedRows: scenario.expand ? scenario.history : 200,
        expectedFinalRows,
      },
      formatWork,
      primary: { dispatchToInput: stats(dispatchToInput) },
      secondary: {
        dispatchToRaf: stats(dispatchToRaf),
        inputToRaf: stats(raw.rAF),
        tickCost: stats(raw.ticks),
      },
      longTasks: raw.longTasks,
      raw: { dispatches, inputs: raw.inputs, ticks: raw.ticks },
      pageErrors,
    };
  } catch (error) {
    throw new MeasurementFailure(error, {
      schema: 1,
      issue: 304,
      status: "failed",
      variant,
      scenario: scenario.name,
      mode,
      run,
      source,
      stage,
      shape,
      raw: partialRaw,
      pageErrors,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await context.close();
  }
}

function validateAcceptance(results) {
  const afterResults = results.filter((result) => result.variant === "after");
  const advisories = [];
  for (const result of afterResults) {
    const p95 = result.primary.dispatchToInput.p95;
    if (p95 === null || p95 > 35 || result.longTasks.length > 1) {
      throw new Error(`acceptance failure for ${result.variant}/${result.scenario}/${result.mode}/run${result.run}`);
    }
  }
  for (const variant of ["after"]) {
    for (const mode of modes) {
      for (const scenario of scenarios.filter((item) => item.tick > 0)) {
        const group = afterResults
          .filter((result) => result.variant === variant && result.mode === mode && result.scenario === scenario.name)
          .map((result) => result.primary.dispatchToInput.p95);
        if (stats(group).median > 25) {
          throw new Error(`p95 median acceptance failure for ${variant}/${scenario.name}/${mode}`);
        }
      }
      const expanded = stats(afterResults.filter((result) => result.variant === variant && result.mode === mode && result.scenario === "h1000-expanded").map((result) => result.primary.dispatchToInput.p95)).median;
      const tail = stats(afterResults.filter((result) => result.variant === variant && result.mode === mode && result.scenario === "h1000-tail").map((result) => result.primary.dispatchToInput.p95)).median;
      if (expanded === null || tail === null || expanded > tail + 8) {
        advisories.push({
          name: "expanded-tail-p95-delta",
          variant,
          mode,
          expanded,
          tail,
          limit: tail === null ? null : tail + 8,
          delta: tail === null ? null : expanded - tail,
        });
      }
    }
  }
  return advisories;
}

function writeArtifact(record) {
  const prefix = record.status === "failed" ? "failure" : record.variant;
  const file = path.join(
    outputRoot,
    `${prefix}-${record.scenario}-${record.mode}-run${record.run}.json`,
  );
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return file;
}

async function main() {
  if (!Number.isInteger(runs) || runs < 1) throw new Error("ISSUE304_RUNS must be positive");
  fs.mkdirSync(outputRoot, { recursive: true });
  const baseline = createBaselineSource();
  const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), "momo304-build-"));
  const source = {
    baselineRevision,
    currentRevision: git(["rev-parse", "HEAD"]),
    generatorSha256: hashFile(fileURLToPath(import.meta.url)),
    current: {
      appSha256: hashFile(path.join(root, "src/App.svelte")),
      detailSha256: hashFile(path.join(root, "src/lib/AgentDetail.svelte")),
      protocolSha256: hashFile(path.join(root, "src/lib/protocol.ts")),
    },
    baseline: {
      appSha256: hashFile(baseline.app),
      detailSha256: hashFile(path.join(baseline.source, "lib/AgentDetail.svelte")),
      protocolSha256: hashFile(path.join(baseline.source, "lib/protocol.ts")),
    },
  };
  const servers = [];
  const browser = await chromium.launch({ headless: true });
  try {
    for (const variant of selectedVariants) {
      servers.push([
        variant,
        await buildVariant(
          variant,
          variant === "baseline" ? baseline.app : path.join(root, "src/App.svelte"),
          buildRoot,
        ),
      ]);
    }
    const results = [];
    for (const [variant, server] of servers) {
      const scopedSource = { ...source, buildSha256: server.buildHash };
      for (const scenario of selectedScenarios) {
        for (const mode of selectedModes) {
          for (let run = 0; run < runs; run += 1) {
            try {
              const result = await measureRun(browser, server, variant, scenario, mode, run, scopedSource);
              const file = writeArtifact(result);
              results.push(result);
              process.stdout.write(`${JSON.stringify({ file, primary: result.primary.dispatchToInput, longTasks: result.longTasks.length })}\n`);
            } catch (error) {
              const record = error instanceof MeasurementFailure
                ? error.record
                : {
                    schema: 1,
                    issue: 304,
                    status: "failed",
                    variant,
                    scenario: scenario.name,
                    mode,
                    run,
                    source: scopedSource,
                    stage: "unknown",
                    shape: {},
                    raw: null,
                    pageErrors: [],
                    error: error instanceof Error ? error.message : String(error),
                  };
              const file = writeArtifact(record);
              process.stderr.write(`${JSON.stringify({ file, status: "failed", stage: record.stage })}\n`);
              throw error;
            }
          }
        }
      }
    }
    if (
      !negative &&
      selectedVariants.length === variants.length &&
      selectedScenarios.length === scenarios.length &&
      selectedModes.length === modes.length &&
      runs === 3
    ) {
      const advisories = validateAcceptance(results);
      for (const advisory of advisories) {
        process.stdout.write(`${JSON.stringify({ status: "advisory", ...advisory })}\n`);
      }
    }
  } finally {
    await browser.close();
    for (const [, server] of servers) await server.close();
    fs.rmSync(baseline.directory, { recursive: true, force: true });
    fs.rmSync(buildRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
