import fs from 'node:fs';
import assert from 'node:assert/strict';
const exact=(a,b)=>a===b;
const includesBytes=(text,input)=>Buffer.from(text,'utf8').includes(Buffer.from(input,'utf8'));
if(process.argv[2]==='--selftest'){
 const input='E_BODY\nreply_ticket=abcdef';
 const wrapped='<system-reminder>\n'+input+'\n</system-reminder>';
 assert.equal(includesBytes(wrapped,input),true);
 assert.equal(includesBytes(wrapped,input.replace('E_BODY','X_BODY')),false);
 assert.equal(includesBytes(wrapped,input.replace('abcdef','abcdeg')),false);
 assert.equal(exact('ticket\n 日本語','ticket\n 日本語'),true);
 assert.equal(exact('ticket\n 日本語','ticket\n  日本語'),false);
 console.log('comparison selftest passed');process.exit(0);
}
const base='/w/out',label=process.argv[2];
const read=s=>fs.existsSync(s)?fs.readFileSync(s,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const events=read(`${base}/${label}.events.jsonl`),requests=read(`${base}/${label}.requests.jsonl`);
const push=events.find(e=>e.type==='seam_push'),payload=push?.payload;
const texts=x=>typeof x==='string'?[x]:Array.isArray(x)?x.flatMap(texts):x&&typeof x==='object'?Object.entries(x).flatMap(([k,v])=>k==='text'&&typeof v==='string'?[v]:k==='content'?texts(v):[]):[];
if(process.argv[3]?.startsWith('--negative-')){
 const variant=process.argv[3]==='--negative-body'?payload.replace('E_INPUT_','X_INPUT_'):payload.replace(/(reply_ticket\":\")([^\"])/,(_,a,b)=>a+(b==='A'?'B':'A'));
 assert.notEqual(variant,payload);
 assert(requests.some(r=>texts(r.body.messages).some(t=>includesBytes(t,variant))),'mutated input must not match captured request');
}
const reqs=requests.map(r=>({request:r.request,contains_exact:payload?texts(r.body.messages).some(t=>includesBytes(t,payload)):false}));
const hooks=events.filter(e=>e.type==='hook'&&e.input.hook_event_name==='UserPromptSubmit');
const initial=hooks[0];
const folded=hooks.filter(e=>payload&&typeof e.input.prompt==='string'&&e.input.prompt.includes(payload.split('\n')[0]));
const result={label,requests:requests.length,push_ms:push?.ms,request_reference:reqs,initial_prompt_id:initial?.input.prompt_id,
 hook_predictions:folded.map(e=>({ms:e.ms,prompt_id:e.input.prompt_id,exact_text:exact(e.input.prompt,payload),same_as_initial:e.input.prompt_id===initial?.input.prompt_id,session_id:e.input.session_id})),
 events:events.filter(e=>['tool_start_marker','tool_end_marker','onTurnStart','onTurnEnd','onAdmissionFailStop','finished','run_error'].includes(e.type)),
 terminals:events.filter(e=>e.type==='sdk_frame'&&e.frame.type==='result').map(e=>({ms:e.ms,frame:e.frame})),
 request_timing:events.filter(e=>e.type==='model_request'),stop_hooks:events.filter(e=>e.type==='hook'&&e.input.hook_event_name==='Stop')};
fs.writeFileSync(`${base}/${label}.check.json`,JSON.stringify(result,null,2));
console.log(JSON.stringify({label,requests:result.requests,reference:reqs,hooks:result.hook_predictions,terminals:result.terminals.map(x=>({ms:x.ms,index:x.frame.result_index,origin:x.frame.origin})),finish:events.find(e=>e.type==='finished')}));
