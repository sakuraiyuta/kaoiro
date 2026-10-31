import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { archiveCopy, compareManifest, writeOldTest, writeVolumeTest } from './copy-check.mjs';

const P = 'd2333a24690d9a00d171a0631fcc856b8acf0e23';
const OLD = '7e2447f2ea14ebd8d08d478bd060e66b12dfdffc';
const C8 = 'c8f75a35be90f683983db9857d32fc9276bd0f53';
const repo = resolve(process.argv[2] || '.');
const hash = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', ['-C', repo, ...args], {encoding:'utf8'}).trim();
const record = (type, values) => console.log(JSON.stringify({type, ...values}));
function command(file, args, options = {}) {
  const result = spawnSync(file, args, {encoding:'utf8', maxBuffer:32*1024*1024, ...options});
  if (result.error || result.signal || result.status !== 0) throw new Error(`${file} ${JSON.stringify(args)} failed: ${result.status} ${result.error || result.signal || result.stderr}`);
  return result.stdout;
}
function replaceOnce(path, before, after) {
  const text = readFileSync(path, 'utf8');
  assert.equal(text.split(before).length, 2, `mutation anchor ${path}`);
  writeFileSync(path, text.replace(before, () => after));
}
function sourceTree(sha, dest) {
  mkdirSync(dest, {recursive:true});
  const data = execFileSync('git', ['-C', repo, 'archive', sha], {maxBuffer:256*1024*1024});
  execFileSync('tar', ['-x','-C',dest], {input:data});
}
function imageBuild(context, tag) {
  command('docker', ['build', '-f', join(context,'server/Dockerfile'), '-t', tag, context], {stdio:'inherit'});
  const id = command('docker', ['image','inspect','--format','{{.Id}}',tag]).trim();
  assert.match(id, /^sha256:[a-f0-9]{64}$/);
  return id;
}
function execTest(file, pattern, env, expected) {
  const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, file], {encoding:'utf8', env:{...process.env,...env}, maxBuffer:16*1024*1024, timeout:120000});
  record('fake-test', {pattern, exit:result.status, stdout:result.stdout, stderr:result.stderr});
  assert.equal(result.status, expected);
  assert.match(result.stdout, expected === 0 ? /# pass 1\b/ : /not ok 1/);
}
function queryModule(dir) { return import(pathToFileURL(join(dir,'server/deploy/kaoiro-server-deploy.mjs')).href); }
function imageQuery(dir) { return import(pathToFileURL(join(dir,'server/deploy/kaoiro-deploy-image-query.mjs')).href); }
function cloneAndChange(dir, root, name, path, before, after) {
  const dest = join(root, name); cpSync(dir, dest, {recursive:true});
  replaceOnce(join(dest,path), before, after);
  record('mutation', {name, path, before, after, sha256:hash(readFileSync(join(dest,path)))});
  return dest;
}

