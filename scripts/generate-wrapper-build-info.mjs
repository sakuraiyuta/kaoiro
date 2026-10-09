#!/usr/bin/env node
// Writes a wrapper package's build-info.json from the repository-wide
// identity computation. The generated file travels with the wrapper
// artifact, so a deployed process never has to inspect its checkout.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { consumeBuildIdentity } from "./build-identity.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputArg = process.argv[2];
if (!outputArg) {
  process.stderr.write("generate-wrapper-build-info: output directory is required\n");
  process.exit(64);
}

const outputDir = isAbsolute(outputArg)
  ? outputArg
  : resolve(process.cwd(), outputArg);
const identity = consumeBuildIdentity(repoRoot);
mkdirSync(outputDir, { recursive: true });
writeFileSync(resolve(outputDir, "build-info.json"), `${JSON.stringify(identity, null, 2)}\n`);
