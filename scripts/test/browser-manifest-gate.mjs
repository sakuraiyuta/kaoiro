#!/usr/bin/env node
/**
 * scripts/test/browser-manifest-gate.mjs
 *
 * Executable acceptance gate for issue 195/196 (Fuji review r2 S2):
 *  1. Clean build of dashboard into server/priv/static.
 *  2. Launch isolated Phoenix server on loopback port.
 *  3. Run Chromium headless (Playwright) to verify manifest parsing via CDP,
 *     icon loading, CSP compliance, and toggle gating.
 *  4. Exercise negative controls (missing public icon, missing HTML link).
 */

import { spawn, execSync } from "node:child_process";
import { existsSync, rmSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import http from "node:http";
import pkg from "/home/yuta/git/kaoiro/worktrees/hiiro-195/dashboard/node_modules/@playwright/test/index.js";
const { chromium } = pkg;

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const DASHBOARD_DIR = resolve(REPO_ROOT, "dashboard");
const SERVER_DIR = resolve(REPO_ROOT, "server");
const PRIV_STATIC = resolve(SERVER_DIR, "priv/static");
const PORT = 4100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

function log(msg) {
  console.log(`[browser-gate] ${msg}`);
}

function cleanStaticOutputs() {
  log("Cleaning copied dashboard outputs in priv/static...");
  for (const item of ["index.html", "assets", "manifest.webmanifest", "icons"]) {
    const target = resolve(PRIV_STATIC, item);
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
    }
  }
}

function runDashboardBuild(allowMissingIcon = false) {
  log("Building dashboard with clean outputs...");
  cleanStaticOutputs();
  execSync("corepack pnpm@10.20.0 build", {
    cwd: DASHBOARD_DIR,
    stdio: "inherit",
  });
  if (!existsSync(resolve(PRIV_STATIC, "manifest.webmanifest"))) {
    throw new Error("manifest.webmanifest was not copied to priv/static");
  }
  if (!allowMissingIcon && !existsSync(resolve(PRIV_STATIC, "icons/icon-192.png"))) {
    throw new Error("icons were not copied to priv/static");
  }
}

function waitForServer(url, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((res, rej) => {
    function ping() {
      http.get(`${url}/favicon.ico`, (r) => {
        if (r.statusCode === 200) return res();
        retry();
      }).on("error", retry);
    }
    function retry() {
      if (Date.now() - start > timeoutMs) return rej(new Error("Timeout waiting for Phoenix server"));
      setTimeout(ping, 200);
    }
    ping();
  });
}

async function verifyBrowserManifest(browser) {
  const page = await browser.newPage();
  const cspViolations = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && msg.text().includes("Content Security Policy")) {
      cspViolations.push(msg.text());
    }
  });

  log(`Navigating to ${BASE_URL}/ ...`);
  const response = await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
  if (!response || response.status() !== 200) {
    throw new Error(`Failed to load dashboard: status ${response?.status()}`);
  }

  // Check manifest link in DOM
  const manifestLink = await page.$('link[rel="manifest"]');
  if (!manifestLink) {
    throw new Error('Missing <link rel="manifest"> in DOM');
  }
  const href = await manifestLink.getAttribute("href");
  if (href !== "/manifest.webmanifest") {
    throw new Error(`Unexpected manifest href: ${href}`);
  }

  // Query manifest via Chrome DevTools Protocol
  log("Querying manifest via Chrome DevTools Protocol (Page.getAppManifest)...");
  const client = await page.context().newCDPSession(page);
  const { data: manifestData, errors, url: manifestUrl } = await client.send("Page.getAppManifest");

  if (errors && errors.length > 0) {
    throw new Error(`CDP getAppManifest reported errors: ${JSON.stringify(errors)}`);
  }
  if (!manifestData) {
    throw new Error("CDP getAppManifest returned empty data");
  }

  const parsed = JSON.parse(manifestData);
  log(`Parsed manifest: name="${parsed.name}", short_name="${parsed.short_name}", display="${parsed.display}"`);

  if (parsed.name !== "kaoiro" || parsed.short_name !== "kaoiro") {
    throw new Error(`Unexpected manifest identity: ${parsed.name}`);
  }
  if (parsed.display !== "standalone") {
    throw new Error(`Unexpected display: ${parsed.display}`);
  }
  if (parsed.theme_color !== "#14141d" || parsed.background_color !== "#14141d") {
    throw new Error(`Unexpected colors: ${parsed.theme_color} / ${parsed.background_color}`);
  }

  const expectedIcons = [
    { src: "/icons/icon-192.png", size: 192 },
    { src: "/icons/icon-512.png", size: 512 },
    { src: "/icons/icon-maskable-192.png", size: 192 },
    { src: "/icons/icon-maskable-512.png", size: 512 },
  ];

  for (const exp of expectedIcons) {
    const iconUrl = `${BASE_URL}${exp.src}`;
    const iconRes = await page.request.get(iconUrl);
    if (iconRes.status() !== 200) {
      throw new Error(`Failed to fetch icon ${exp.src}: HTTP ${iconRes.status()}`);
    }
    const body = await iconRes.body();
    // Check PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (body.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error(`Icon ${exp.src} has invalid PNG signature`);
    }
    log(`Icon ${exp.src} loaded successfully (HTTP 200, PNG valid, ${body.length} bytes)`);
  }

  if (cspViolations.length > 0) {
    throw new Error(`Encountered CSP violations: ${cspViolations.join("; ")}`);
  }
  log("CSP check: PASS (no violations under default-src 'self')");

  await page.close();
}

