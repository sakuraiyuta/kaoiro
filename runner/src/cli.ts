// Runner entry point — loads the runner config, connects to the kaoiro server
// on `runner:<host_id>`, registers the host, heartbeats, and supervises the
// host's wrapper processes on operator spawn/stop/restart (ADR-0023, phases
// 4-4a/4-4b). Session enumeration / resume arrive in phase 4-5.
//
// Usage: node dist/cli.js [configPath]
//   configPath defaults to runner.config.json. The auth token is read from
//   KAOIRO_RUNNER_TOKEN (unset = the server's runner auth is disabled, dev).

import { parseRunnerArgs } from "./args.js";
import { buildRegister, loadRunnerConfig, wrapperUrlFrom } from "./config.js";
import { makeLauncher } from "./spawn.js";
import { Supervisor } from "./supervisor.js";
import { RunnerLink } from "./transport.js";

/** Liveness ping cadence; matches the phoenix transport heartbeat default. */
const HEARTBEAT_MS = 30_000;

/** Wait before checking the server's pack manifest — the runner's own
 *  phoenix client is still connecting so a bare-start fetch usually
 *  races the endpoint startup and returns before the packs are ingested. */
const MANIFEST_CHECK_DELAY_MS = 3_000;

/** How long to wait for `/api/personas` before giving up. Best-effort
 *  check; a warn on failure is enough. */
const MANIFEST_FETCH_TIMEOUT_MS = 5_000;

/** Reserved persona the server injects into every host's spawnable set
 *  (HostRegistry, personas.md「デフォルトペルソナ」). It carries no pack
 *  and never appears in `/api/personas`; the allowlist warn skips it. */
const RESERVED_PERSONAS = new Set(["default"]);

function main(): void {
  const { configPath } = parseRunnerArgs(process.argv.slice(2));
  const config = loadRunnerConfig(configPath);
  const token = process.env.KAOIRO_RUNNER_TOKEN;

  // link is assigned just below; the supervisor only calls sendResult after a
  // spawn arrives, long after assignment (mirrors the wrapper's host/link wiring).
  let link: RunnerLink;
  const supervisor = new Supervisor({
    hostId: config.host_id,
    cwdAllowlist: config.cwd_allowlist,
    launch: makeLauncher(),
    wrapperServerUrl: wrapperUrlFrom(config.server_url),
    sendResult: (result) => link.sendSpawnResult(result),
    sendSessions: (sessions) => link.sendSessions(sessions),
  });

  link = new RunnerLink(config.server_url, config.host_id, {
    ...(token === undefined || token === "" ? {} : { token }),
    register: buildRegister(config),
    heartbeatMs: HEARTBEAT_MS,
    onSpawn: (payload) => supervisor.handleSpawn(payload),
    onStop: (payload) => supervisor.handleStop(payload),
    onRestart: (payload) => supervisor.handleRestart(payload),
    onEnumerateSessions: (payload) => supervisor.handleEnumerate(payload),
    onSwitchSession: (payload) => supervisor.handleSwitchSession(payload),
  });

  process.stderr.write(
    `runner: host=${config.host_id} connecting to ${config.server_url}\n`,
  );

  // Best-effort sanity check against the server's persona pack manifest
  // (ADR-0029). The runner's `personas[]` is a per-host allowlist that
  // stays authoritative; server-unknown ids stay spawnable so the runner
  // reconciles later, but a mismatch usually means a missing pack drop
  // and the operator wants to know at startup rather than at first spawn.
  scheduleAllowlistCheck(config.server_url, config.personas);

  const shutdown = (): void => {
    supervisor.stopAll();
    link.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Fires a fetch of `/api/personas` on a short delay (so the server
 *  finishes bootstrapping first) and warns for each config persona whose
 *  sprite_set is not in the server's manifest. Non-blocking / non-fatal:
 *  a warn is all we surface, spawn stays allowed for reconciliation. */
function scheduleAllowlistCheck(
  serverUrl: string,
  personas: { id: string; sprite_set: string }[],
): void {
  setTimeout(() => {
    void fetchAndReport(serverUrl, personas);
  }, MANIFEST_CHECK_DELAY_MS);
}

async function fetchAndReport(
  serverUrl: string,
  personas: { id: string; sprite_set: string }[],
): Promise<void> {
  const url = manifestUrlFrom(serverUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MANIFEST_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      process.stderr.write(
        `runner: manifest check skipped (HTTP ${response.status} from ${url})\n`,
      );
      return;
    }
    const body: unknown = await response.json();
    const known = extractSpriteSets(body);
    for (const persona of personas) {
      if (RESERVED_PERSONAS.has(persona.id)) continue;
      if (!known.has(persona.sprite_set)) {
        process.stderr.write(
          `runner: warn — persona '${persona.id}' (sprite_set=${persona.sprite_set}) ` +
            `is in the local allowlist but not in the server's pack manifest; ` +
            `spawn requests for it will be rejected until a matching pack is ingested\n`,
        );
      }
    }
  } catch (err) {
    process.stderr.write(
      `runner: manifest check failed for ${url}: ${String(err)}\n`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

/** Derives the manifest HTTP endpoint from the runner's WS server_url:
 *  swap `ws(s)://` for `http(s)://` and mount `/api/personas`. */
function manifestUrlFrom(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/api/personas";
  url.search = "";
  return url.toString();
}

function extractSpriteSets(body: unknown): Set<string> {
  if (
    typeof body === "object" &&
    body !== null &&
    "personas" in body &&
    typeof (body as { personas: unknown }).personas === "object" &&
    (body as { personas: unknown }).personas !== null
  ) {
    return new Set(Object.keys((body as { personas: Record<string, unknown> }).personas));
  }
  return new Set();
}

main();
