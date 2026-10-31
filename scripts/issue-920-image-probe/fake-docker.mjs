#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const stateFile=process.env.ISSUE920_FAKE_STATE;
const state=JSON.parse(readFileSync(stateFile,'utf8'));
const args=process.argv.slice(2);
const output=x=>console.log(typeof x==='string'?x:JSON.stringify(x));
const save=()=>writeFileSync(stateFile,JSON.stringify(state));
const fail=x=>{console.error(x);process.exit(1);};
const id=kind=>'sha256:'+createHash('sha256').update(kind).digest('hex');
const tuples=JSON.parse(readFileSync(process.env.ISSUE920_EXPECTED,'utf8'));
const entries=tuples.map(([store,env,default_file,default_path])=>({store,env,default_file,default_path}));
if (args[0]==='version') output({Client:{Version:'fake'},Server:{Version:'fake'}});
else if (args[0]==='build') { const tag=args[args.indexOf('-t')+1]; const kind=tag.split(':').at(-1); state.tags[tag]=id(kind);state.images[id(kind)]=kind;save(); }
else if (args[0]==='image' && args[1]==='inspect') {const tag=args.at(-1);const result=state.tags[tag];if(!result)fail('unknown image');output(result);}
else if (args[0]==='image' && args[1]==='rm') {delete state.tags[args[2]];save();}
else if (args[0]==='volume' && args[1]==='ls') output(state.volumes.join('\n'));
else if (args[0]==='volume' && args[1]==='create') {state.volumes.push(args[2]);save();output(args[2]);}
else if (args[0]==='volume' && args[1]==='rm') {state.volumes=state.volumes.filter(x=>x!==args[2]);save();}
else if (args[0]==='volume' && args[1]==='inspect') {if(!state.volumes.includes(args[2]))fail('no such volume');output([{Name:args[2]}]);}
else if (args[0]==='run') {
  const image=args.find(a=>/^sha256:[a-f0-9]{64}$/.test(a));const kind=state.images[image];if(!kind)fail('unknown image id');
  const last=args.at(-1);
  if (last.includes('PersistencePaths.beam')) output('present');
  else if (last.includes('PersistencePaths.contract()')) {if(kind==='old')fail('undefined contract');else output('"exhaustive_stable_v1"');}
  else if (last.includes('PersistencePaths.manifest()')) {
    if(kind==='envelope') output({entries});
    else if(kind==='omitted') output(entries.filter(e=>e.env!=='KAOIRO_WORK_STORE_PATH'));
    else if(kind==='changed') output(entries.map(e=>({...e,default_path:e.default_path+'.probe'})));
    else output(entries);
  } else fail('unexpected run');
} else fail('unexpected docker argv');
