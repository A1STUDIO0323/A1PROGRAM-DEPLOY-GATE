import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export function requireGate(ok, code) { if (!ok) throw Error(code); }
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export function validatePlan(plan) {
  requireGate(plan?.schema === 1 && /^[a-z0-9-]{8,80}$/.test(plan.id || ''), 'E_GATE_PLAN');
  requireGate(sha(plan.sourceSha) && sha(plan.controlSha) && sha(plan.gateSha), 'E_GATE_SOURCE');
  requireGate(/^\d+\.\d+\.\d+$/.test(plan.version || ''), 'E_GATE_VERSION');
  requireGate(hash(plan.payloadSha256) && hash(plan.cipherSha256), 'E_GATE_HASH');
  requireGate(['MA_TESTFLIGHT','MG_INTERNAL_ALPHA','MG_ALPHA_ONLY','MA_NOTES_ONLY','MG_PROBE_ONLY'].includes(plan.action), 'E_GATE_ACTION');
  if(['MG_INTERNAL_ALPHA','MG_ALPHA_ONLY'].includes(plan.action)) {
    requireGate(Number.isSafeInteger(plan.mgVersionCode) && plan.mgVersionCode > 0, 'E_GATE_BUILD');
  }
  if(plan.action==='MG_INTERNAL_ALPHA') {
    requireGate(hash(plan.mgUnsignedSha256) && hash(plan.uploadCertSha256), 'E_GATE_ARTIFACT');
  }
  if(plan.action==='MG_ALPHA_ONLY')requireGate(hash(plan.mgSignedSha256),'E_GATE_ARTIFACT');
  if(plan.action.startsWith('MA_'))requireGate(/^\d{8}\.\d+$/.test(plan.maBuild || ''), 'E_GATE_BUILD');
  if(plan.action==='MA_TESTFLIGHT')requireGate(hash(plan.maUnsignedSha256),'E_GATE_ARTIFACT');
  if(['MA_TESTFLIGHT','MG_INTERNAL_ALPHA'].includes(plan.action)) {
    const e=plan.artifactEvidence,ma=plan.action==='MA_TESTFLIGHT';
    requireGate(e?.repository==='A1STUDIO0323/A1PROGRAM-HOME'&&e.sourceSha===plan.sourceSha&&/^\d+$/.test(e.runId||'')&&e.workflow===(ma?'.github/workflows/mobile-ios-build.yml':'.github/workflows/mobile-android.yml'),'E_GATE_BUILD_PROVENANCE');
    if(e.transport==='local-job-log-v1'){
      // Any MG version: the HOME stage verified the owner run/job/runner and the log receipt; the gate binds those hashes to the sealed bundle.
      requireGate(!ma&&Number.isSafeInteger(e.jobId)&&e.jobId>0&&e.jobName==='local-build'&&hash(e.jobLogSha256)&&hash(e.receiptSha256)&&hash(e.metaSha256)&&e.unsignedSha256===plan.mgUnsignedSha256,'E_GATE_BUILD_PROVENANCE');
    }else{
      requireGate((e.transport===undefined||e.transport==='artifact')&&Number.isSafeInteger(e.artifactId)&&e.artifactId>0&&/^sha256:[a-f0-9]{64}$/.test(e.artifactDigest||''),'E_GATE_BUILD_PROVENANCE');
    }
  }
  requireGate(plan.alphaTrack === 'alpha' && plan.packageName === 'kr.a1program.m', 'E_GATE_SCOPE');
  requireGate(typeof plan.expiresAt === 'string' && Number.isFinite(Date.parse(plan.expiresAt)), 'E_GATE_EXPIRY');
  requireGate(Array.isArray(plan.files) && plan.files.length > 0 && plan.files.length < 100, 'E_GATE_FILES');
  const seen = new Set();
  for (const file of plan.files) {
    requireGate(typeof file.path === 'string' && /^[A-Za-z0-9_./-]+$/.test(file.path) &&
      !file.path.startsWith('/') && !file.path.split('/').some(x => ['', '.', '..'].includes(x)) &&
      !['plan.json','receipt.json'].includes(file.path) && !seen.has(file.path) && hash(file.sha256), 'E_GATE_PATH');
    requireGate(!/\.(?:p8|jks|key|pem)$/i.test(file.path), 'E_GATE_SECRET_FILE');
    seen.add(file.path);
  }
  requireGate(seen.has('deploy.mjs'), 'E_GATE_DRIVER');
  return plan;
}
export function validateContext(plan, context) {
  validatePlan(plan);
  requireGate(context.repository === 'A1STUDIO0323/A1PROGRAM-DEPLOY-GATE' && context.ref === 'refs/heads/main', 'E_GATE_REF');
  requireGate(context.event === 'workflow_dispatch' && context.actor === 'A1STUDIO0323', 'E_GATE_ACTOR');
  requireGate(context.confirm === plan.action && context.sha === plan.gateSha, 'E_GATE_APPROVAL_SCOPE');
  requireGate(context.runAttempt === '1', 'E_GATE_RERUN_REQUIRES_NEW_PLAN');
  requireGate(context.planSha256 === sha256(Buffer.from(JSON.stringify(plan))), 'E_GATE_PLAN_HASH');
  requireGate(Date.parse(plan.expiresAt) > context.now && Date.parse(plan.expiresAt) <= context.now + 24*60*60*1000, 'E_GATE_EXPIRED');
}
export function validateHistory(plan, runs, currentRunId) {
  requireGate(Array.isArray(runs) && /^\d+$/.test(String(currentRunId)), 'E_GATE_HISTORY');
  requireGate(!runs.some(run => String(run.id)!==String(currentRunId) &&
    Number(run.id)<Number(currentRunId) && run.display_title===plan.id+' / '+plan.action), 'E_GATE_PLAN_PREVIOUSLY_ATTEMPTED');
}
export function seal(payload, key, planId) {
  requireGate(Buffer.isBuffer(key) && key.length === 32, 'E_GATE_KEY');
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(planId));
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([Buffer.from('RG01'), iv, cipher.getAuthTag(), encrypted]);
}
export function unseal(encrypted, key, plan) {
  requireGate(sha256(encrypted) === plan.cipherSha256 && encrypted.subarray(0,4).toString() === 'RG01', 'E_GATE_CIPHER');
  requireGate(key.length === 32, 'E_GATE_KEY');
  try {
    requireGate(encrypted.length>32,'E_GATE_CIPHER');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, encrypted.subarray(4,16),{authTagLength:16});
    decipher.setAAD(Buffer.from(plan.id)); decipher.setAuthTag(encrypted.subarray(16,32));
    const plaintext = Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()]);
    requireGate(sha256(plaintext) === plan.payloadSha256, 'E_GATE_PLAINTEXT');
    return plaintext;
  } catch { throw Error('E_GATE_DECRYPT'); }
}
export function materialize(plaintext, plan, target) {
  const payload = JSON.parse(plaintext.toString('utf8'));
  requireGate(payload.schema === 1 && Array.isArray(payload.files) && payload.files.length === plan.files.length, 'E_GATE_PAYLOAD');
  const expected = new Map(plan.files.map(file => [file.path, file.sha256]));
  const buffers = [];
  for (const file of payload.files) {
    requireGate(expected.has(file.path) && typeof file.base64 === 'string', 'E_GATE_UNEXPECTED_FILE');
    const bytes = Buffer.from(file.base64, 'base64');
    requireGate(bytes.toString('base64') === file.base64 && sha256(bytes) === expected.get(file.path), 'E_GATE_FILE_HASH');
    expected.delete(file.path); buffers.push([file.path, bytes]);
  }
  requireGate(expected.size === 0 && !fs.existsSync(target), 'E_GATE_TARGET');
  fs.mkdirSync(target, {mode:0o700});
  for (const [name, bytes] of buffers) {
    const dest = path.join(target, name);
    fs.mkdirSync(path.dirname(dest), {recursive:true,mode:0o700});
    fs.writeFileSync(dest, bytes, {flag:'wx',mode:0o600});
  }
}
export function verifyGateCopies(plan,blobs) {
  for(const name of ['gate.mjs','play-alpha.mjs'])requireGate(plan.files.find(x=>x.path===name)?.sha256===sha256(blobs[name]),'E_GATE_SELF_COPY');
}
export async function boundedBody(response,limit) {
  const length=response.headers.get('content-length');
  requireGate(length===null||(/^\d+$/.test(length)&&Number(length)<limit),'E_GATE_SIZE');
  const reader=response.body?.getReader();requireGate(reader,'E_GATE_DOWNLOAD');
  const chunks=[];let size=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;requireGate(size<limit,'E_GATE_SIZE');chunks.push(Buffer.from(value));}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}
  finally{reader.releaseLock();}
  return Buffer.concat(chunks,size);
}
async function run() {
  const planId=process.env.PLAN_ID;
  requireGate(/^[a-z0-9-]{8,80}$/.test(planId||''), 'E_GATE_PLAN_ID');
  const base=`https://github.com/A1STUDIO0323/A1PROGRAM-DEPLOY-GATE/releases/download/${planId}`;
  const planResponse=await fetch(base+'/plan.json',{signal:AbortSignal.timeout(30000)});
  requireGate(planResponse.ok,'E_GATE_PLAN_DOWNLOAD');
  const planText=(await boundedBody(planResponse,65536)).toString('utf8');
  const plan = JSON.parse(planText);
  requireGate(plan.id===planId,'E_GATE_PLAN_ID');
  validateContext(plan, {
    repository:process.env.GITHUB_REPOSITORY, ref:process.env.GITHUB_REF, event:process.env.GITHUB_EVENT_NAME,
    actor:process.env.GITHUB_ACTOR, sha:process.env.GITHUB_SHA, confirm:process.env.CONFIRM,
    runAttempt:process.env.GITHUB_RUN_ATTEMPT, planSha256:process.env.PLAN_SHA256, now:Date.now()
  });
  const root=path.dirname(fileURLToPath(import.meta.url));
  verifyGateCopies(plan,Object.fromEntries(['gate.mjs','play-alpha.mjs'].map(name=>[name,execFileSync('git',['show',plan.gateSha+':'+name],{cwd:root})])));
  // A lost response never authorizes a replay. A new recovery plan is required even after a cancelled prior run.
  for(let page=1;page<=10;page++) {
    const history=await fetch(`https://api.github.com/repos/A1STUDIO0323/A1PROGRAM-DEPLOY-GATE/actions/workflows/release.yml/runs?per_page=100&page=${page}`,{
      headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+process.env.GH_TOKEN},signal:AbortSignal.timeout(30000)
    });
    requireGate(history.ok,'E_GATE_HISTORY');
    const runs=(await history.json()).workflow_runs;
    validateHistory(plan,runs,process.env.GITHUB_RUN_ID);
    if(runs.length<100)break;
    requireGate(page<10,'E_GATE_HISTORY_LIMIT');
  }
  const command = process.argv[2];
  if (command === 'check') {
    if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## Reviewed immutable release\nAction: ${plan.action}\n\nSource: ${plan.sourceSha}\n\nControl: ${plan.controlSha}\n\nGate: ${plan.gateSha}\n\n`+
      plan.files.map(x=>`- ${x.path}: ${x.sha256}`).join('\n')+'\n');
    console.log('Gate plan validated; no credentials used');return;
  }
  requireGate(command === 'deploy', 'E_GATE_COMMAND');
  requireGate(process.env.ACTIVE_PLAN_SHA256===process.env.PLAN_SHA256,'E_GATE_ACTIVE_PLAN');
  // The source URL is fixed; arbitrary URLs and private-repository access tokens are unnecessary.
  const url = base+'/payload.sealed';
  const response = await fetch(url, {signal:AbortSignal.timeout(60000)});
  requireGate(response.ok, 'E_GATE_DOWNLOAD');
  const ciphertext = await boundedBody(response,1024*1024*1024);
  const key = Buffer.from(process.env.PAYLOAD_KEY_BASE64 || '', 'base64');
  const plaintext = unseal(ciphertext, key, plan);
  const target = path.join(fs.realpathSync(process.env.RUNNER_TEMP), 'gate-private');
  try {
    materialize(plaintext, plan, target);
    fs.writeFileSync(path.join(target,'plan.json'), JSON.stringify(plan), {flag:'wx',mode:0o600});
    // All driver bytes, including dependencies, are bound to the reviewed plan before secrets are supplied.
    // Suppress private compiler/API output; publish only a stable status code.
    const result = spawnSync(process.execPath, ['deploy.mjs'], {cwd:target, env:{...process.env, PAYLOAD_KEY_BASE64:'',GH_TOKEN:'',GITHUB_TOKEN:'',ACTIONS_RUNTIME_TOKEN:'',ACTIONS_ID_TOKEN_REQUEST_TOKEN:''}, stdio:'ignore',timeout:35*60*1000});
    const receiptPath=path.join(target,'receipt.json');
    if(fs.existsSync(receiptPath)) {
      const receipt=fs.readFileSync(receiptPath);
      requireGate(receipt.length<1024*1024,'E_GATE_RECEIPT_SIZE');
      fs.writeFileSync(path.join(process.env.RUNNER_TEMP,'receipt.sealed'),seal(receipt,key,plan.id+'.receipt'),{mode:0o600,flag:'wx'});
    }
    requireGate(result.status === 0 && fs.existsSync(receiptPath), 'E_GATE_DEPLOY_NOT_CONFIRMED');
    console.log('Approved action completed; store and physical-device states require separate readback');
  } finally { key.fill(0); plaintext.fill(0); fs.rmSync(target,{recursive:true,force:true}); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => { console.error(/^E_GATE_[A-Z_]+$/.test(error.message)?error.message:'E_GATE_FAILED');process.exitCode=1; });
}
