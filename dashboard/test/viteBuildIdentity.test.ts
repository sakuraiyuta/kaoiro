import { build } from "vite";
import { describe, expect, it } from "vitest";
import { buildIdentity } from "../vite.config";

declare const process: { env: Record<string, string | undefined> };

const dashboardRoot = new URL("..", import.meta.url).pathname;
const probeEntry = new URL("./vite_build_identity_probe.ts", import.meta.url).pathname;
const envKeys = [
  "KAOIRO_BUILD_VERSION",
  "KAOIRO_BUILD_CHANNEL",
  "KAOIRO_BUILD_REVISION",
  "KAOIRO_BUILD_DIRTY",
] as const;

const VALID_RELEASE_ENV = {
  KAOIRO_BUILD_VERSION: "2026.9.0",
  KAOIRO_BUILD_CHANNEL: "release",
  KAOIRO_BUILD_REVISION: "0123456789abcdef0123456789abcdef01234567",
  KAOIRO_BUILD_DIRTY: "false",
};

const UNKNOWN_DEV = {
  version: "unknown",
  channel: "dev",
  revision: "unknown",
  dirty: false,
};

async function renderClientLabel(
  values: Record<string, string | undefined>,
): Promise<string[]> {
  const saved = Object.fromEntries(
    envKeys.map((key) => [key, process.env[key]]),
  ) as Record<(typeof envKeys)[number], string | undefined>;

  try {
    for (const key of envKeys) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }

    const result = await build({
      root: dashboardRoot,
      configFile: new URL("../vite.config.ts", import.meta.url).pathname,
      logLevel: "error",
      build: {
        write: false,
        rollupOptions: { input: probeEntry },
      },
    });
    const bundles = Array.isArray(result) ? result : [result];
    const output = bundles
      .flatMap((bundle) => ("output" in bundle ? bundle.output : []))
      .map((entry) => ("code" in entry ? entry.code : ""))
      .join("\n");

    const labels: string[] = [];
    new Function("console", output)({
      log: (label: unknown) => labels.push(String(label)),
    });
    return labels;
  } finally {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

describe("Vite build identity ingress", () => {
  it("accepts a valid explicit release identity", () => {
    expect(buildIdentity(VALID_RELEASE_ENV)).toEqual({
      version: "2026.9.0",
      channel: "release",
      revision: "0123456789abcdef0123456789abcdef01234567",
      dirty: false,
    });
  });

  it.each<[string, Record<string, string | undefined>]>([
    ["version", { ...VALID_RELEASE_ENV, KAOIRO_BUILD_VERSION: "not-calver" }],
    ["revision", { ...VALID_RELEASE_ENV, KAOIRO_BUILD_REVISION: "not-a-sha" }],
    ["channel", { ...VALID_RELEASE_ENV, KAOIRO_BUILD_CHANNEL: "preview" }],
    ["dirty", { ...VALID_RELEASE_ENV, KAOIRO_BUILD_DIRTY: "maybe" }],
    ["release dirty=true", { ...VALID_RELEASE_ENV, KAOIRO_BUILD_DIRTY: "true" }],
    ["release unknown revision", { ...VALID_RELEASE_ENV, KAOIRO_BUILD_REVISION: "unknown" }],
    ["release unknown version", { ...VALID_RELEASE_ENV, KAOIRO_BUILD_VERSION: "unknown" }],
    ["partial env", { KAOIRO_BUILD_VERSION: "2026.9.0" }],
  ])("rejects invalid %s as unknown/dev", (_label, values) => {
    expect(buildIdentity(values)).toEqual(UNKNOWN_DEV);
  });

  it("renders a valid explicit release through the real Vite bundle", async () => {
    await expect(renderClientLabel(VALID_RELEASE_ENV)).resolves.toEqual([
      "kaoiro release client v2026.9.0 / 0123456",
    ]);
  });

  it("renders invalid release env through the real Vite bundle as unknown/dev", async () => {
    await expect(
      renderClientLabel({
        KAOIRO_BUILD_VERSION: "not-calver",
        KAOIRO_BUILD_CHANNEL: "release",
        KAOIRO_BUILD_REVISION: "not-a-sha",
        KAOIRO_BUILD_DIRTY: "false",
      }),
    ).resolves.toEqual(["kaoiro dev client vunknown / unknown"]);
  });
});
