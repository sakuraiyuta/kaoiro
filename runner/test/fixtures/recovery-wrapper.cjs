// Stand-in wrapper body: runs under the real makeLauncher child, writes the real
// checkpoint path from the real config, then exits or waits for SIGTERM.
const fs=require('node:fs');const a=process.argv.slice(2);
if(a[0]&&a[0].endsWith('.json')&&process.env.KAOIRO_TEST_RECOVERY_DIR){
 const cfg=JSON.parse(fs.readFileSync(a[0],'utf8'));const dir=process.env.KAOIRO_TEST_RECOVERY_DIR;
 const n=fs.readdirSync(dir).filter(f=>f.startsWith('launch-')).length;
 const r=a.indexOf('--resume');const resume=r<0?null:a[r+1];
 const plan=JSON.parse(process.env.KAOIRO_TEST_RECOVERY_PLAN)[n]??{hold:true};
 const write=rec=>{fs.writeFileSync(cfg.recovery_checkpoint_path+'.tmp',JSON.stringify({version:1,...rec}));fs.renameSync(cfg.recovery_checkpoint_path+'.tmp',cfg.recovery_checkpoint_path);};
 if(plan.rec){write(plan.rec);const w=fs.writeFileSync,rn=fs.renameSync;fs.writeFileSync=function(f,...a){return String(f).endsWith('.recovery.tmp')?undefined:w.call(this,f,...a);};fs.renameSync=function(f,...a){return String(f).endsWith('.recovery.tmp')?undefined:rn.call(this,f,...a);};require('node:module').syncBuiltinESMExports();}
 fs.writeFileSync(dir+'/launch-'+n,JSON.stringify({resume,kind:cfg.recovery_resume_kind??null,hasPath:!!cfg.recovery_checkpoint_path}));
 if(plan.hold){process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);}
 else process.exit(plan.code??1);
}
