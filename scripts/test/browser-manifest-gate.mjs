#!/usr/bin/env node
/**
 * scripts/test/browser-manifest-gate.mjs
 *
 * Executable acceptance gate for issue 195/196 (Fuji review r1/r2):
 *  1. Clean build of dashboard into server/priv/static.
 *  2. Launch isolated Phoenix server on loopback port with isolated TMPDIR.
 *  3. Run Chromium headless (Playwright) to verify manifest parsing via CDP,
 *     icon loading and decoding in browser context, CSP compliance, and toggle gating.
 *  4. Exercise negative controls (missing public icon, missing HTML link,
 *     wrong icon dimensions/transparency, wrong manifest declarations,
 *     and executable override).
 */

import { spawn, execSync } from "node:child_process";
import {
  existsSync,
  rmSync,
  renameSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdtempSync,
  readdirSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import http from "node:http";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const DASHBOARD_DIR = resolve(REPO_ROOT, "dashboard");
const SERVER_DIR = resolve(REPO_ROOT, "server");
const PRIV_STATIC = resolve(SERVER_DIR, "priv/static");
const PORT = 4100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const dashboardRequire = createRequire(resolve(DASHBOARD_DIR, "package.json"));
const { chromium } = dashboardRequire("@playwright/test");

function log(msg) {
  console.log(`[browser-gate] ${msg}`);
}

function resolveChromiumExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  try {
    const defaultPath = chromium.executablePath();
    if (existsSync(defaultPath)) {
      return defaultPath;
    }
  } catch (e) {
    // Ignore and fallback to cache discovery
  }

  const cacheDir =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    resolve(process.env.HOME || "", ".cache/ms-playwright");
  if (existsSync(cacheDir)) {
    for (const entry of readdirSync(cacheDir)) {
      const candidates = [
        resolve(cacheDir, entry, "chrome-linux64/chrome"),
        resolve(cacheDir, entry, "chrome-headless-shell-linux64/chrome-headless-shell"),
      ];
      for (const cand of candidates) {
        if (existsSync(cand)) {
          return cand;
        }
      }
    }
  }
  return undefined;
}

