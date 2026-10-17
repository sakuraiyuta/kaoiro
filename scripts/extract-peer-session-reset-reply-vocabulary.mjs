import { readFileSync } from "node:fs";

const sourcePath = process.argv[2] ?? "wrapper/core/src/transport.ts";
const source = readFileSync(sourcePath, "utf8");
const declaration = /const\s+PEER_SESSION_RESET_ERROR_REASONS\s*:\s*ReadonlySet<string>\s*=\s*new\s+Set\s*\(\s*\[([\s\S]*?)\]\s*\)\s*;/m.exec(source);

if (declaration === null) {
  throw new Error(`Could not extract PEER_SESSION_RESET_ERROR_REASONS from ${sourcePath}`);
}

const values = [];
const seen = new Set();
const body = declaration[1];
const stringLiteral = /\s*"([^"\\]*)"\s*(?:,|$)/y;
let cursor = 0;

while (body.slice(cursor).trim().length > 0) {
  stringLiteral.lastIndex = cursor;
  const match = stringLiteral.exec(body);

  if (match === null) {
    throw new Error(`Malformed PEER_SESSION_RESET_ERROR_REASONS literal in ${sourcePath}`);
  }

  const value = match[1];

  if (seen.has(value)) {
    throw new Error(`Duplicate peer session reset reply reason ${JSON.stringify(value)} in ${sourcePath}`);
  }

  seen.add(value);
  values.push(value);
  cursor = stringLiteral.lastIndex;
}

if (values.length === 0) {
  throw new Error(`PEER_SESSION_RESET_ERROR_REASONS is empty in ${sourcePath}`);
}

process.stdout.write(`${JSON.stringify(values.sort())}\n`);
