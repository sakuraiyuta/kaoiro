import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const HOME_ROOT_NAMES = [
  ".sandbox_migration", "AGENTS.md", "agents", "auth.json", "cache", "config.toml",
  "goals_1.sqlite", "goals_1.sqlite-shm", "goals_1.sqlite-wal", "hooks",
  "installation_id", "log", "logs_2.sqlite", "logs_2.sqlite-shm", "logs_2.sqlite-wal",
  "memories_1.sqlite", "model-profiles", "models_cache.json", "plugins",
  "queue_1.sqlite", "queue_1.sqlite-shm", "queue_1.sqlite-wal", "sessions",
  "shell_snapshots", "skills", "state_5.sqlite", "state_5.sqlite-shm",
  "state_5.sqlite-wal", "thread-writer-locks", "thread_history_1.sqlite",
  "thread_history_1.sqlite-shm", "thread_history_1.sqlite-wal", "tmp",
];

export function createCodexHomeFixture(dir: string) {
  const home = join(dir, "home");
  mkdirSync(home, { mode: 0o700 });
  const put = (relative: string, content: string) => {
    const path = join(home, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  const links = Object.fromEntries(["AGENTS.md", "agents", "hooks", "model-profiles"].map((name) => {
    const target = join(dir, "external-settings", name);
    mkdirSync(dirname(target), { recursive: true });
    if (name === "AGENTS.md") writeFileSync(target, "EXTERNAL_INSTRUCTIONS");
    else {
      mkdirSync(target);
      writeFileSync(join(target, "private.txt"), "EXTERNAL_NOT_SNAPSHOTTED");
    }
    symlinkSync(target, join(home, name));
    return [name, target];
  }));
  put("auth.json", "ORIGINAL_AUTH");
  put("config.toml", 'model = "fixture-model"\n');
  put("installation_id", "FIXTURE_INSTALLATION");
  put(".sandbox_migration", "v1\n");
  put("models_cache.json", "{}");
  put("sessions/old.jsonl", "OLD_HISTORY\n");
  put("skills/sample/SKILL.md", "LOCAL_SKILL\n");
  for (const name of ["log", "shell_snapshots", "thread-writer-locks", "tmp"]) put(`${name}/discard`, "DISPOSABLE");
  const plugin = "plugins/cache/openai-curated-remote/sample/0.1.0";
  put(`${plugin}/.codex-plugin/plugin.json`, '{"name":"sample","version":"0.1.0"}');
  put(`${plugin}/skills/sample/SKILL.md`, "INSTALLED_PLUGIN_SKILL\n");
  put("plugins/data/sample-openai-curated-remote/local.json", '{"keep":"local-data"}');
  put("plugins/.remote-plugin-install-staging/partial/bundle.json", '{"keep":"staging"}');
  put("cache/codex_apps_tools/tools.json", '{"tools":[]}');
  put("cache/remote_plugin_catalog/catalog.json", '{"plugins":[]}');
  put("cache/tui-pets/assets/frame.webp", "DISPOSABLE_IMAGE");
  // Native SQLite produces WAL-only rows/sidecars; fake .sqlite bytes would
  // bypass the copy-and-inspect behavior that previously mutated source DBs.
  const db = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from 'node:sqlite';
    import { join } from 'node:path';
    const home=process.argv[1];
    const closed=new DatabaseSync(join(home,'memories_1.sqlite'));
    closed.exec('CREATE TABLE _sqlx_migrations(version INTEGER, success INTEGER); INSERT INTO _sqlx_migrations VALUES(1,1)');
    closed.close();
    const open=[];
    for(const stem of ['goals_1','logs_2','queue_1','state_5','thread_history_1']) {
      const db=new DatabaseSync(join(home,stem+'.sqlite'));
      db.exec('PRAGMA journal_mode=WAL; CREATE TABLE _sqlx_migrations(version INTEGER, success INTEGER); INSERT INTO _sqlx_migrations VALUES(1,1)');
      open.push(db);
    }
    process.kill(process.pid,'SIGKILL');
  `, home], { encoding: "utf8" });
  if (db.signal !== "SIGKILL") throw new Error(`SQLite fixture failed: ${db.status}: ${db.stderr}`);
  return { home, links, plugin };
}

export function protectInstructionTargets(links: Record<string, string>, mode: number) {
  for (const target of Object.values(links)) chmodSync(target, mode);
}
