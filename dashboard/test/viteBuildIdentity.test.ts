import { build } from "vite";
import { describe, expect, it } from "vitest";

declare const process: { env: Record<string, string | undefined> };

const dashboardRoot = new URL("..", import.meta.url).pathname;
const probeEntry = new URL("./vite_build_identity_probe.ts", import.meta.url).pathname;

describe("Vite build identity ingress", () => {
  it("invalid release env is rendered as the fail-safe dev/unknown identity", async () => {
    const keys = [
      "KAOIRO_BUILD_VERSION",
      "KAOIRO_BUILD_CHANNEL",
      "KAOIRO_BUILD_REVISION",
      "KAOIRO_BUILD_DIRTY",
    ] as const;
    const saved = Object.fromEntries(
      keys.map((key) => [key, process.env[key]]),
    ) as Record<(typeof keys)[number], string | undefined>;

    try {
      process.env.KAOIRO_BUILD_VERSION = "not-calver";
      process.env.KAOIRO_BUILD_CHANNEL = "release";
      process.env.KAOIRO_BUILD_REVISION = "not-a-sha";
      process.env.KAOIRO_BUILD_DIRTY = "false";

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
      expect(labels).toEqual(["kaoiro dev client vunknown / unknown"]);
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
});
