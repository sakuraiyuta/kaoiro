import { execFileSync } from "node:child_process";
import { cpSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { nativeImagePackages, verifyRelease } from "../deploy/verify-release.mjs";

export const bundleOptions = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  define: { __KAOIRO_BUNDLED__: "true" },
  // OfficeParser selects its bundled-code path when require.resolve is absent.
  banner: {
    js: [
      'import { createRequire as createBundleRequire } from "node:module";',
      "const loadBundleDependency = createBundleRequire(import.meta.url);",
      "const require = (id) => loadBundleDependency(id);",
    ].join("\n"),
  },
};

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const [input, root, target] = process.argv.slice(2);
  const modules = join(input, "node_modules/.pnpm");
  const staged = readdirSync(modules);
  for (const name of nativeImagePackages(target)) {
    const packages = staged.filter((entry) => entry.startsWith(`@img+${name}@`));
    if (packages.length !== 1) {
      throw new Error(`Expected one staged @img/${name} for ${target}`);
    }
    cpSync(
      join(modules, packages[0], "node_modules/@img", name),
      join(root, "node_modules/@img", name),
      { recursive: true },
    );
  }

  await build({
    ...bundleOptions,
    entryPoints: [join(input, "dist/kaoiro.js")],
    outfile: join(root, "dist/kaoiro.mjs"),
  });
  const manifestBuilder = fileURLToPath(
    new URL("../../scripts/build-release-manifest.mjs", import.meta.url),
  );
  execFileSync(process.execPath, [manifestBuilder, root, "--bundled"], {
    stdio: "inherit",
  });
  verifyRelease(root, { requireManifest: true, hash: true, target });
}
