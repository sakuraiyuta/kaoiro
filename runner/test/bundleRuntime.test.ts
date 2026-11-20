import { spawnSync } from "node:child_process";
import {
  cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type BuildOptions } from "esbuild";
import { afterEach, beforeEach, expect, it } from "vitest";
import { hostLibc } from "../src/engines.js";

const builder = new URL("../scripts/build-release-bundle.mjs", import.meta.url);
const upload = fileURLToPath(
  new URL("../../wrapper/claude-code/dist/upload.js", import.meta.url),
);
const launcher = fileURLToPath(new URL("../dist/spawn.js", import.meta.url));
const officeFixtures = fileURLToPath(
  new URL("../../wrapper/grok/test/upload-support.ts", import.meta.url),
);
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kaoiro-bundle-runtime-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function bundle(input: string, name: string, breakOffice = false) {
  const { bundleOptions } = await import(builder.href) as {
    bundleOptions: BuildOptions;
  };
  const outfile = join(root, name);
  await build({
    ...bundleOptions,
    entryPoints: [input],
    outfile,
    ...(breakOffice ? {
      banner: { js: bundleOptions.banner!.js +
        '\nrequire.resolve = (id) => { if (id === "file-type") ' +
        'throw new Error("unshipped file-type"); ' +
        'return loadBundleDependency.resolve(id); };' },
    } : {}),
  });
  return outfile;
}

function run(source: string) {
  const result = spawnSync(process.execPath, [source], {
    encoding: "utf8", timeout: 15_000,
    env: {
      ...process.env, NODE_PATH: "",
      KAOIRO_ENGINE_STORE_DIR: join(root, "engines"),
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

it("rejects a missing managed pin only in the bundled launcher", async () => {
  const source = join(root, "spawn.mjs");
  writeFileSync(source, `
import { makeLauncher } from ${JSON.stringify(launcher)};
const launch = makeLauncher([process.execPath, "-e", "", "--"]);
try {
  const child = launch("case", { agent_id: "case" }, ${JSON.stringify(root)});
  child.on("exit", () => console.log(JSON.stringify(child.exitCode)));
} catch (error) {
  console.log(JSON.stringify(error.message));
}
`);
  expect(run(source)).toBe(0);
  expect(run(await bundle(source, "spawn.bundle.mjs")))
    .toMatch(/Pinned claude-code executable is missing/);
});

it("renders the same image, PDF and Office fixtures in the bundle", async () => {
  const target = `${process.platform}-${process.arch}`;
  const variant = target === "linux-x64" && hostLibc() === "musl"
    ? "linuxmusl-x64" : target;
  const modules = fileURLToPath(
    new URL("../../node_modules/.pnpm", import.meta.url),
  );
  for (const name of [`sharp-${variant}`, `sharp-libvips-${variant}`]) {
    const match = readdirSync(modules).filter((e) => e.startsWith(`@img+${name}@`));
    expect(match).toHaveLength(1);
    const dir = join(root, "node_modules/@img");
    mkdirSync(dir, { recursive: true });
    cpSync(join(modules, match[0]!, "node_modules/@img", name),
      join(dir, name), { recursive: true });
  }

  const require = createRequire(upload);
  const { PDFDocument } = require("pdf-lib");
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const image = await require("sharp")({
    create: { width: 2, height: 2, channels: 3, background: "#000" },
  }).png().toBuffer();
  const generator = join(root, "fixtures.mjs");
  writeFileSync(generator, `
import { DOCX, XLSX, PPTX, ooxml } from ${JSON.stringify(officeFixtures)};
const samples = [
  ["word.docx", DOCX, ooxml("docx", "test-document")],
  ["sheet.xlsx", XLSX, ooxml("xlsx", "test-spreadsheet")],
  ["slide.pptx", PPTX, ooxml("pptx", "test-presentation")],
];
console.log(JSON.stringify(samples.map(([filename, mime, bytes]) => ({
  filename, mime, bytes: Buffer.from(bytes).toString("base64"),
}))));
`);
  const office = run(await bundle(generator, "fixtures.bundle.mjs")) as Array<{
    filename: string; mime: string; bytes: string;
  }>;
  const fixtures = [
    { filename: "image.png", mime: "image/png", bytes: image.toString("base64") },
    { filename: "page.pdf", mime: "application/pdf",
      bytes: Buffer.from(await pdf.save()).toString("base64") },
    ...office,
  ];
  const source = join(root, "render.mjs");
  writeFileSync(source, `
import { renderAttachmentBlock } from ${JSON.stringify(upload)};
const result = [];
for (const { filename, mime, bytes } of ${JSON.stringify(fixtures)}) {
  result.push(await renderAttachmentBlock({ filename, mime },
    Buffer.from(bytes, "base64")));
}
console.log(JSON.stringify(result));
`);
  const expected = run(source) as Array<{ ok: boolean }>;
  expect(expected.map(({ ok }) => ok)).toEqual(Array(fixtures.length).fill(true));
  expect(run(await bundle(source, "render.bundle.mjs"))).toEqual(expected);

  // Flipping the runtime resolver should detect the Office regression.
  const broken = run(await bundle(source, "render.broken.mjs", true));
  expect(broken).not.toEqual(expected);
}, 30_000);
