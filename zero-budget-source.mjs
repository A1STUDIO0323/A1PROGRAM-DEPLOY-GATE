import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {seal,unseal} from './ci-dedup-eaa.mjs';

export const REPO='A1STUDIO0323/A1PROGRAM-DEPLOY-GATE';
export const SOURCE_REPOS=['A1STUDIO0323/A1PROGRAM-HOME','A1STUDIO0323/A1STUDIO-HOME'];
export const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fail=code=>{throw Error(code);};
export function validatePlan(p,{now=Date.now(),control,raw,expectedHash}={}) {
  if(p?.schema!==1||p.action!=='SOURCE_CHECK'||!/^zero-source-[0-9]{8}-[a-f0-9]{16}$/.test(p.id||'')||
    !SOURCE_REPOS.includes(p.sourceRepo)||p.workflow!=='.github/workflows/ci.yml')fail('E_ZERO_PLAN');
  for(const key of ['sourceSha','sourceTree','controlSha'])if(!/^[a-f0-9]{40}$/.test(p[key]||''))fail('E_ZERO_SOURCE');
  for(const key of ['workflowSha256','scriptSha256','payloadSha256'])if(!/^[a-f0-9]{64}$/.test(p[key]||''))fail('E_ZERO_HASH');
  if(control&&p.controlSha!==control)fail('E_ZERO_CONTROL');
  const expiry=Date.parse(p.expiresAt),created=Date.parse(p.createdAt);
  if(!Number.isFinite(expiry)||!Number.isFinite(created)||created>now+60000||now-created>24*3600000||
    expiry<=now||expiry>created+24*3600000)fail('E_ZERO_EXPIRED');
  if(!Number.isSafeInteger(p.payloadBytes)||p.payloadBytes<36||p.payloadBytes>128*1024*1024)fail('E_ZERO_SIZE');
  if(raw&&(!/^[a-f0-9]{64}$/.test(expectedHash||'')||sha256(raw)!==expectedHash))fail('E_ZERO_PLAN_HASH');
  return p;
}
export function childEnvironment(source,p,parent=process.env) {
  const allowed=new Set(['PATH','Path','LANG','LC_ALL','SYSTEMROOT','SystemRoot','COMSPEC','ComSpec']);
  const env=Object.fromEntries(Object.entries(parent).filter(([key])=>allowed.has(key)));
  Object.assign(env,{HOME:path.join(source,'.job-home'),TMPDIR:path.join(source,'.job-tmp'),
    CI:'true',TZ:'Asia/Seoul',GITHUB_REPOSITORY:p.sourceRepo,GITHUB_SHA:p.sourceSha,
    GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',RUNNER_OS:'Linux',
    RUNNER_ENVIRONMENT:'github-hosted',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'});
  return env;
}
const aad=(p,kind)=>'zero-budget-source|'+p.id+'|'+p.sourceSha+'|'+kind;
async function download(id,name,maxBytes) {
  if(!/^zero-source-[0-9]{8}-[a-f0-9]{16}$/.test(id))fail('E_ZERO_ID');
  const response=await fetch('https://github.com/'+REPO+'/releases/download/'+id+'/'+name,{signal:AbortSignal.timeout(120000)});
  if(!response.ok)fail('E_ZERO_DOWNLOAD');
  if(Number(response.headers.get('content-length'))>maxBytes)fail('E_ZERO_SIZE');
  const reader=response.body.getReader(),chunks=[];let total=0;
  for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;
    if(total>maxBytes){await reader.cancel();fail('E_ZERO_SIZE');}chunks.push(value);}
  return Buffer.concat(chunks);
}
async function readPlan() {
  const raw=await download(process.env.PLAN_ID,'plan.json',16384);
  const p=JSON.parse(raw);
  return validatePlan(p,{raw,control:process.env.GITHUB_SHA,expectedHash:process.env.PLAN_SHA256,
    now:process.argv[2]==='collect'?Date.parse(p.createdAt)+1:Date.now()});
}
function requireContext() {
  const e=process.env;
  if(e.GITHUB_REPOSITORY!==REPO||e.GITHUB_REF!=='refs/heads/main'||e.GITHUB_EVENT_NAME!=='workflow_dispatch'||
    e.GITHUB_ACTOR!=='A1STUDIO0323'||e.GITHUB_ACTOR_ID!=='272439615'||e.GITHUB_RUN_ATTEMPT!=='1'||
    e.RUNNER_ENVIRONMENT!=='github-hosted'||e.RUNNER_OS!=='Linux'||!/^\d+$/.test(e.GITHUB_RUN_ID||''))fail('E_ZERO_CONTEXT');
}
async function api(endpoint,options={}) {
  const response=await fetch('https://api.github.com/'+endpoint,{...options,headers:{
    Authorization:'Bearer '+process.env.GH_TOKEN,Accept:'application/vnd.github+json',...options.headers},signal:AbortSignal.timeout(30000)});
  if(!response.ok)fail('E_ZERO_API');return response.json();
}
export function selectOriginalRun(p,runs,runId) {
  if(!Array.isArray(runs.workflow_runs)||runs.total_count>100)fail('E_ZERO_HISTORY_LIMIT');
  const matches=runs.workflow_runs.filter(run=>run.display_title===p.id);
  if(matches.length!==1||String(matches[0].id)!==String(runId)||matches[0].head_sha!==p.controlSha)fail('E_ZERO_DUPLICATE');
  const run=matches[0],created=Date.parse(run.created_at);
  if(run.actor?.login!=='A1STUDIO0323'||run.actor?.id!==272439615||run.event!=='workflow_dispatch'||
    run.head_branch!=='main'||run.run_attempt!==1||!Number.isFinite(created)||
    created<Date.parse(p.createdAt)-60000||created>=Date.parse(p.expiresAt))fail('E_ZERO_RUN_IDENTITY');
  return run;
}
async function validateExecution(p) {
  const runs=await api('repos/'+REPO+'/actions/workflows/zero-budget-source.yml/runs?event=workflow_dispatch&per_page=100&created='+encodeURIComponent('>='+p.createdAt));
  selectOriginalRun(p,runs,process.env.GITHUB_RUN_ID);
  const cache=await api('repos/'+REPO+'/actions/cache/usage');
  if(!Number.isSafeInteger(cache.active_caches_size_in_bytes)||cache.active_caches_size_in_bytes>8*1024**3)fail('E_ZERO_FREE_CACHE_CAPACITY');
}
function jobKey() {
  if(process.env.ZERO_BUDGET_PLAN_SHA256!==process.env.PLAN_SHA256)fail('E_ZERO_SLOT');
  const key=Buffer.from(process.env.ZERO_BUDGET_SOURCE_KEY||'','base64');if(key.length!==32)fail('E_ZERO_KEY');return key;
}
async function runSource(p) {
  const key=jobKey();
  const encrypted=await download(p.id,'payload.sealed',128*1024*1024);
  if(encrypted.length!==p.payloadBytes||sha256(encrypted)!==p.payloadSha256)fail('E_ZERO_PAYLOAD_HASH');
  const payload=JSON.parse(unseal(encrypted,key,aad(p,'payload')).toString('utf8'));
  if(payload.sourceSha!==p.sourceSha||payload.sourceTree!==p.sourceTree||payload.sourceRepo!==p.sourceRepo||
    typeof payload.script!=='string'||payload.script.length>256000||sha256(payload.script)!==p.scriptSha256)fail('E_ZERO_PAYLOAD');
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'zero-source-')),source=path.join(tmp,'source');fs.mkdirSync(source,{mode:0o700});
  const git=(...args)=>execFileSync('git',args,{cwd:source,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const log=path.join(tmp,'source.log');let result={status:null};let errorCode=null;
  try {
    git('init','--quiet');
    execFileSync('git',['index-pack','--stdin'],{cwd:source,input:Buffer.from(payload.gitPackBase64,'base64'),stdio:['pipe','pipe','pipe'],timeout:120000});
    git('update-ref','refs/heads/reviewed',p.sourceSha);fs.writeFileSync(path.join(source,'.git/shallow'),p.sourceSha+'\n');
    git('checkout','--quiet','--detach',p.sourceSha);
    if(git('rev-parse','HEAD')!==p.sourceSha||git('rev-parse','HEAD^{tree}')!==p.sourceTree||git('status','--porcelain'))fail('E_ZERO_SOURCE_CHECKOUT');
    if(sha256(fs.readFileSync(path.join(source,p.workflow)))!==p.workflowSha256)fail('E_ZERO_WORKFLOW_HASH');
    const script=path.join(tmp,'source-check.sh');fs.writeFileSync(script,payload.script,{mode:0o700});
    const env=childEnvironment(source,p);fs.mkdirSync(env.HOME);fs.mkdirSync(env.TMPDIR);
    const fd=fs.openSync(log,'w',0o600);
    try{result=spawnSync('bash',['-euo','pipefail',script],{cwd:source,env,stdio:['ignore',fd,fd],timeout:35*60*1000});}
    finally{fs.closeSync(fd);}
    if(git('rev-parse','HEAD')!==p.sourceSha||git('status','--porcelain','--untracked-files=no'))fail('E_ZERO_SOURCE_CHANGED');
  } catch(error) {errorCode=/^E_ZERO_[A-Z_]+$/.test(error.message)?error.message:'E_ZERO_EXECUTION';}
  const size=fs.existsSync(log)?fs.statSync(log).size:0;
  const receipt={schema:1,planId:p.id,sourceSha:p.sourceSha,sourceTree:p.sourceTree,sourceRepo:p.sourceRepo,
    controlSha:p.controlSha,runId:process.env.GITHUB_RUN_ID,workflowSha256:p.workflowSha256,scriptSha256:p.scriptSha256,
    ok:result.status===0&&!errorCode&&size<=32*1024*1024,exit:result.status,error:errorCode,
    logBase64:size<=32*1024*1024&&size?fs.readFileSync(log).toString('base64'):''};
  const bytes=seal(Buffer.from(JSON.stringify(receipt)),key,aad(p,'result|'+receipt.runId));key.fill(0);
  const dir=path.resolve('zero-source-results');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,receipt.runId+'.sealed'),bytes,{flag:'wx',mode:0o600});
  fs.appendFileSync(process.env.GITHUB_OUTPUT,'result_sha256='+sha256(bytes)+'\n');
  console.log('ZERO_SOURCE_RESULT '+sha256(bytes));
  if(!receipt.ok)fail('E_ZERO_SOURCE_CHECK_FAILED');
}
async function collect(p) {
  const run=process.env.GITHUB_RUN_ID,bytes=fs.readFileSync(path.join('zero-source-results',run+'.sealed'));
  if(bytes.length>64*1024*1024||sha256(bytes)!==process.env.RESULT_SHA256)fail('E_ZERO_RESULT_HASH');
  const key=jobKey(),receipt=JSON.parse(unseal(bytes,key,aad(p,'result|'+run)).toString('utf8'));key.fill(0);
  if(receipt.sourceSha!==p.sourceSha||receipt.controlSha!==p.controlSha||receipt.runId!==run||receipt.planId!==p.id||
    receipt.workflowSha256!==p.workflowSha256||receipt.scriptSha256!==p.scriptSha256)fail('E_ZERO_RESULT_PROVENANCE');
  const release=await api('repos/'+REPO+'/releases/tags/'+p.id),name='result-'+run+'.sealed';
  if(release.assets.some(asset=>asset.name===name))fail('E_ZERO_RESULT_EXISTS');
  const response=await fetch(release.upload_url.split('{')[0]+'?name='+name,{method:'POST',headers:{
    Authorization:'Bearer '+process.env.GH_TOKEN,'Content-Type':'application/octet-stream'},body:bytes,signal:AbortSignal.timeout(120000)});
  if(response.status!==201)fail('E_ZERO_RESULT_UPLOAD');
  console.log('ZERO_SOURCE_COLLECTED '+p.sourceSha+' '+sha256(bytes)+' '+(receipt.ok?'PASS':'FAILED'));
  if(!receipt.ok)fail('E_ZERO_SOURCE_CHECK_FAILED');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {requireContext();const p=await readPlan();await validateExecution(p);
    if(process.argv[2]==='check')console.log('ZERO_SOURCE_PLAN_OK');
    else if(process.argv[2]==='run')await runSource(p);
    else if(process.argv[2]==='collect')await collect(p);
    else fail('E_ZERO_COMMAND');
  } catch(error) {console.error(/^E_ZERO_[A-Z_]+$/.test(error.message)?error.message:'E_ZERO_FAILED');process.exitCode=1;}
}
