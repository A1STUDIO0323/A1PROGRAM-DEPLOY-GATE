import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {validatePlan,validateContext,validateHistory,seal,unseal,materialize,sha256} from './gate.mjs';
const now=Date.parse('2026-11-01T05:00:00Z');
const files=[{path:'deploy.mjs',base64:Buffer.from('export const safe=true;').toString('base64')}];
const plain=Buffer.from(JSON.stringify({schema:1,files}));
const key=crypto.randomBytes(32),cipher=seal(plain,key,'release-210');
const sample=()=>({schema:1,id:'release-210',sourceSha:'a'.repeat(40),gateSha:'b'.repeat(40),version:'0.16.210',payloadSha256:sha256(plain),cipherSha256:sha256(cipher),mgVersionCode:29891489,maBuild:'20261031.232927',mgUnsignedSha256:'c'.repeat(64),maUnsignedSha256:'d'.repeat(64),uploadCertSha256:'e'.repeat(64),action:'MG_INTERNAL_ALPHA',alphaTrack:'alpha',packageName:'kr.a1program.m',expiresAt:'2026-11-01T10:00:00Z',files:files.map(x=>({path:x.path,sha256:sha256(Buffer.from(x.base64,'base64'))}))});
const context=plan=>({repository:'A1STUDIO0323/A1PROGRAM-DEPLOY-GATE',ref:'refs/heads/main',event:'workflow_dispatch',actor:'A1STUDIO0323',sha:plan.gateSha,confirm:plan.action,runAttempt:'1',planSha256:sha256(JSON.stringify(plan)),now});
test('exact approved plan and authenticated decryption',()=>{
  const plan=sample();validatePlan(plan);validateContext(plan,context(plan));
  assert.deepEqual(unseal(cipher,key,plan),plain);
});
test('notes recovery needs an existing build identity, not expired unsigned binary artifacts',()=>{
 const p={...sample(),action:'MA_NOTES_ONLY'};delete p.mgVersionCode;delete p.mgUnsignedSha256;delete p.maUnsignedSha256;delete p.uploadCertSha256;
 validatePlan(p);assert.throws(()=>validatePlan({...p,maBuild:null}));
});
test('read-only device availability probe needs no signing artifact or upload certificate',()=>{
 const p={...sample(),action:'MG_PROBE_ONLY'};for(const key of ['mgVersionCode','maBuild','mgUnsignedSha256','maUnsignedSha256','uploadCertSha256'])delete p[key];
 validatePlan(p);
});
test('Alpha-only recovery binds original signed bundle and needs no unsigned build or keystore',()=>{
 const p={...sample(),action:'MG_ALPHA_ONLY',mgSignedSha256:'f'.repeat(64)};delete p.mgUnsignedSha256;delete p.uploadCertSha256;
 validatePlan(p);assert.throws(()=>validatePlan({...p,mgSignedSha256:null}));
});
for(const [name,field,value] of [
  ['fork','repository','attacker/fork'],['branch','ref','refs/heads/other'],['pull request','event','pull_request'],
  ['other user','actor','attacker'],['unreviewed gate','sha','c'.repeat(40)],['wrong action','confirm','MA_TESTFLIGHT'],
  ['rerun','runAttempt','2'],['changed plan','planSha256','f'.repeat(64)],['expired','now',now+25*60*60*1000]
])test('reject '+name,()=>{const p=sample();assert.throws(()=>validateContext(p,{...context(p),[field]:value}),/^Error: E_GATE_/);});
for(const file of ['../escape','/absolute','a//b','a/./b','a/../b','C:/secret','a\\b','plan.json','receipt.json','private.p8','upload.jks'])
  test('reject unsafe payload path '+file,()=>{const p=sample();p.files.push({path:file,sha256:'a'.repeat(64)});assert.throws(()=>validatePlan(p));});
for(const [field,value] of [['alphaTrack','production'],['action','PRODUCTION'],['packageName','other'],['sourceSha','main'],['mgVersionCode',NaN]])
  test('reject changed scope '+field,()=>{assert.throws(()=>validatePlan({...sample(),[field]:value}));});
