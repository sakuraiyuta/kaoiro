import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Redirect the production readers rather than injecting a different scanner. */
export function cgroupFixture(dir: string): { group: string; preload: string } {
  const base = join(dir, "fake-cgroup"), group = join(base, "kaoiro-test");
  mkdirSync(group, { recursive: true });
  writeFileSync(join(base, "cgroup.controllers"), "cpu memory\n");
  for (const [name, value] of Object.entries({ "cgroup.type": "domain\n", "cgroup.procs": "", "cgroup.events": "populated 0\n" })) writeFileSync(join(group, name), value);
  const preload = join(dir, "cgroup-preload.mjs");
  writeFileSync(preload, `
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const virtual='/sys/fs/cgroup', base=${JSON.stringify(base)};
const mapped=p=>typeof p==='string' && (p===virtual || p.startsWith(virtual+'/')) ? base+p.slice(virtual.length) : p;
for(const name of ['readFileSync','lstatSync','statSync','existsSync','readdirSync']) {
 const original=fs[name];fs[name]=(p,...args)=>original(mapped(p),...args);
}
const realpath=fs.realpathSync;
fs.realpathSync=(p,...args)=>{const result=realpath(mapped(p),...args);return typeof result==='string' && result.startsWith(base) ? virtual+result.slice(base.length) : result;};
syncBuiltinESMExports();
`);
  return { group, preload };
}
