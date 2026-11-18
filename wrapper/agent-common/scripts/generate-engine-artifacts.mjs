import { readFileSync, writeFileSync } from "node:fs";

const lock = readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8");
const packages = lock.split("\npackages:\n")[1].split("\nsnapshots:\n")[0];
const snapshots = lock.split("\nsnapshots:\n")[1];
const aliases = new Map();
for (const match of snapshots.matchAll(/^      '(@openai\/codex-[^']+)': '(@openai\/codex@[^']+)'$/gm)) {
  aliases.set(match[2], match[1]);
}
const rows = [];
for (const match of packages.matchAll(/^  '([^']+)':\n((?:    .*\n|\n)*)/gm)) {
  const key = match[1];
  const claude = key.match(/^(@anthropic-ai\/claude-agent-sdk-(?:darwin|linux|win32)-[^@]+)@(.+)$/);
  const codex = key.match(/^(@openai\/codex)@(.+)-(darwin|linux|win32)-(arm64|x64)$/);
  if (!claude && !codex) continue;
  const name = claude ? claude[1] : aliases.get(key);
  if (!name) throw new Error(`Missing alias for ${key}`);
  const integrity = match[2].match(/integrity: ([^}]+)}/)?.[1];
  const os = match[2].match(/^    os: \[([^\]]+)\]/m)?.[1];
  const cpu = match[2].match(/^    cpu: \[([^\]]+)\]/m)?.[1];
  if (!integrity || !os || !cpu) throw new Error(`Incomplete artifact ${key}`);
  rows.push({ name, version: claude ? claude[2] : codex[2], integrity, os, cpu });
}
if (!rows.length || aliases.size !== rows.filter(row => row.name.startsWith("@openai/")).length) {
  throw new Error("Engine artifacts or Codex aliases are incomplete");
}
writeFileSync(new URL("../src/engine-artifacts.ts", import.meta.url),
  `export const ENGINE_ARTIFACTS = ${JSON.stringify(rows, null, 2)} as const;\n`);