test('authenticated ciphertext detects tampering and wrong key/plan',()=>{
  const p=sample(),broken=Buffer.from(cipher);broken[broken.length-1]^=1;
  assert.throws(()=>unseal(broken,key,p));
  assert.throws(()=>unseal(cipher,crypto.randomBytes(32),p));
  assert.throws(()=>unseal(cipher,key,{...p,id:'another-plan'}));
  assert.throws(()=>unseal(cipher,key,{...p,payloadSha256:'0'.repeat(64)}));
});
test('a prior attempt blocks replay; a later queued attempt cannot block the first one',()=>{
 const p=sample(),run={id:100,display_title:p.id+' / '+p.action};
 assert.throws(()=>validateHistory(p,[run],101),/E_GATE_PLAN_PREVIOUSLY_ATTEMPTED/);
 validateHistory(p,[run],100);validateHistory(p,[{...run,id:102}],100);
 validateHistory(p,[{...run,display_title:'different-plan / '+p.action}],101);
 assert.throws(()=>validateHistory(p,null,100),/E_GATE_HISTORY/);
});
test('validate all bytes before creating private files; reject reuse/extra/duplicate',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gate-test-'));
  try {
    const dest=path.join(root,'private');materialize(plain,sample(),dest);
    assert.equal(fs.readFileSync(path.join(dest,'deploy.mjs'),'utf8'),'export const safe=true;');
    assert.throws(()=>materialize(plain,sample(),dest));
    const wrong=Buffer.from(JSON.stringify({schema:1,files:[{...files[0],base64:Buffer.from('changed').toString('base64')}]}));
    assert.throws(()=>materialize(wrong,sample(),path.join(root,'wrong')));
    assert.equal(fs.existsSync(path.join(root,'wrong')),false);
    assert.throws(()=>materialize(Buffer.from(JSON.stringify({schema:1,files:[...files,files[0]]})),sample(),path.join(root,'dup')));
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('one public workflow has no private checkout, raw app artifact or repository token persistence',()=>{
 const y=fs.readFileSync(new URL('.github/workflows/release.yml',import.meta.url),'utf8');
 assert.match(y,/environment: mobile-store-release/);assert.match(y,/needs: validate/);
 assert.equal((y.match(/persist-credentials: false/g)||[]).length,2);
 assert.doesNotMatch(y,/pull_request_target|secrets: inherit|contents: write|npm (?:install|ci)|\.aab|\.ipa|\.p8|\.jks/);
 assert.match(y,/path: \$\{\{ runner.temp \}\}\/receipt.sealed/);
});
test('actual workflow secret expressions give recovery/probe only the credentials their actions need',()=>{
 const y=fs.readFileSync(new URL('.github/workflows/release.yml',import.meta.url),'utf8');
 const expressions=[...y.matchAll(/^          ([A-Z0-9_]+): \$\{\{ (.+) \}\}$/gm)].filter(([,name])=>!['PLAN_ID','GH_TOKEN','CONFIRM','PLAN_SHA256','PAYLOAD_KEY_BASE64'].includes(name));
 assert.equal(expressions.length,9);
 const secrets=Object.fromEntries(expressions.map(([,name])=>[name,'synthetic:'+name]));
 for(const [action,expected] of [
  ['MG_ALPHA_ONLY',['PLAY_SERVICE_ACCOUNT_JSON']],['MG_PROBE_ONLY',['PLAY_SERVICE_ACCOUNT_JSON']],
  ['MA_NOTES_ONLY',['APPSTORE_API_KEY_ID','APPSTORE_API_ISSUER_ID','APPSTORE_API_PRIVATE_KEY']],
  ['MA_TESTFLIGHT',['APPSTORE_API_KEY_ID','APPSTORE_API_ISSUER_ID','APPSTORE_API_PRIVATE_KEY','APPLE_TEAM_ID']],
  ['MG_INTERNAL_ALPHA',['ANDROID_KEYSTORE_BASE64','ANDROID_KEYSTORE_PASSWORD','ANDROID_KEY_ALIAS','ANDROID_KEY_PASSWORD','PLAY_SERVICE_ACCOUNT_JSON']]
 ]){
  const actual=expressions.filter(([,name,code])=>vm.runInNewContext(code,{inputs:{confirm:action},secrets,startsWith:(s,p)=>s.startsWith(p)},{timeout:100,contextCodeGeneration:{strings:false,wasm:false}})===secrets[name]).map(([,name])=>name);
  assert.deepEqual(actual.sort(),expected.sort(),action);
 }
});
