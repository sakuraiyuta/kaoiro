import fs from 'node:fs';
import http from 'node:http';
import {randomUUID,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {runClaudeCli} from '/w/repo/wrapper/claude-code/dist/cli.js';
import {AgentHost} from '/w/repo/wrapper/claude-code/dist/host.js';
import {query} from '/w/repo/wrapper/claude-code/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import {seam} from './seam.mjs';
const base='/w/out';
const tree='/w/scratch';
const label=process.argv[2], mode=label?.slice(0,1);
if(!['B','F','T','P'].includes(mode))throw Error('unknown scenario');
const out=`${base}/${label}`,dir=`${tree}/tmp/e-${label}`;
if(fs.existsSync(out+'.events.jsonl'))throw Error('existing run');
fs.mkdirSync(dir+'/config',{recursive:true});fs.mkdirSync(dir+'/cwd',{recursive:true});
process.chdir(dir+'/cwd');
const started=Date.now();
const rec=(type,data={})=>fs.appendFileSync(out+'.events.jsonl',JSON.stringify({at:new Date().toISOString(),ms:Date.now()-started,type,...data})+'\n');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let host,inject,requests=0,results=0,exitCode=0,injected=false,closing=false;
const children=new Set();
const payload=`E_INPUT_${randomUUID()}\n  exact indentation\n日本語: 検証\nreply_authorization ${JSON.stringify({in_reply_to:7,reply_ticket:randomBytes(32).toString('base64url'),expires_in_ms:300000})}\nEND`;
function pushInput(){if(injected)return;injected=true;rec('seam_push',{payload,priority:mode==='P'?'now':null});inject({type:'user',session_id:'',parent_tool_use_id:null,message:{role:'user',content:payload},...(mode==='P'?{priority:'now'}:{})});}
const command=`printf started > '${dir}/tool-start'; sleep 1; printf ended > '${dir}/tool-end'; printf E_TOOL_DONE`;
async function respond(req,res){
 let raw='';for await(const c of req)raw+=c;
 if(!req.url.startsWith('/v1/messages')){rec('local_aux_request',{url:req.url});res.writeHead(404);res.end('{}');return;}
 const body=JSON.parse(raw);
 if(req.url.includes('count_tokens')){res.setHeader('content-type','application/json');res.end('{"input_tokens":100}');return;}
 const n=++requests;if(n>20){rec('limit',{limit:'model_requests'});exitCode=2;host.close();res.writeHead(429);res.end('{}');return;}
 fs.appendFileSync(out+'.requests.jsonl',JSON.stringify({request:n,body})+'\n');rec('model_request',{request:n});
 if(n===1&&mode==='T'){pushInput();await sleep(250);}
 const blocks=n===1&&mode!=='T'?[{type:'tool_use',id:'toolu_'+randomUUID().replaceAll('-',''),name:'Bash',input:{command,description:'Local bounded timing marker'}}]:[{type:'text',text:`E_RESPONSE_${n}`}];
 const msg={id:'msg_'+randomUUID().replaceAll('-',''),type:'message',role:'assistant',model:body.model,content:blocks,stop_reason:blocks[0].type==='tool_use'?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:100,output_tokens:30}};
 fs.appendFileSync(out+'.responses.jsonl',JSON.stringify({request:n,message:msg})+'\n');
 res.setHeader('content-type','text/event-stream');const emit=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
 emit('message_start',{message:{...msg,content:[],stop_reason:null,usage:{input_tokens:100,output_tokens:0}}});
 for(let i=0;i<blocks.length;i++){const b=blocks[i];emit('content_block_start',{index:i,content_block:b.type==='text'?{type:'text',text:''}:{...b,input:{}}});emit('content_block_delta',{index:i,delta:b.type==='text'?{type:'text_delta',text:b.text}:{type:'input_json_delta',partial_json:JSON.stringify(b.input)}});emit('content_block_stop',{index:i});}
 emit('message_delta',{delta:{stop_reason:msg.stop_reason,stop_sequence:null},usage:{output_tokens:30}});emit('message_stop',{});res.end();
}
const server=http.createServer((req,res)=>respond(req,res).catch(e=>{rec('endpoint_error',{error:String(e)});exitCode=1;res.destroy();host?.close();}));
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const env={PATH:'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C.UTF-8',HOME:dir,CLAUDE_CONFIG_DIR:dir+'/config',ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,ANTHROPIC_API_KEY:'local-dummy',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',CLAUDE_CODE_USE_BEDROCK:'0',CLAUDE_CODE_USE_VERTEX:'0',CLAUDE_CODE_USE_FOUNDRY:'0'};
rec('setup',{label,env_keys:Object.keys(env),endpoint:env.ANTHROPIC_BASE_URL,payload,command});
let seenStart=false,seenEnd=false;
const poll=setInterval(()=>{if(!seenStart&&fs.existsSync(dir+'/tool-start')){seenStart=true;rec('tool_start_marker');if(mode==='F'||mode==='P')pushInput();}if(!seenEnd&&fs.existsSync(dir+'/tool-end')){seenEnd=true;rec('tool_end_marker');}},5);
const timeout=setTimeout(()=>{exitCode=2;rec('limit',{limit:'five_minutes'});host?.close();},295000);
const config={agent_id:'measurement.root',persona:{id:'kogane',name:'Kogane',sprite_set:'kogane'},display_name:'E measurement',server_url:'ws://127.0.0.1:1/wrapper',model:'claude-sonnet-4-6',permission_mode:'bypassPermissions'};
try{
 await runClaudeCli({parseCliArgs:()=>({configPath:'scratch'}),loadConfig:()=>({...config,initial_prompt:'E_ROOT: local timing measurement.'}),
 createServerLink:(_url,_id,options)=>{queueMicrotask(()=>{options.onReplyBasisMode('v1');options.onPersonaPrompt('Local measurement. Follow the fixed tool response.');});return {
 send:e=>rec('wrapper_envelope',{e}),sendInterAgent:async()=>{throw Error('unexpected inter-agent send');},close:()=>rec('link_closed'),currentSessionId:()=>null,setSessionId:()=>{},acknowledgeInterAgentDelivery:()=>{},retireInterAgentDeliveries:()=>true,flushInterAgentRetirements:async()=>{},reportDisconnectIntent:async()=>true,deliveryModes:()=>undefined,
 };},
 createHost:(cfg,options)=>{
  const observed={...options};
  for(const name of ['onTurnStart','onTurnEnd','onPromptAdmitted','onAdmissionFailStop']){const original=options[name];observed[name]=(...args)=>{rec(name,{args});return original?.(...args);};}
  observed.queryOptions={...options.queryOptions,cwd:dir+'/cwd',tools:['Bash'],allowedTools:['Bash'],settingSources:[],persistSession:false,env,maxTurns:8,stderr:s=>fs.appendFileSync(out+'.stderr',s),spawnClaudeCodeProcess:o=>{rec('spawn',{command:o.command,args:o.args});const child=spawn(o.command,o.args,{cwd:dir+'/cwd',env,stdio:['pipe','pipe','pipe'],signal:o.signal});children.add(child);rec('spawned',{pid:child.pid});child.on('exit',(code,signal)=>{rec('child_exit',{pid:child.pid,code,signal});children.delete(child);});return child;}};
  observed.queryFn=({prompt,options:opts})=>{
   const budgetPath=base+'/budget.json';const budget=fs.existsSync(budgetPath)?JSON.parse(fs.readFileSync(budgetPath)):{first_sdk_at:new Date().toISOString(),attempts:[]};
   if(budget.attempts.length>=12||Date.now()-Date.parse(budget.first_sdk_at)>3600000)throw Error('budget exhausted');
   budget.attempts.push({label,at:new Date().toISOString()});fs.writeFileSync(budgetPath,JSON.stringify(budget,null,2));rec('sdk_start');
   const hooks={...opts.hooks};for(const name of ['UserPromptSubmit','PreToolUse','PostToolUse','Stop','StopFailure'])hooks[name]=[{hooks:[async(input,toolUseId)=>{rec('hook',{input,toolUseId});return {};}]} ,...(opts.hooks?.[name]??[])];
   const q=query({prompt:seam(prompt,fn=>{inject=fn;}),options:{...opts,hooks}});
   return new Proxy(q,{get(t,key){if(key===Symbol.asyncIterator)return async function*(){for await(const frame of t){rec('sdk_frame',{frame});if(frame.type==='result'){results++;setTimeout(()=>host.close(),mode==='B'?200:results>=2?200:2000);}yield frame;}};const value=Reflect.get(t,key,t);return typeof value==='function'?value.bind(t):value;}});
  };
  host=new AgentHost(cfg,observed);return host;
 }});
}catch(e){exitCode=1;rec('run_error',{message:String(e),stack:e.stack});}
finally{closing=true;clearInterval(poll);clearTimeout(timeout);host?.close();server.closeAllConnections();await new Promise(r=>server.close(r));await sleep(300);for(const child of children){rec('owned_cleanup_kill',{pid:child.pid});child.kill('SIGKILL');}rec('finished',{exitCode,requests,results,duration_ms:Date.now()-started,owned_children:children.size});}
process.exitCode=exitCode;
