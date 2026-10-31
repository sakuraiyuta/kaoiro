import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root=mkdtempSync(join(tmpdir(),'momo-920-fake-'));
try {
  const docker=join(root,'docker');copyFileSync(new URL('./fake-docker.mjs',import.meta.url),docker);chmodSync(docker,0o700);
  const state=join(root,'state.json');const marked='sha256:'+createHash('sha256').update('marked').digest('hex');
  writeFileSync(state,JSON.stringify({tags:{'kaoiro-server:ci':marked},images:{[marked]:'marked'},volumes:[]}));
  const env={...process.env,PATH:`${root}:${process.env.PATH}`,ISSUE920_FAKE_STATE:state,ISSUE920_EXPECTED:resolve('scripts/issue-920-image-probe/c8-expected-tuples.json')};
  delete env.GITHUB_SHA; delete env.GITHUB_EVENT_NAME;
  const r=spawnSync(process.execPath,['scripts/issue-920-image-probe/probe.mjs','.'],{env,encoding:'utf8',maxBuffer:32*1024*1024, timeout:600000});
  process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');
  if(r.status!==0) throw new Error(`probe fake smoke failed: ${r.status}`);
  console.log('FAKE_SMOKE_PASS');
} finally {rmSync(root,{recursive:true,force:true});}
