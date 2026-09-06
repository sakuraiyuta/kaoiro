import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {advancePhase} from '../kaoiro-deploy-journal.mjs';
import {isValidManifestShape} from '../kaoiro-deploy-manifest.mjs';
const fixture=()=>({schema_version:1,transaction_id:'tx',compose_artifact:{path:'/compose.yaml',sha256:'a'.repeat(64)},env_consistency:{checked:true},image_id:'sha256:'+'b'.repeat(64),source_sha:'c'.repeat(40),target_sha:'d'.repeat(40),volume_id:'volume',archive:{path:'/archive.tar',sha256:'e'.repeat(64)},required_entries:[{path:'users.dets',owner:'1000:1000',mode:'0600'}]});
test('environment consistency values cannot be an array',()=>{
 assert.equal(isValidManifestShape({...fixture(),env_consistency:[]}),false);
});
test('observations cannot replace the authoritative transition phase',()=>{
 const dir=mkdtempSync('/tmp/fuji306-phase.');
 try{
  // クロエ round 1 review SF-4: a `catch{return;}` here let the test pass
  // vacuously if advancePhase threw for ANY reason — since journal.mjs's
  // M2 fix nests `observation` under its own key, advancePhase must not
  // throw for this input at all, so the outcome is stated directly.
  const journal={schema_version:1,transaction_id:'tx',phase:'prepare',history:[]};
  const next=advancePhase(dir,journal,'stopping',{phase:'healthy'});
  assert.equal(next.phase,'stopping');
  assert.equal(next.history.at(-1).phase,next.phase);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('ordinary observation survives a phase transition',()=>{
 const dir=mkdtempSync('/tmp/fuji306-control.');
 try{
  // Adjusted for the implementer's M2 fix (observation nested under its
  // own key, not spread onto the entry) — see kaoiro-deploy-journal.mjs.
  const next=advancePhase(dir,{schema_version:1,transaction_id:'tx',phase:'prepare',history:[]},'stopping',{exit_code:0});
  assert.equal(next.phase,'stopping');assert.equal(next.history.at(-1).phase,'stopping');assert.equal(next.history.at(-1).observation.exit_code,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
