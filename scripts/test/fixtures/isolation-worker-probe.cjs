"use strict";
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
assert.equal(process.env.NODE_OPTIONS, undefined);
assert.deepEqual(process.execArgv, []);
const guardPath = require.resolve("./test-isolation.cjs");
const guard = require(guardPath);
const { Worker, SHARE_ENV } = require("node:worker_threads");
const [mode, root] = process.argv.slice(2);
const refused = { R1a: { env: {} }, R1b: { env: SHARE_ENV }, R2a: { execArgv: [] }, R2b: { execArgv: ["--trace-warnings"] } };
if (refused[mode]) {
  assert.throws(() => new Worker("0", { eval: true, ...refused[mode] }), { code: "ERR_TEST_ISOLATION" }, `${mode} refusal`);
} else {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

async function main() {
  const owned = join(root, "owned"), foreign = join(root, "foreign"), sink = join(root, "sink");
  mkdirSync(owned); mkdirSync(foreign);
  writeFileSync(sink, "");
  writeFileSync(join(owned, "gh"), "#!/bin/sh\nprintf owned\n", { mode: 0o700 });
  for (const name of ["gh", "systemctl"]) {
    writeFileSync(join(foreign, name), `#!/bin/sh\nprintf reached >> '${sink.replaceAll("'", "'\\''")}'\n`, { mode: 0o700 });
  }
  guard.registerOwnedRoot(owned);
  guard.registerForeignRoot(foreign);
  if (mode === "permit") {
    process.env.KAOIRO_ISOLATION_SELF_PROBE = "1";
    assert.equal(require("./test-isolation-permit-probe.cjs").permitSelfProbe(), true);
  }
  const state = globalThis[Symbol.for("kaoiro.test.isolation")];
  const body = `
    const assert = require('node:assert/strict');
    const { Worker, parentPort, workerData: d } = require('node:worker_threads');
    const state = globalThis[Symbol.for('kaoiro.test.isolation')];
    assert.ok(state, 'worker guard missing');
    assert.equal(state.child, true, 'I1 child state missing');
    for (const root of d.roots) assert.ok(state.roots.includes(root), 'owned root missing');
    assert.deepEqual(state.foreign, d.foreignRoots);
    assert.deepEqual(state.inert, d.inert);
    assert.deepEqual([...state.permitted], d.permitted);
    assert.equal(process.execArgv[0], '--require', 'I2 explicit preload prefix missing');
    assert.equal(process.execArgv[1], d.guard, 'I2 explicit guard path missing');
    assert.equal(process.execArgv.filter((x,i) => x === '--require' && process.execArgv[i+1] === d.guard).length, 1, 'I3 guard occurrence count');
    const cp = require('node:child_process');
    assert.throws(() => cp.execFileSync(d.foreign + '/gh'), {code:'ERR_TEST_HOST_TOOL'});
    assert.equal(cp.execFileSync(d.owned + '/gh', {encoding:'utf8'}), 'owned');
    if (d.permitted.includes('systemd')) cp.execFileSync(d.foreign + '/systemctl');
    else assert.throws(() => cp.execFileSync(d.foreign + '/systemctl'), {code:'ERR_TEST_HOST_SYSTEMD'});
    const child = cp.spawnSync(process.execPath, ['-e', "const s=globalThis[Symbol.for('kaoiro.test.isolation')]; if(!s?.child)process.exit(7); try{require('node:child_process').execFileSync(process.argv[1]);}catch(e){if(e.code==='ERR_TEST_HOST_TOOL')process.exit(0);throw e;}process.exit(8)", d.foreign + '/gh'], {encoding:'utf8'});
    assert.equal(child.status, 0, child.stderr);
    (async () => {
      await assert.rejects(require('node:dns').promises.resolve4('example.com'), {code:'ERR_TEST_NETWORK'});
      const net = require('node:net');
      await new Promise((resolve,reject) => {
        const socket=net.connect({host:'192.0.2.1',port:9});
        socket.once('connect',()=>{socket.destroy();reject(new Error('outbound connected'));});
        socket.once('error',e=>{try{assert.equal(e.code,'ERR_TEST_NETWORK');resolve();}catch(e){reject(e);}});
      });
      const udp=require('node:dgram').createSocket('udp4');
      try { assert.throws(()=>udp.send('x',9,'192.0.2.1'), {code:'ERR_TEST_NETWORK'}); } finally { udp.close(); }
      const server=net.createServer(socket=>socket.end('loopback'));
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      try {
        const value=await new Promise((resolve,reject)=>{const s=net.connect(server.address().port,'127.0.0.1');s.once('data',d=>{s.destroy();resolve(String(d));});s.once('error',reject);});
        assert.equal(value,'loopback');
      } finally { await new Promise(resolve=>server.close(resolve)); }
      if(d.nested) {
        const child=new Worker(d.body,{eval:true,workerData:{...d,nested:false}});
        let seen=false; child.once('message',value=>{assert.equal(value,'guarded');seen=true;});
        await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>{try{assert.equal(code,0);assert.ok(seen);resolve();}catch(e){reject(e);}});});
      }
      parentPort.postMessage('guarded');
    })().catch(error=>{throw error;});
  `;
  const data = { guard: guardPath, owned, foreign, roots: state.roots, foreignRoots: state.foreign,
    inert: state.inert, permitted: [...state.permitted], body, nested: mode === "inherited" };
  let filename = body, options = { eval: true, workerData: data };
  if (mode === "cjs" || mode === "esm") {
    const file = join(root, `worker.${mode === "cjs" ? "cjs" : "mjs"}`);
    writeFileSync(file, (mode === "esm" ? "import { createRequire } from 'node:module'; const require=createRequire(import.meta.url);\n" : "") + body);
    filename = mode === "esm" ? pathToFileURL(file) : file;
    options = { workerData: data };
  }
  await Promise.all(Array.from({ length: mode === "esm" ? 2 : 1 }, () => new Promise((resolve, reject) => {
    const worker = new Worker(filename, options);
    assert.ok(worker instanceof Worker);
    let seen = false;
    worker.once("message", value => { assert.equal(value, "guarded"); seen = true; });
    worker.once("error", reject);
    worker.once("exit", code => { try { assert.equal(code, 0); assert.ok(seen); resolve(); } catch (error) { reject(error); } });
  })));
  assert.equal(readFileSync(sink, "utf8"), mode === "permit" ? "reached" : "");
}
