import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function checkBuildFormat(root, configPath, env = process.env, allowUntagged = false) {
  const identity = JSON.parse(readFileSync(join(root, "dist/build-info.json"), "utf8"));
  if (identity.version === "untagged" && !allowUntagged) throw new Error("production activation requires a completed landing tag; use --allow-dirty only for development");
  if (identity.version !== "untagged" && !/^\d{4}\.\d{2}\.\d{2}\.[1-9][0-9]{0,5}$/.test(identity.version)) return;
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const serverUrl = env.KAOIRO_RUNNER_SERVER_URL || config.server_url;
  if (typeof serverUrl !== "string" || !/^wss?:\/\//.test(serverUrl)) throw new Error("invalid runner server_url");
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/api/health";
  url.search = "";
  url.hash = "";
  const signal = AbortSignal.timeout(3_000);
  const response = await fetch(url, { signal, redirect: "error" });
  if (!response.ok) throw new Error("server health request failed");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 65_536) throw new Error("server health response exceeds byte bound");
    chunks.push(chunk);
  }
  const health = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const formats = health.build_identity_formats;
  if (health.status !== "ok" || !Array.isArray(formats) || formats.length > 2 ||
      new Set(formats).size !== formats.length ||
      formats.some(value => !["legacy-calver", "landing-calver-v1"].includes(value)) ||
      !formats.includes("landing-calver-v1")) {
    throw new Error("server does not advertise landing-calver-v1; update the server bridge before stopping this runner");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await checkBuildFormat(process.argv[2], process.argv[3], process.env, process.argv[4] === "yes");
  } catch (error) {
    console.error(`kaoiro-runner: build format preflight refused: ${error.message}`);
    process.exitCode = 78;
  }
}