const EXPECTED_MANIFEST_ICONS = [
  {
    src: "/icons/icon-192.png",
    sizes: "192x192",
    type: "image/png",
    purpose: "any",
    width: 192,
    height: 192,
    maskable: false,
  },
  {
    src: "/icons/icon-512.png",
    sizes: "512x512",
    type: "image/png",
    purpose: "any",
    width: 512,
    height: 512,
    maskable: false,
  },
  {
    src: "/icons/icon-maskable-192.png",
    sizes: "192x192",
    type: "image/png",
    purpose: "maskable",
    width: 192,
    height: 192,
    maskable: true,
  },
  {
    src: "/icons/icon-maskable-512.png",
    sizes: "512x512",
    type: "image/png",
    purpose: "maskable",
    width: 512,
    height: 512,
    maskable: true,
  },
];

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

  // Check HTTP response & Content-Type of /manifest.webmanifest
  log("Fetching /manifest.webmanifest directly to verify HTTP status and Content-Type...");
  const manifestRes = await page.request.get(`${BASE_URL}/manifest.webmanifest`);
  if (manifestRes.status() !== 200) {
    throw new Error(`Failed to fetch /manifest.webmanifest: HTTP ${manifestRes.status()}`);
  }
  const manifestContentType = manifestRes.headers()["content-type"];
  if (!manifestContentType || !manifestContentType.includes("application/manifest+json")) {
    throw new Error(`Unexpected Content-Type for manifest: ${manifestContentType}`);
  }
  log(`Manifest HTTP response valid (HTTP 200, Content-Type: ${manifestContentType})`);

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
  if (manifestUrl !== `${BASE_URL}/manifest.webmanifest`) {
    throw new Error(`Unexpected manifest URL from CDP: ${manifestUrl}`);
  }

  const parsed = JSON.parse(manifestData);
  log(`Parsed manifest: name="${parsed.name}", short_name="${parsed.short_name}", display="${parsed.display}", start_url="${parsed.start_url}"`);

  if (parsed.name !== "kaoiro" || parsed.short_name !== "kaoiro") {
    throw new Error(`Unexpected manifest identity: ${parsed.name}`);
  }
  if (parsed.display !== "standalone") {
    throw new Error(`Unexpected display: ${parsed.display}`);
  }
  if (parsed.start_url !== "/") {
    throw new Error(`Unexpected start_url: ${parsed.start_url}`);
  }
  if (parsed.theme_color !== "#14141d" || parsed.background_color !== "#14141d") {
    throw new Error(`Unexpected colors: ${parsed.theme_color} / ${parsed.background_color}`);
  }

  // Validate manifest icons declarations
  if (!Array.isArray(parsed.icons) || parsed.icons.length !== EXPECTED_MANIFEST_ICONS.length) {
    throw new Error(
      `Manifest icons count mismatch: declared ${parsed.icons?.length ?? 0}, expected ${EXPECTED_MANIFEST_ICONS.length}`
    );
  }

  for (const exp of EXPECTED_MANIFEST_ICONS) {
    const declared = parsed.icons.find((i) => i.src === exp.src);
    if (!declared) {
      throw new Error(`Manifest missing declared icon for ${exp.src}`);
    }
    if (declared.sizes !== exp.sizes) {
      throw new Error(`Manifest icon ${exp.src} declares sizes="${declared.sizes}", expected "${exp.sizes}"`);
    }
    if (declared.type !== exp.type) {
      throw new Error(`Manifest icon ${exp.src} declares type="${declared.type}", expected "${exp.type}"`);
    }
    if (declared.purpose !== exp.purpose) {
      throw new Error(`Manifest icon ${exp.src} declares purpose="${declared.purpose}", expected "${exp.purpose}"`);
    }
    log(`Manifest icon declaration valid for ${exp.src} (${declared.sizes}, ${declared.type}, ${declared.purpose})`);
  }

  // In-browser decoding and pixel verification under CSP
  for (const exp of EXPECTED_MANIFEST_ICONS) {
    const iconUrl = `${BASE_URL}${exp.src}`;
    const iconRes = await page.request.get(iconUrl);
    if (iconRes.status() !== 200) {
      throw new Error(`Failed to fetch icon ${exp.src}: HTTP ${iconRes.status()}`);
    }
    const body = await iconRes.body();
    if (body.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error(`Icon ${exp.src} has invalid PNG signature`);
    }

    const decoded = await page.evaluate(async ({ src, isMaskable }) => {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);

            let opaque = true;
            let cornerMatchesBackground = true;
            if (isMaskable) {
              const w = img.naturalWidth;
              const h = img.naturalHeight;
              const corners = [
                ctx.getImageData(0, 0, 1, 1).data,
                ctx.getImageData(w - 1, 0, 1, 1).data,
                ctx.getImageData(0, h - 1, 1, 1).data,
                ctx.getImageData(w - 1, h - 1, 1, 1).data,
              ];
              for (const c of corners) {
                if (c[3] !== 255) opaque = false;
                if (c[0] !== 20 || c[1] !== 20 || c[2] !== 29) {
                  cornerMatchesBackground = false;
                }
              }
            }

            resolve({
              naturalWidth: img.naturalWidth,
              naturalHeight: img.naturalHeight,
              opaque,
              cornerMatchesBackground,
            });
          } catch (e) {
            reject(e.message);
          }
        };
        img.onerror = () => reject(new Error(`Failed to decode image from ${src}`));
        img.src = src;
      });
    }, { src: exp.src, isMaskable: exp.maskable });

    if (decoded.naturalWidth !== exp.width || decoded.naturalHeight !== exp.height) {
      throw new Error(
        `Icon ${exp.src} decoded dimensions ${decoded.naturalWidth}x${decoded.naturalHeight}, expected ${exp.width}x${exp.height}`
      );
    }
    if (exp.maskable) {
      if (!decoded.opaque) {
        throw new Error(`Maskable icon ${exp.src} contains non-opaque pixels in corners`);
      }
      if (!decoded.cornerMatchesBackground) {
        throw new Error(`Maskable icon ${exp.src} corners do not match expected background #14141d`);
      }
    }
    log(`Icon ${exp.src} decoded successfully in browser (${decoded.naturalWidth}x${decoded.naturalHeight}, maskable=${exp.maskable})`);
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

  const isolatedTmpDir = mkdtempSync(resolve(tmpdir(), "kaoiro-browser-gate-"));
  log(`Using isolated TMPDIR: ${isolatedTmpDir}`);

  const serverEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("KAOIRO_")) {
      serverEnv[k] = v;
    }
  }
  serverEnv.PORT = String(PORT);
  serverEnv.MIX_ENV = "dev";
  serverEnv.TMPDIR = isolatedTmpDir;
  serverEnv.PATH = `${process.env.HOME}/.asdf/shims:${process.env.PATH}`;

  log(`Launching Phoenix server on port ${PORT}...`);
  const serverProc = spawn("mix", ["phx.server"], {
    cwd: SERVER_DIR,
    env: serverEnv,
    stdio: "pipe",
  });

  let serverStopped = false;
  function stopServer() {
    if (!serverStopped) {
      serverStopped = true;
      log("Shutting down Phoenix server...");
      serverProc.kill("SIGTERM");
      try {
        rmSync(isolatedTmpDir, { recursive: true, force: true });
        log("Cleaned up isolated TMPDIR.");
      } catch (e) {
        // ignore
      }
    }
  }

  process.on("exit", stopServer);
  process.on("SIGINT", stopServer);
  process.on("SIGTERM", stopServer);

  try {
    await waitForServer(BASE_URL);
    log(`Phoenix server is responding on ${BASE_URL}`);

    // Executable override test (Negative Control pinning M1)
    log("=== TEST: Executable Override Negative Control ===");
    let overrideFailed = false;
    try {
      await chromium.launch({
        headless: true,
        executablePath: "/tmp/nonexistent-chromium-path-override",
      });
    } catch (err) {
      log(`Expected launch failure caught with invalid executable override: ${err.message}`);
      overrideFailed = true;
    }
    if (!overrideFailed) {
      throw new Error("Expected launch with invalid executablePath override to fail, but it succeeded!");
    }
    log("Executable override negative control: PASS");

    const executablePath = resolveChromiumExecutable();
    log(`Launching Chromium with executablePath: ${executablePath || "default Playwright resolution"}`);
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
      runDashboardBuild(false);
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
      runDashboardBuild();
    }
    log("Negative Control B: PASS");

    // 5. Negative Control C: Wrong icon dimensions & transparent maskable (M2)
    log("=== TEST 5: Negative Control C (Wrong icon dimensions & non-opaque maskable fail gate) ===");
    const maskable512Path = resolve(DASHBOARD_DIR, "public/icons/icon-maskable-512.png");
    const icon16Path = resolve(DASHBOARD_DIR, "public/icons/icon-16.png");
    const backupMaskable512 = resolve(DASHBOARD_DIR, "public/icons/icon-maskable-512.png.bak");
    copyFileSync(maskable512Path, backupMaskable512);
    try {
      copyFileSync(icon16Path, maskable512Path);
      runDashboardBuild();
      let dimensionFailed = false;
      try {
        await verifyBrowserManifest(browser);
      } catch (err) {
        log(`Expected failure caught on wrong icon dimensions/maskable: ${err.message}`);
        dimensionFailed = true;
      }
      if (!dimensionFailed) {
        throw new Error("Expected wrong icon dimension to cause verification failure, but it passed!");
      }
    } finally {
      copyFileSync(backupMaskable512, maskable512Path);
      rmSync(backupMaskable512, { force: true });
      runDashboardBuild();
    }
    log("Negative Control C: PASS");

    // 6. Negative Control D: Wrong manifest icon declarations (M2)
    log("=== TEST 6: Negative Control D (Wrong manifest icon declarations fail gate) ===");
    const manifestPath = resolve(DASHBOARD_DIR, "public/manifest.webmanifest");
    const origManifest = readFileSync(manifestPath, "utf-8");
    try {
      const parsedManifest = JSON.parse(origManifest);
      for (const icon of parsedManifest.icons) {
        icon.sizes = "16x16";
        icon.purpose = "any";
      }
      writeFileSync(manifestPath, JSON.stringify(parsedManifest, null, 2));
      runDashboardBuild();
      let declarationFailed = false;
      try {
        await verifyBrowserManifest(browser);
      } catch (err) {
        log(`Expected failure caught on wrong manifest declarations: ${err.message}`);
        declarationFailed = true;
      }
      if (!declarationFailed) {
        throw new Error("Expected wrong manifest declarations to cause verification failure, but it passed!");
      }
    } finally {
      writeFileSync(manifestPath, origManifest);
      runDashboardBuild();
    }
    log("Negative Control D: PASS");

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
