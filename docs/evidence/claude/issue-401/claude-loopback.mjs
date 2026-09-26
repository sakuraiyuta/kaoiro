import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const executable = resolve(process.argv[2]);
if (!existsSync(executable)) throw new Error(`Claude CLI executable not found: ${executable}`);
const root = mkdtempSync(join(tmpdir(), 'fuji401-claude-real-'));
const requests = [];
const shellPidFile = join(root, 'shell.pid');
const sleepPidFile = join(root, 'sleep.pid');
const stubborn = process.argv[3] === 'stubborn';
const command = stubborn
  ? `node -e 'process.on("SIGTERM",()=>{}); require("fs").writeFileSync("${sleepPidFile}",String(process.pid)); setInterval(()=>{},1000)' & echo $$ > ${shellPidFile}; wait`
  : `sleep 90 & echo $! > ${sleepPidFile}; echo $$ > ${shellPidFile}; wait`;
let messageCount = 0;
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    const json = body ? JSON.parse(body) : {};
    requests.push({ method: req.method, url: req.url, stream: json.stream, messages: json.messages?.length });
    if (req.url === '/api/hello') { res.writeHead(200); res.end(); return; }
    if (!req.url.startsWith('/v1/messages')) { res.writeHead(404); res.end(); return; }
    ++messageCount;
    const tool = messageCount === 1;
    const contentBlock = tool ? {type:'tool_use',id:'toolu_fuji401',name:'Bash',input:{}} : {type:'text',text:'done'};
    const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
    emit('message_start',{type:'message_start',message:{id:`msg_fuji401_${messageCount}`,type:'message',role:'assistant',model:'claude-sonnet-5',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}});
    emit('content_block_start',{type:'content_block_start',index:0,content_block:contentBlock});
    if(tool) emit('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify({command})}});
    emit('content_block_stop',{type:'content_block_stop',index:0});
    emit('message_delta',{type:'message_delta',delta:{stop_reason:tool?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:20}});
    emit('message_stop',{type:'message_stop'});
    res.end();
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const addr = server.address();
const child = spawn(executable, ['-p','Execute the shell command','--output-format','stream-json','--verbose','--dangerously-skip-permissions','--model','sonnet'], {
  env: { ...process.env, ANTHROPIC_API_KEY:'fuji401-placeholder', ANTHROPIC_BASE_URL:`http://127.0.0.1:${addr.port}`, CLAUDE_CONFIG_DIR:join(root,'config'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1' },
  cwd: root,
  stdio: ['ignore','pipe','pipe']
});
let stdout='', stderr='';
child.stdout.on('data', x => stdout += x.toString());
child.stderr.on('data', x => stderr += x.toString());
let shellSeen=false;
for(let i=0;i<100;i++) { if(existsSync(shellPidFile) && existsSync(sleepPidFile)) { shellSeen=true; break; } await new Promise(resolve=>setTimeout(resolve,100)); }
const shellPid=shellSeen?Number(readFileSync(shellPidFile,'utf8')):null;
const sleepPid=shellSeen?Number(readFileSync(sleepPidFile,'utf8')):null;
const state = pid => { if(pid===null) return null; try { return readFileSync(`/proc/${pid}/stat`,'utf8').split(' ')[2]; } catch { return null; } };
const before={shell:state(shellPid),sleep:state(sleepPid)};
await new Promise(resolve=>setTimeout(resolve,500));
const beforeSignal={shell:state(shellPid),sleep:state(sleepPid)};
child.kill('SIGTERM');
const timer=setTimeout(() => { if(child.exitCode===null && child.signalCode===null) child.kill('SIGKILL'); }, 5000);
await new Promise(resolve => child.once('exit',resolve));
clearTimeout(timer);
server.close();
console.log(JSON.stringify({mode:stubborn?'stubborn':'sleep',cliPid:child.pid,code:child.exitCode,signal:child.signalCode,shellSeen,shellPid,sleepPid,before,beforeSignal,shellState:state(shellPid),grandchildState:state(sleepPid),requests,toolResult137:stdout.includes('Exit code 137'),stderrTail:stderr.slice(-200)}));
for(const pid of [shellPid,sleepPid]) { if(pid && state(pid) && state(pid)!=='Z') { try { process.kill(pid,'SIGKILL'); } catch {} } }
rmSync(root,{recursive:true,force:true});
