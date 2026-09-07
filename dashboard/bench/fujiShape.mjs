import {chromium} from '@playwright/test';
import {createServer, build, preview} from 'vite';
import fs from 'node:fs';
const out='/tmp/fuji304-measure';const root=process.cwd();
fs.copyFileSync(root+'/src/App.svelte',root+'/src/.App.before.bench.svelte');
const prod=process.env.FUJI_PROD==='1';
const configFile=root+'/bench/vite.harness.config.ts';
let server,base;
if(prod){
 await build({root,configFile,logLevel:'error',build:{outDir:out+'/prod',emptyOutDir:true,sourcemap:true,minify:false,rollupOptions:{input:root+'/bench/harnessApp.html'}}});
 server=await preview({root,configFile,build:{outDir:out+'/prod'},preview:{port:0}});
 base='http://localhost:'+server.httpServer.address().port;
}else{server=await createServer({root,configFile,server:{port:0},logLevel:'error'});await server.listen();base='http://localhost:'+server.httpServer.address().port;}
const browser=await chromium.launch({headless:true});
const stats=a=>{a=[...a].sort((a,b)=>a-b);return{n:a.length,median:a[Math.floor(a.length*.5)]??null,p95:a[Math.min(a.length-1,Math.floor(a.length*.95))]??null,max:a.at(-1)??null}};
try{
 const matrix=process.env.FUJI_MATRIX?JSON.parse(process.env.FUJI_MATRIX):Array.from({length:3},(_,run)=>['ascii','ime','insert'].flatMap(mode=>[0,100].map(tick=>({run,mode,tick,history:5000})))).flat();
 for(const cfg of matrix){
  const {run,mode,tick,history}=cfg;const label=`${cfg.expand?'expanded':'tail'}-${prod?"prod":"dev"}-${cfg.source??"both"}-${mode}-tick${tick}-h${history}-r${run}`;
  const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(base+'/bench/harnessApp.html?variant=after&token=bench-after');await page.evaluate(()=>window.__bench.waitReady());
  await page.evaluate(h=>window.__bench.seed(Array.from({length:5},(_,i)=>({agentId:i?'agent-bg-'+i:'agent-viewed',historyCount:h,ext:{slash_commands:['new','clear','help']}}))),history);
  await page.waitForTimeout(1500);await page.locator('button.open',{hasText:'agent-viewed'}).click();await page.waitForSelector('.log');await page.waitForTimeout(700);if(cfg.expand){await page.locator('.load-earlier').click();await page.waitForTimeout(500)}await page.locator('textarea').first().focus();
  const cdp=await context.newCDPSession(page);await cdp.send('Profiler.enable');await cdp.send('Profiler.setSamplingInterval',{interval:1000});
  await page.evaluate(({tick,history,source})=>{
   window.fuji={localeCount:0,localeMs:0,inputs:[],frames:[],long:[],events:[],ticks:[],compositions:[],active:true};const f=window.fuji;
   const original=Date.prototype.toLocaleTimeString;Date.prototype.toLocaleTimeString=function(...args){const t=performance.now();try{return original.apply(this,args)}finally{f.localeCount++;f.localeMs+=performance.now()-t}};
   const el=document.querySelector('textarea');el.addEventListener('input',e=>{const t=performance.now();const row={at:t,eventTs:e.timeStamp,type:e.inputType,composing:e.isComposing,trusted:e.isTrusted};f.inputs.push(row);requestAnimationFrame(()=>{row.raf=performance.now()-t;row.frameEpoch=performance.timeOrigin+performance.now()})},{capture:true});
   for(const name of ['compositionstart','compositionupdate','compositionend'])el.addEventListener(name,e=>f.compositions.push({type:e.type,data:e.data}));
   new PerformanceObserver(l=>f.long.push(...l.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask'});
   new PerformanceObserver(l=>f.events.push(...l.getEntries().map(e=>({name:e.name,duration:e.duration,delay:e.processingStart-e.startTime,processing:e.processingEnd-e.processingStart})))).observe({type:'event',durationThreshold:16});
   let last=performance.now();function frame(){const t=performance.now();f.frames.push(t-last);last=t;if(f.active)requestAnimationFrame(frame)}requestAnimationFrame(frame);
   let seq=history+10000;if(tick)f.timer=setInterval(()=>{const t=performance.now();if(source!=='background')window.__bench.sendLog('agent-viewed',seq);if(source!=='viewed')window.__bench.sendLog('agent-bg-1',seq);seq++;f.ticks.push(performance.now()-t)},tick);
  },cfg);
  await cdp.send('Profiler.start');const wall=[];const starts=[];const start=Date.now();
  for(let i=0;i<60;i++){
   const t=Date.now();starts.push(t);
   if(mode==='ascii'){await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',text:'a'});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA'});}
   else if(mode==='insert')await cdp.send('Input.insertText',{text:'あ'});
   else{const text=['に','にほ','にほん','日本','日本語'][i%5];await cdp.send('Input.imeSetComposition',{text,selectionStart:text.length,selectionEnd:text.length});if(i%5===4)await cdp.send('Input.insertText',{text:'日本語'});}
   wall.push(Date.now()-t);await page.waitForTimeout(30);
  }
  await page.evaluate(()=>{clearInterval(window.fuji.timer)});await page.waitForTimeout(100);
  const {profile}=await cdp.send('Profiler.stop');fs.writeFileSync(`${out}/${label}.cpuprofile`,JSON.stringify(profile));
  const raw=await page.evaluate(()=>{window.fuji.active=false;return{...window.fuji,timer:undefined,timeOrigin:performance.timeOrigin,text:document.querySelector('textarea').value,dom:document.querySelectorAll('*').length,rows:document.querySelectorAll('.transcript-entry').length}});
  fs.writeFileSync(`${out}/${label}.json`,JSON.stringify({cfg,raw,wall,starts,errors},null,2));
  const weights=new Map();for(let i=0;i<profile.samples.length;i++)weights.set(profile.samples[i],(weights.get(profile.samples[i])??0)+(profile.timeDeltas[i]??0));
  const top=profile.nodes.map(n=>({name:n.callFrame.functionName,url:n.callFrame.url,line:n.callFrame.lineNumber+1,ms:(weights.get(n.id)??0)/1000})).sort((a,b)=>b.ms-a.ms).slice(0,20);
  const dispatchFrame=starts.map((t,i)=>{const idx=mode==='ime'?i+Math.floor(i/5):i;return raw.inputs[idx]?.frameEpoch-t});
  if(dispatchFrame.some(x=>!Number.isFinite(x)||x<0))throw Error('Invalid frame measurement');
  const summary={...cfg,prod,localeCount:raw.localeCount,localeMs:raw.localeMs,dispatchFrame:stats(dispatchFrame),elapsed:Date.now()-start,input:stats(raw.inputs.map(x=>x.raf).filter(x=>x!==undefined)),wall:stats(wall),frames:stats(raw.frames),tickCost:stats(raw.ticks),longN:raw.long.length,longMs:raw.long.reduce((a,x)=>a+x.duration,0),dom:raw.dom,compositions:raw.compositions.length,errors,top};fs.appendFileSync(out+'/summary-shape.jsonl',JSON.stringify(summary)+'\n');console.log(JSON.stringify(summary));
  if(errors.length||raw.inputs.length<60)throw Error('Incomplete input/errors '+label);await context.close();
 }
}finally{fs.rmSync(root+'/src/.App.before.bench.svelte',{force:true});await browser.close();await (server.close?server.close():new Promise(r=>server.httpServer.close(r)))}
