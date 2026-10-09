#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { consumeBuildIdentity } from "./build-identity.mjs";
if (!process.argv[2]) throw new Error("output path is required");
writeFileSync(process.argv[2], `${JSON.stringify(consumeBuildIdentity())}\n`, { flag: "wx" });