const root = mkdtempSync(join(tmpdir(), 'momo-920-ci-probe-'));
const tags = [];
let volume;
try {
  const head = git('rev-parse','HEAD');
  assert.equal(git('rev-parse','HEAD^'), P);
  const changed=git('diff','--name-only',P,head).split('\n').filter(Boolean);
  assert(changed.length > 0 && changed.includes('.github/workflows/ci.yml'));
  const allowed = new Set(['.github/workflows/ci.yml', ...['c8-expected-tuples.json','p-expected-tuples.json','copy-check.mjs','probe.mjs','fake-docker.mjs','self-check.mjs','smoke.mjs'].map(x => `scripts/issue-920-image-probe/${x}`)]);
  assert.deepEqual(new Set(changed), allowed, 'unexpected P/T product or build input difference');
  if (process.env.GITHUB_SHA) assert.equal(head, process.env.GITHUB_EVENT_NAME === 'pull_request' ? process.env.PROBE_HEAD : process.env.GITHUB_SHA);
  record('identity', {product:P, probe:head, old:OLD, source:C8, platform:process.platform, arch:process.arch});
  const oldDir = join(root,'old-cli'), pDir = join(root,'p-cli');
  archiveCopy(repo, OLD, oldDir); archiveCopy(repo, P, pDir);
  const old = await queryModule(oldDir), prod = await queryModule(pDir), q = await imageQuery(pDir);
  record('docker-version', {value:command('docker',['version','--format','{{json .}}'])});
  const marked = command('docker',['image','inspect','--format','{{.Id}}','kaoiro-server:ci']).trim();
  assert.match(marked,/^sha256:[a-f0-9]{64}$/);
  const oldContext = join(root,'old-context'); sourceTree(C8,oldContext);
  const prefix = `kaoiro-920-probe-${randomUUID()}`;
  const oldTag = `${prefix}:old`; tags.push(oldTag);
  const unmarked = imageBuild(oldContext,oldTag);
  const oldExpected = JSON.parse(readFileSync(new URL('./c8-expected-tuples.json',import.meta.url),'utf8'));
  const pExpected = JSON.parse(readFileSync(new URL('./p-expected-tuples.json',import.meta.url),'utf8'));
  assert.deepEqual(pExpected,oldExpected, 'P source expectations differ from fixed c8 list');
  record('expectations', {old:oldExpected, p:pExpected, serialization:'tuple field order store,env,default_file,default_path; lexical tuple sort; compact JSON UTF-8; no newline', oldSha256:hash(JSON.stringify(oldExpected)), pSha256:hash(JSON.stringify(pExpected)), pSourceSha256:hash(execFileSync('git',['-C',repo,'show',`${P}:server/lib/kaoiro_server/persistence_paths.ex`]))});
  let markedRaw;
  for (const [label,id,expected] of [['marked',marked,pExpected],['unmarked',unmarked,oldExpected]]) {
    assert.equal(old.imageHasPersistencePathsModule('docker',id),true);
    assert.equal(prod.imageHasPersistencePathsModule('docker',id),true);
    const raw = q.queryManifestRaw('docker',id);
    for (const [revision,mod] of [['old',old],['p',prod]]) for (const target of [true,false]) {
      const value = mod.queryPersistencePaths('docker',id,{throwOnShapeViolation:target, env:target ? null : {}});
      assert.equal(value.skipped,false); compareManifest(value.paths,expected);
      record('manifest', {label,id,revision,target,rawSha256:hash(raw),parsedSha256:hash(JSON.stringify(value.paths))});
    }
    assert.equal(q.queryPersistenceContract('docker',id), label === 'marked' ? 'exhaustive_stable_v1' : null);
    if (label === 'marked') markedRaw = raw;
  }
  try { q.queryImageRaw('docker',unmarked,'IO.puts(Jason.encode!(KaoiroServer.PersistencePaths.contract()))'); throw new Error('unmarked raw query unexpectedly succeeded'); }
  catch (error) { if (error.message === 'unmarked raw query unexpectedly succeeded') throw error; record('unmarked-contract-error', {status:error.status,stderr:String(error.stderr || '')}); assert.equal(typeof error.status,'number'); assert(error.status > 0); }
  const entries = JSON.parse(markedRaw); assert.equal(entries.filter(e=>e.env === 'KAOIRO_WORK_STORE_PATH').length,1);
  const rawPath=join(root,'manifest.json'); writeFileSync(rawPath,markedRaw); record('old-test-input',{sha256:hash(markedRaw)});
  const oldTest=writeOldTest(repo,OLD,oldDir);
  const pattern='runUpdate refuses the flag for a store the old image already lists, without probing';
  execTest(oldTest,pattern,{KAOIRO_PROBE_MANIFEST:rawPath},0);
  writeFileSync(rawPath,JSON.stringify(entries.filter(e=>e.env !== 'KAOIRO_WORK_STORE_PATH')));
  execTest(oldTest,pattern,{KAOIRO_PROBE_MANIFEST:rawPath},1);
  writeFileSync(rawPath,markedRaw);
  const pTest=writeVolumeTest(repo,P,pDir);
  execTest(pTest,'new-store guard never creates a missing target volume',{},0);
  for (const argv of [['volume','create','x'],['run','-v','x:/data'],['run','--volume=x:/data'],['run','--mount','type=volume,source=x'],['compose','up'],['compose','create']]) {
    execTest(pTest,'new-store guard never creates a missing target volume',{KAOIRO_PROBE_VOLUME_MUTANT:JSON.stringify(argv)},1);
    record('fake-volume-negative',{argv});
  }
  execTest(pTest,'new-store guard never creates a missing target volume',{},0);
  volume=`${prefix}-volume`; const absent=`${prefix}-absent`;
  const before=command('docker',['volume','ls','-q']).split('\n').filter(Boolean).sort();
  assert(!before.includes(volume) && !before.includes(absent));
  command('docker',['volume','create',volume]);
  assert.equal(prod.namedVolumeExists('docker',volume),true);
  const middle=command('docker',['volume','ls','-q']).split('\n').filter(Boolean).sort();
  assert.equal(prod.namedVolumeExists('docker',absent),false);
  const after=command('docker',['volume','ls','-q']).split('\n').filter(Boolean).sort();
  assert.deepEqual(middle,after);
  record('native-volume',{platform:process.platform,commit:P,command:['volume inspect',volume,absent],present:true,absent:false,before,middle,after,productionDockerVersion:'director must record separately'});
  const contractMut=cloneAndChange(pDir,root,'mut-contract','server/deploy/kaoiro-deploy-image-query.mjs','  } catch {\n    return null;\n  }','  } catch {\n    return PERSISTENCE_CONTRACT;\n  }');
  const mutant=await imageQuery(contractMut);
  assert.throws(()=>assert.equal(mutant.queryPersistenceContract('docker',unmarked),null));
  assert.equal(q.queryPersistenceContract('docker',unmarked),null);
  record('mutation-detected',{name:'contract-failure-as-marked'});
  const manifestSource='server/lib/kaoiro_server/persistence_paths.ex';
  const base='    Enum.map(@stores, fn store ->';
  for (const kind of ['envelope','changed','omitted']) {
    const ctx=join(root,`negative-${kind}`); sourceTree(P,ctx);
    const src=join(ctx,manifestSource);
    if (kind === 'envelope') {
      replaceOnce(src,base,'    %{entries: Enum.map(@stores, fn store ->');
      replaceOnce(src,'    end)\n  end\n\n  @doc """\n  The manifest lists','    end)}\n  end\n\n  @doc """\n  The manifest lists');
    } else if (kind === 'changed') replaceOnce(src,'default_path: KaoiroServer.DetsStorePath.default_path(store.default_file)','default_path: KaoiroServer.DetsStorePath.default_path(store.default_file) <> ".probe"');
    else replaceOnce(src,base,'    Enum.map(Enum.reject(@stores, fn store -> store.env == "KAOIRO_WORK_STORE_PATH" end), fn store ->');
    const tag=`${prefix}:${kind}`; tags.push(tag); const id=imageBuild(ctx,tag);
    if (kind === 'envelope') {
      for (const [name,mod] of [['old',old],['p',prod]]) {
        assert.throws(()=>mod.queryPersistencePaths('docker',id,{throwOnShapeViolation:true}));
        assert.equal(mod.queryPersistencePaths('docker',id,{throwOnShapeViolation:false}).skipped,true);
        const filename = name === 'old' ? 'server/deploy/kaoiro-server-deploy.mjs' : 'server/deploy/kaoiro-deploy-env-v2.mjs';
        const from = name === 'old' ? 'parsed = JSON.parse(raw);\n  } catch (err) {\n    fail(\n      `persistence-path eval' : 'const value = parseUniqueJson(raw);';
        const to = name === 'old' ? 'parsed = JSON.parse(raw); if (!Array.isArray(parsed) && Array.isArray(parsed.entries)) parsed = parsed.entries;\n  } catch (err) {\n    fail(\n      `persistence-path eval' : 'let value = parseUniqueJson(raw); if (!Array.isArray(value) && Array.isArray(value.entries)) value = value.entries;';
        const mutated = cloneAndChange(name === 'old' ? oldDir : pDir,root,`mut-envelope-${name}`,filename,from,to);
        const altered = await queryModule(mutated);
        assert.throws(() => assert.throws(() => altered.queryPersistencePaths('docker',id,{throwOnShapeViolation:true})));
        assert.throws(()=>mod.queryPersistencePaths('docker',id,{throwOnShapeViolation:true}));
        record('negative-envelope',{name,id,mutationDetected:true});
      }
    } else {
      const output=prod.queryPersistencePaths('docker',id); assert.throws(()=>compareManifest(output.paths,pExpected));
      const dir=join(root,`mut-compare-${kind}`); mkdirSync(dir);
      const file=join(dir,'copy-check.mjs');
      writeFileSync(file,readFileSync(new URL('./copy-check.mjs',import.meta.url)));
      const before="ensure(JSON.stringify(canonical(entries)) === JSON.stringify(expected), 'manifest differs from pinned expected list');";
      const after=kind === 'changed' ? "ensure(JSON.stringify(canonical(entries.map(e => ({...e, default_path:e.default_path.replace(/\\.probe$/, '')})))) === JSON.stringify(expected), 'manifest differs from pinned expected list');" : "ensure(JSON.stringify(canonical(entries)) === JSON.stringify(expected.filter(t => t[1] !== 'KAOIRO_WORK_STORE_PATH')), 'manifest differs from pinned expected list');";
      replaceOnce(file,before,after);
      const mutated=await import(pathToFileURL(file).href);
      assert.throws(()=>assert.throws(()=>mutated.compareManifest(output.paths,pExpected)));
      assert.throws(()=>compareManifest(output.paths,pExpected));
      record('negative-entry',{kind,id,mutationDetected:true,mutantSha256:hash(readFileSync(file))});
    }
  }
} finally {
  if (volume) spawnSync('docker',['volume','rm',volume],{stdio:'inherit'});
  for (const tag of tags) spawnSync('docker',['image','rm',tag],{stdio:'inherit'});
  rmSync(root,{recursive:true,force:true});
}
