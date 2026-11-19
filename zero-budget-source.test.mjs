import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePlan,childEnvironment,sha256,selectOriginalRun} from './zero-budget-source.mjs';
import {seal,unseal} from './ci-dedup-eaa.mjs';
const now=Date.UTC(2026,10,20),p={schema:1,action:'SOURCE_CHECK',id:'zero-source-20261120-1234567812345678',
 sourceRepo:'A1STUDIO0323/A1PROGRAM-HOME',workflow:'.github/workflows/ci.yml',sourceSha:'1'.repeat(40),
 sourceTree:'2'.repeat(40),controlSha:'3'.repeat(40),workflowSha256:'4'.repeat(64),scriptSha256:'5'.repeat(64),
 payloadSha256:'6'.repeat(64),payloadBytes:100,createdAt:new Date(now).toISOString(),expiresAt:new Date(now+3600000).toISOString()};
test('only bounded, reviewed immutable plans for known repositories and the exact workflow are accepted',()=>{
 assert.equal(validatePlan(p,{now,control:p.controlSha}),p);
 for(const change of [{sourceRepo:'outside/fork'},{workflow:'../../secret'},{action:'DEPLOY'},
  {id:'../another-plan'},{sourceSha:'main'},{sourceTree:'2'},{payloadBytes:129*1024*1024},
  {expiresAt:new Date(now-1).toISOString()},{expiresAt:new Date(now+25*3600000).toISOString()}]) {
  assert.throws(()=>validatePlan({...p,...change},{now}),JSON.stringify(change));
 }
 assert.throws(()=>validatePlan(p,{now,control:'7'.repeat(40)}));
});
test('changing a single reviewed plan byte, authenticated ciphertext or AAD is rejected',()=>{
 const raw=Buffer.from(JSON.stringify(p));validatePlan(p,{now,raw,expectedHash:sha256(raw)});
 assert.throws(()=>validatePlan(p,{now,raw:Buffer.concat([raw,Buffer.from(' ')]),expectedHash:sha256(raw)}));
 const key=Buffer.alloc(32,7),data=seal(Buffer.from('private source or diagnostic'),key,'one-plan');
 assert.equal(unseal(data,key,'one-plan').toString(),'private source or diagnostic');
 const corrupt=Buffer.from(data);corrupt[corrupt.length-1]^=1;
 assert.throws(()=>unseal(corrupt,key,'one-plan'));
 assert.throws(()=>unseal(data,key,'another-plan'));
});
test('duplicate, rerun, other-owner and post-expiry workflows cannot claim a source result',()=>{
 const run={id:123,display_title:p.id,head_sha:p.controlSha,head_branch:'main',run_attempt:1,event:'workflow_dispatch',
  actor:{login:'A1STUDIO0323',id:272439615},created_at:new Date(now+1000).toISOString()};
 assert.equal(selectOriginalRun(p,{total_count:1,workflow_runs:[run]},123),run);
 assert.throws(()=>selectOriginalRun(p,{total_count:2,workflow_runs:[run,run]},123));
 for(const change of [{run_attempt:2},{head_branch:'other'},{head_sha:'7'.repeat(40)},
  {actor:{login:'A1STUDIO0323',id:1}},{event:'pull_request'},{created_at:p.expiresAt}]) {
  assert.throws(()=>selectOriginalRun(p,{total_count:1,workflow_runs:[{...run,...change}]},123));
 }
 assert.throws(()=>selectOriginalRun(p,{total_count:101,workflow_runs:[run]},123));
});
test('source processes receive no GitHub, Actions, signing, store or encryption credentials/control channels',()=>{
 const parent={PATH:'/node/bin:/bin',HOME:'/home/runner',GH_TOKEN:'never-child',GITHUB_TOKEN:'never-child',
  ZERO_BUDGET_SOURCE_KEY:'never-child',GITHUB_OUTPUT:'/runner/output',GITHUB_ENV:'/runner/env',
  GITHUB_PATH:'/runner/path',GITHUB_STEP_SUMMARY:'/runner/summary',ACTIONS_RUNTIME_TOKEN:'never-child',
  APPSTORE_API_PRIVATE_KEY:'never-child',ANDROID_KEYSTORE_PASSWORD:'never-child',CLOUDFLARE_API_TOKEN:'never-child'};
 const env=childEnvironment('/tmp/source',p,parent);
 assert.ok(!JSON.stringify(env).includes('never-child'));
 for(const key of ['GITHUB_OUTPUT','GITHUB_ENV','GITHUB_PATH','GITHUB_STEP_SUMMARY','ACTIONS_RUNTIME_TOKEN'])assert.equal(env[key],undefined);
 assert.equal(env.GITHUB_SHA,p.sourceSha);assert.equal(env.GITHUB_REPOSITORY,p.sourceRepo);
 assert.equal(env.HOME,path.join('/tmp/source','.job-home'));
});
test('all jobs stay on standard public Linux runners and only a source-free collector receives write permission',()=>{
 const workflow=fs.readFileSync(new URL('.github/workflows/zero-budget-source.yml',import.meta.url),'utf8');
 assert.equal([...workflow.matchAll(/runs-on: ubuntu-24\.04/g)].length,3);
 assert.equal([...workflow.matchAll(/contents: write/g)].length,1);
 const build=workflow.split('  build:')[1].split('  collect:')[0];
 assert.ok(!build.includes('contents: write'));
 assert.ok(workflow.includes("github.ref == 'refs/heads/main'"));
 assert.ok(workflow.includes("github.actor_id == '272439615'"));
 assert.equal([...workflow.matchAll(/environment: mobile-store-release/g)].length,2);
 assert.ok(!/upload-artifact|download-artifact|large|macos|windows/.test(workflow));
 for(const action of workflow.matchAll(/uses: (\S+)/g))assert.match(action[1],/@[a-f0-9]{40}$/);
});
