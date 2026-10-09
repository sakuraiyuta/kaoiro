import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installChildFixture } from "./child-process-fixture.mjs";
import { stageReleaseTools } from "../../production-release-tools.mjs";
import { BUILD_REPOSITORY_ID } from "../../build-identity.mjs";
import { originalPushRecord } from "../../landing-backlog.mjs";

export function repairFixture() {
  const root = mkdtempSync(join(tmpdir(), "fuji571-repair-test-"));
  const repo = join(root, "repo"), remote = join(root, "remote.git"), bin = join(root, "bin");
  const git = (...args) => execFileSync("/usr/bin/git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
  mkdirSync(bin);
  stageReleaseTools(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."), repo);
  git("init", "--quiet");
  git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  git("add", "."); git("commit", "--quiet", "-m", "control");
  const control = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "content"), "second"); git("add", "content"); git("commit", "--quiet", "-m", "second");
  const second = git("rev-parse", "HEAD");
  git("init", "--bare", "--quiet", remote); git("remote", "add", "origin", remote);
  git("push", "--quiet", "origin", "HEAD:refs/heads/develop"); git("checkout", "--quiet", control);
  const pushes = [control, second].map((head_sha, index) => ({ id: index + 1, run_number: index + 1,
    event: "push", head_branch: "develop", head_sha, workflow_id: 1,
    created_at: `2026-10-09T00:00:0${index}Z`,
    repository: { id: BUILD_REPOSITORY_ID }, head_repository: { id: BUILD_REPOSITORY_ID } }));
  const current = { ...pushes[1], id: 999, event: "schedule", created_at: "2026-10-09T00:03:00Z" };
  const variables = { KAOIRO_LANDING_FIRST_RUN_ID: "1", KAOIRO_LANDING_ENABLED: "true",
    KAOIRO_LANDING_CONTROL_SHA: control, KAOIRO_IDENTITY_GATES_SHA: control,
    KAOIRO_IDENTITY_V9: "true", KAOIRO_IDENTITY_V10: "true", KAOIRO_RELEASE_ACTORS: '["OperatorOne"]' };
  const records = pushes.map(run => originalPushRecord({ after: run.head_sha, ref: "refs/heads/develop", forced: false, deleted: false }, run, BUILD_REPOSITORY_ID));
  const dataPath = join(root, "api.json"), log = join(root, "git.jsonl"), marker = join(root, "dispatch");
  const data = { pushes, current, variables, records, control, actor: "OperatorOne", remote, log, marker };
  const save = () => writeFileSync(dataPath, JSON.stringify(data)); save();
  const readApi = path => {
    if (path === "user") return { type: "User", login: data.actor };
    if (path === "repos/fixture/repo") return { id: BUILD_REPOSITORY_ID, full_name: "fixture/repo", permissions: { push: true } };
    if (path.includes("/actions/variables?")) return { total_count: Object.keys(data.variables).length, variables: Object.entries(data.variables).map(([name, value]) => ({ name, value })) };
    if (path.endsWith("/actions/workflows/develop-landing.yml")) return { id: 1, path: ".github/workflows/develop-landing.yml" };
    if (path.includes("/actions/workflows/1/runs?")) {
      const query = new URL(`https://fixture.invalid/${path}`).searchParams;
      const [from, through] = query.get("created").split("..").map(Date.parse);
      const rows = data.pushes.filter(run => Date.parse(run.created_at) >= from && Date.parse(run.created_at) <= through);
      return { total_count: rows.length, workflow_runs: rows.slice((Number(query.get("page")) - 1) * 100, Number(query.get("page")) * 100) };
    }
    if (path.endsWith("/999")) return data.current;
    const row = data.pushes.find(run => path.endsWith(`/actions/runs/${run.id}`));
    if (row) return row;
    throw new Error(`unexpected fixture API path: ${path}`);
  };
  // The IPC reader is deliberately fake; refs, blobs, CAS and atomic pushes use real local Git.
  writeFileSync(join(bin, "gh"), `#!${process.execPath}\nconst fs=require('node:fs'),d=JSON.parse(fs.readFileSync(${JSON.stringify(dataPath)})),a=process.argv.slice(2);if(a[0]==='workflow'){fs.writeFileSync(d.marker,'dispatch');process.exit(1);}if(a[0]==='run'){const i=d.pushes.findIndex(r=>r.id===Number(a[2]));fs.writeFileSync(require('node:path').join(a[a.indexOf('--dir')+1],'original-event.json'),JSON.stringify(d.records[i]));process.exit(0);}const p=a[1];let v;if(p==='user')v={type:'User',login:d.actor};else if(p==='repos/fixture/repo')v={id:${BUILD_REPOSITORY_ID},full_name:'fixture/repo',permissions:{push:true}};else if(p.includes('/variables?'))v={total_count:Object.keys(d.variables).length,variables:Object.entries(d.variables).map(([name,value])=>({name,value}))};else if(p.endsWith('/workflows/develop-landing.yml'))v={id:1,path:'.github/workflows/develop-landing.yml'};else if(p.includes('/workflows/1/runs?')){const q=new URL('https://fixture.invalid/'+p).searchParams,[l,u]=q.get('created').split('..').map(Date.parse),r=d.pushes.filter(x=>Date.parse(x.created_at)>=l&&Date.parse(x.created_at)<=u),n=Number(q.get('page'));v={total_count:r.length,workflow_runs:r.slice((n-1)*100,n*100)}}else if(p.endsWith('/999'))v=d.current;else v=d.pushes.find(r=>p.endsWith('/actions/runs/'+r.id));if(!v)process.exit(1);console.log(JSON.stringify(v));\n`, { mode: 0o755 });
  writeFileSync(join(bin, "git"), `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process'),d=JSON.parse(fs.readFileSync(${JSON.stringify(dataPath)}));let a=process.argv.slice(2);fs.appendFileSync(d.log,JSON.stringify(a)+'\\n');a=a.map(x=>x==='git@github.com:fixture/repo.git'?d.remote:x);if(a[0]==='remote'&&a[1]==='add'&&a[3]===d.remote){}if(a[0]==='update-ref'&&process.env.FUJI_FAIL_REF&&a[1].endsWith('/'+process.env.FUJI_FAIL_REF))process.exit(1);if(a[0]==='push'&&a.includes('--atomic')&&process.env.FUJI_REFUSAL){for(const spec of a.slice(-2)){const [obj,ref]=spec.split(':');console.error(' ! [remote rejected] '+obj+' -> '+ref.slice(10)+' ('+(process.env.FUJI_REFUSAL==='workflow'?\"refusing to allow a GitHub App to create or update workflow \\x60.github/workflows/production-release.yml\\x60 without \\x60workflows\\x60 permission\":'permission denied')+')');}process.exit(1);}const r=cp.spawnSync('/usr/bin/git',a,{stdio:'inherit',env:{...process.env,GIT_ALLOW_PROTOCOL:'file'}});process.exit(r.status??1);\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "inert-fixture-token",
    GITHUB_REPOSITORY: "fixture/repo", GITHUB_REPOSITORY_ID: String(BUILD_REPOSITORY_ID), GITHUB_RUN_ID: "999", ...variables };
  const readArtifact = (_repository, run) => {
    const record = data.records[data.pushes.findIndex(row => row.id === run.id)];
    return { record, bytes: Buffer.from(JSON.stringify(record)) };
  };
  const restoreChildren = installChildFixture(bin);
  const preload = join(root, "preload.mjs");
  env.NODE_OPTIONS = `--import=${preload}`;
  writeFileSync(preload, `import { installChildFixture } from ${JSON.stringify(new URL("./child-process-fixture.mjs", import.meta.url).href)}; installChildFixture(${JSON.stringify(bin)}, ${JSON.stringify(env)});`);
  const dependencies = { cwd: repo, readApi, readArtifact, sshSnapshot: () => ({ configurationSha256: "f".repeat(64), gitEnv: env }) };
  const cli = (script, args, extra = {}) => spawnSync(process.execPath, ["--import", preload, join(repo, "scripts", script), ...args], { cwd: repo, env: { ...env, ...extra }, encoding: "utf8", timeout: 30_000 });
  const calls = () => { try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); } catch { return []; } };
  const args = (index = 0) => ["--git-transport", "ssh", "--repository", "fixture/repo", "--original-run", String(index + 1), "--expected-target", pushes[index].head_sha];
  return { root, repo, remote, bin, env, control, second, data, save, git, log, marker, cli, calls, args, dependencies,
    dispose: () => { restoreChildren(); rmSync(root, { recursive: true, force: true }); } };
}
