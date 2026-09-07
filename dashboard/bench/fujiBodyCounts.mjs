import { chromium } from '@playwright/test';
import { preview } from 'vite';
import fs from 'node:fs';
const out='/tmp/fuji304-measure';
const server=await preview({root:process.cwd(),configFile:process.cwd()+'/bench/vite.harness.config.ts',build:{outDir:out+'/prod'},preview:{port:0}});
const base='http://localhost:'+server.httpServer.address().port;
const browser=await chromium.launch({headless:true});
try {
 for(const cfg of [{history:1000,ticks:0},{history:1000,ticks:1},{history:1000,ticks:10},{history:5000,ticks:10},{history:5000,ticks:10,background:true}]) {
  const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(base+'/bench/harnessApp.html?variant=after&token=bench-after');await page.evaluate(()=>window.__bench.waitReady());
  await page.evaluate(h=>window.__bench.seed(Array.from({length:5},(_,i)=>({agentId:i?'agent-bg-'+i:'agent-viewed',historyCount:h,ext:{slash_commands:['help']}}))),cfg.history);
  await page.waitForTimeout(1500);await page.locator('button.open',{hasText:'agent-viewed'}).click();await page.waitForSelector('.log');await page.waitForTimeout(700);
  await page.evaluate(()=>{window.__fujiCalls={counts:{},sizes:[]}});
  for(let i=0;i<cfg.ticks;i++){
   await page.evaluate(({cfg,i})=>{if(!cfg.background)window.__bench.sendLog('agent-viewed',cfg.history+10000+i);window.__bench.sendLog('agent-bg-1',cfg.history+10000+i)},{cfg,i});
   await page.waitForTimeout(120);
  }
  if(!cfg.ticks)await page.waitForTimeout(1200);
  const data=await page.evaluate(()=>window.__fujiCalls);const rows=await page.locator('.transcript-entry').count();
  const label=`body-counts-h${cfg.history}-n${cfg.ticks}-${cfg.background?'background':'both'}`;
  fs.writeFileSync(out+'/'+label+'.json',JSON.stringify({cfg,...data,rows,errors},null,2));console.log(JSON.stringify({cfg,...data,rows,errors}));
  if(errors.length)throw Error('page errors');
  if(cfg.ticks && data.counts.mergeTranscriptEntries !== cfg.ticks*(cfg.background?1:2))throw Error('merge count mismatch');
  if(cfg.ticks && !cfg.background && data.counts.formatTime !== 200*cfg.ticks)throw Error('format count mismatch');
  await context.close();
 }
} finally {await browser.close();await new Promise(r=>server.httpServer.close(r))}
