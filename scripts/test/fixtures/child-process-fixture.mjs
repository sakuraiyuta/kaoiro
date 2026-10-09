import childProcess from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";

export function installChildFixture(bin, fixtureEnvironment = {}) {
  const originals = { execFileSync: childProcess.execFileSync, spawnSync: childProcess.spawnSync };
  for (const name of Object.keys(originals)) {
    childProcess[name] = (file, args, options = {}) => {
      const candidate = join(bin, file);
      if (!file.includes("/") && existsSync(candidate)) {
        return originals[name](candidate, args, { ...options,
          env: { ...options.env, ...fixtureEnvironment, ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => /^(FUJI_|GATE_|LANDING_)/.test(key))) } });
      }
      return originals[name](file, args, options);
    };
  }
  syncBuiltinESMExports();
  return () => { Object.assign(childProcess, originals); syncBuiltinESMExports(); };
}