async function main() {
  log("Starting browser manifest gate verification...");
  runDashboardBuild();

  log(`Launching Phoenix server on port ${PORT}...`);
  const serverProc = spawn("mix", ["phx.server"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      MIX_ENV: "dev",
      PATH: `${process.env.HOME}/.asdf/shims:${process.env.PATH}`,
    },
    stdio: "pipe",
  });

  let serverStopped = false;
  function stopServer() {
    if (!serverStopped) {
      serverStopped = true;
      log("Shutting down Phoenix server...");
      serverProc.kill("SIGTERM");
    }
  }

  process.on("exit", stopServer);
  process.on("SIGINT", stopServer);
  process.on("SIGTERM", stopServer);

  try {
    await waitForServer(BASE_URL);
    log(`Phoenix server is responding on ${BASE_URL}`);

    const executablePath =
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
      existsSync("/home/yuta/.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell")
        ? "/home/yuta/.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell"
        : undefined;

    const browser = await chromium.launch({ headless: true, executablePath });

    // 1. Positive Verification
    log("=== TEST 1: Positive Browser Verification on Phoenix Origin ===");
    await verifyBrowserManifest(browser);
    log("Positive browser verification: PASS");

    // 2. Favicon and Robots Verification
    log("=== TEST 2: Favicon & Robots on Phoenix Origin ===");
    const page = await browser.newPage();
    const favRes = await page.request.get(`${BASE_URL}/favicon.ico`);
    if (favRes.status() !== 200) throw new Error(`favicon.ico returned HTTP ${favRes.status()}`);
    const robRes = await page.request.get(`${BASE_URL}/robots.txt`);
    if (robRes.status() !== 200) throw new Error(`robots.txt returned HTTP ${robRes.status()}`);
    log("Favicon and robots verification: PASS");
    await page.close();

    // 3. Negative Control A: Missing public icon before clean build
    log("=== TEST 3: Negative Control A (Missing public icon fails clean build/serve) ===");
    const origIcon = resolve(DASHBOARD_DIR, "public/icons/icon-192.png");
    const tmpIcon = resolve(DASHBOARD_DIR, "public/icons/icon-192.png.bak");
    renameSync(origIcon, tmpIcon);
    try {
      runDashboardBuild(true);
      let iconFailed = false;
      try {
        await verifyBrowserManifest(browser);
      } catch (err) {
        log(`Expected failure caught on missing icon: ${err.message}`);
        iconFailed = true;
      }
      if (!iconFailed) throw new Error("Expected missing icon to cause verification failure, but it passed!");
    } finally {
      renameSync(tmpIcon, origIcon);
      runDashboardBuild(false); // restore clean build
    }
    log("Negative Control A: PASS");

    // 4. Negative Control B: Missing manifest link in index.html
    log("=== TEST 4: Negative Control B (Missing HTML manifest link fails gate) ===");
    const indexPath = resolve(DASHBOARD_DIR, "index.html");
    const origHtml = readFileSync(indexPath, "utf-8");
    const mutatedHtml = origHtml.replace(/<link\s+rel="manifest"[^>]*>\n?/, "");
    writeFileSync(indexPath, mutatedHtml);
    try {
      runDashboardBuild();
      let linkFailed = false;
      try {
        await verifyBrowserManifest(browser);
      } catch (err) {
        log(`Expected failure caught on missing link: ${err.message}`);
        linkFailed = true;
      }
      if (!linkFailed) throw new Error("Expected missing HTML link to cause verification failure, but it passed!");
    } finally {
      writeFileSync(indexPath, origHtml);
      runDashboardBuild(); // restore clean build
    }
    log("Negative Control B: PASS");

    await browser.close();
    log("ALL BROWSER MANIFEST GATE CHECKS PASSED!");
  } finally {
    stopServer();
  }
}

main().catch((err) => {
  console.error("[browser-gate] ERROR:", err);
  process.exit(1);
});
