import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync,spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
export const REPO='A1STUDIO0323/A1PROGRAM-DEPLOY-GATE',SOURCE='8b36b28222354639fb4234522350a1c0f47823aa',VERSION='0.16.250',PLAN='classic-250-8b36b282-20261103';
export const LANES=['source','mobile20','mobile22','ma','windows'];
export const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
let failureCapture=null;
const fail=code=>{throw Error(code)};
export function validate(p,{now=Date.now(),control=process.env.GITHUB_SHA,planHash=process.env.PLAN_SHA256,raw}={}){
 if(p?.v!==1||p.id!==PLAN||p.sourceSha!==SOURCE||p.version!==VERSION||p.repo!==REPO||p.action!=='CLASSIC250_BUILD'||p.baselineSha!=='95623317665144e36c8292a112f7a4987468623d')fail('C250_PLAN');
 if(!/^[a-f0-9]{40}$/.test(p.controlSha||'')||control&&p.controlSha!==control||!Number.isFinite(Date.parse(p.expiresAt))||Date.parse(p.expiresAt)<=now||Date.parse(p.expiresAt)-now>72*3600000)fail('C250_CONTROL_EXPIRY');
 if(!/^[a-f0-9]{40}$/.test(p.sourceTree||'')||!p.workflowHashes||Object.keys(p.workflowHashes).sort().join(',')!=='ci.yml,desktop-classic.yml,mobile-toolchain.yml'||Object.values(p.workflowHashes).some(h=>!/^[a-f0-9]{64}$/.test(h)))fail('C250_SOURCE_MANIFEST');
 if(!/^[a-f0-9]{64}$/.test(p.payloadSha256||'')||!Number.isSafeInteger(p.payloadBytes)||p.payloadBytes<50||p.payloadBytes>256*1024*1024)fail('C250_PAYLOAD');
 if(raw&&(!/^[a-f0-9]{64}$/.test(planHash||'')||hash(raw)!==planHash))fail('C250_PLAN_HASH');return p;
}
export function seal(bytes,key,aad){if(key.length!==32)fail('C250_KEY');const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(aad));const out=Buffer.concat([c.update(bytes),c.final()]);return Buffer.concat([Buffer.from('C250AES1'),iv,c.getAuthTag(),out]);}
export function unseal(bytes,key,aad){if(key.length!==32||bytes.length<36||bytes.subarray(0,8).toString()!=='C250AES1')fail('C250_ENVELOPE');const c=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(8,20));c.setAAD(Buffer.from(aad));c.setAuthTag(bytes.subarray(20,36));return Buffer.concat([c.update(bytes.subarray(36)),c.final()]);}
export function safeNames(names){if(!names.length||names.length>25000)fail('C250_ARCHIVE_COUNT');for(const name of names){if(!name||name.length>400||name.startsWith('/')||name.includes('\\')||name.includes(':')||name.split('/').some(s=>s==='..')||/[\x00-\x1f]/.test(name))fail('C250_ARCHIVE_PATH');}return names;}
const aad=(p,kind)=>p.id+'|'+p.sourceSha+'|'+kind;
async function get(name){const r=await fetch('https://github.com/'+REPO+'/releases/download/'+PLAN+'/'+name,{signal:AbortSignal.timeout(180000)});if(r.status!==200)fail('C250_FETCH');return Buffer.from(await r.arrayBuffer());}
async function readPlan(){const raw=await get('plan.json');if(raw.length>8192)fail('C250_PLAN_SIZE');return validate(JSON.parse(raw),{raw});}
export function prependPath(env,dir){const inherited=Object.entries(env).find(([k])=>k.toLowerCase()==='path')?.[1]||'';for(const k of Object.keys(env))if(k.toLowerCase()==='path')delete env[k];env.PATH=dir+path.delimiter+inherited;return env;}
export const tarTool=()=>process.platform==='win32'?'C:/Program Files/Git/usr/bin/tar.exe':'tar';
export function tarExec(args,cwd){const win=process.platform==='win32',tool=tarTool();return execFileSync(tool,win?['--force-local','--quoting-style=literal',...args.map(a=>a.replaceAll(String.fromCharCode(92),'/'))]:args,{cwd,env:win?prependPath({...process.env,LC_ALL:'C.UTF-8',LANG:'C.UTF-8'},path.dirname(tool)):process.env,encoding:'utf8',maxBuffer:8e6}).trim();}
function exec(bin,args,cwd){return bin==='tar'?tarExec(args,cwd):execFileSync(bin,args,{cwd,encoding:'utf8',maxBuffer:8e6}).trim();}
export function unpack(file,dest){
 const names=safeNames(exec('tar',['-tf',file]).split(/\r?\n/).map(s=>s.replace(/^\.\//,'' )).filter(Boolean));
 const types=exec('tar',['-tvf',file]).split(/\r?\n/);if(types.some(s=>!/^[-d]/.test(s)))fail('C250_ARCHIVE_LINK');
 if(fs.existsSync(dest))fail('C250_EXISTING_DEST');fs.mkdirSync(dest,{recursive:true});exec('tar',['-xf',file,'-C',dest]);return names;
}
export function configureSourceGit(source){if(process.platform==='darwin')exec('git',['config','--local','core.precomposeunicode','true'],source);}
export function cleanEnv(env){return Object.fromEntries(Object.entries(env).filter(([k])=>!/(TOKEN|SECRET|PASSWORD|PAYLOAD_KEY|PRIVATE_KEY|ASKPASS)/i.test(k)&&!/^GITHUB_(ENV|OUTPUT|PATH|STEP_SUMMARY)$/.test(k)));}
function commands(lane){
 const n=a=>({bin:process.execPath,args:a}),npm=(cwd,args)=>({bin:process.platform==='win32'?'npm.cmd':'npm',args,cwd});
 if(lane==='source')return [npm('.',['ci','--ignore-scripts']),n(['--test','scripts/ci/workflow-cost.test.mjs']),n(['--test','scripts/installer-mirror/test.mjs']),npm('.',['run','check:boundary']),npm('.',['run','build']),n(['scripts/check-site.mjs']),n(['--test','server-compat/desktop-trust/trust.test.mjs']),n(['--test','server-compat/remote-access/access.test.mjs','server-compat/remote-access/directory.test.mjs','server-compat/remote-access/resume.test.mjs']),{bin:'bash',args:['-euc',`stat -c '%n owner=%u mode=%a' /opt /srv
fixture_node=$(mktemp /tmp/ddk-fixture-node.XXXXXX)
trap 'rm -f "$fixture_node"' EXIT
cp "$(command -v node)" "$fixture_node"
chmod 0755 "$fixture_node"
sudo unshare --mount --propagation private bash -euc 'mount -t tmpfs -o mode=0755 tmpfs /opt; mount -t tmpfs -o mode=0755 tmpfs /srv; DDK_RESTART_FIXTURE_CI=1 "$1" --test desktop/tests/update-restart.test.mjs desktop/tests/update-restart-root-fixture.test.mjs desktop/tests/admin-linux-control.test.mjs desktop/tests/linux-package.test.mjs' -- "$fixture_node"`]}];
 if(lane.startsWith('mobile'))return [npm('mobile',['ci','--no-audit','--no-fund']),npm('mobile',['audit','--audit-level=low']),n(['mobile/prepare-web.mjs']),n(['--test','desktop/tests/mobileios.test.mjs','desktop/tests/mobileicon.test.mjs','desktop/tests/mobileiosci.test.mjs','desktop/tests/mobileiostf.test.mjs','desktop/tests/androidci.test.mjs']),n(['--test',...['envelope','local'].map(s=>'scripts/mobile-key-migration/'+s+'.test.mjs'),...['deploy','provenance','archive','retire','retire-cli'].map(s=>'scripts/mobile-free-release/'+s+'.test.mjs')]),{bin:'git',args:['init','.release-gate-test']},{bin:'git',args:['-C','.release-gate-test','fetch','--depth=1','https://github.com/'+REPO+'.git','6820ec09c320eaebf88503e15d52c134ede8fbc6']},{bin:'git',args:['-C','.release-gate-test','checkout','--detach','FETCH_HEAD']},n(['--test','scripts/mobile-free-release/e2e.test.mjs']),npm('mobile',['run','verify:toolchain']),{...n(['--test','release-record.test.mjs']),cwd:'mobile'}];
 if(lane==='ma')return [n(['--test','scripts/mobile-free-release/archive.test.mjs','scripts/mobile-free-release/ma-e2e.test.mjs'])];
 if(lane==='windows')return [npm('desktop',['ci','--no-audit','--no-fund']),npm('runner',['ci','--ignore-scripts','--no-audit','--no-fund']),n(['scripts/release-integrity-check.mjs','--mode','package']),n(['mobile/prepare-web.mjs']),n(['desktop/tests/classic-suite.mjs']),n(['--test','server-compat/desktop-trust/trust.test.mjs','server-compat/remote-access/access.test.mjs','server-compat/remote-access/directory.test.mjs','server-compat/remote-access/resume.test.mjs']),{bin:'bash',args:['-ec','cd desktop && npx electron-builder --win --x64 --publish never']},{bin:'bash',args:['runner/server/make-source-package.sh','--sha','HEAD']},n(['scripts/classic-artifact-check.mjs','--record'])];
 fail('C250_LANE');
}
export {commands,aad};
async function upload(name,bytes,token){
 const headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
 const r=await fetch('https://api.github.com/repos/'+REPO+'/releases/tags/'+PLAN,{headers});if(!r.ok)fail('C250_RELEASE');const release=await r.json();
 if(release.assets.some(a=>a.name===name))fail('C250_DUPLICATE_RESULT');
 const out=await fetch(release.upload_url.split('{')[0]+'?name='+encodeURIComponent(name),{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream'},body:bytes});if(out.status!==201)fail('C250_UPLOAD');
}
async function collect(){
 const p=await readPlan(),token=process.env.GH_TOKEN||'',runId=process.env.DIAGNOSTIC_RECOVERY==='true'?'41638849573':process.env.GITHUB_RUN_ID;
 for(const lane of LANES){const name=lane+'-'+runId+'.sealed',file=path.join(process.cwd(),'classic250-encrypted-results',name);const bytes=fs.readFileSync(file);if(bytes.length<36||bytes.length>256*1024*1024||bytes.subarray(0,8).toString()!=='C250AES1')fail('C250_COLLECT');await upload(name,bytes,token);}
 console.log('C250_ENCRYPTED_RESULTS_UPLOADED');
}
async function cacheBudget(){
 const r=await fetch('https://api.github.com/repos/'+REPO+'/actions/cache/usage',{headers:{Authorization:'Bearer '+process.env.GH_TOKEN,Accept:'application/vnd.github+json'}});if(!r.ok)fail('C250_CACHE_BUDGET');const u=await r.json();if(!Number.isSafeInteger(u.active_caches_size_in_bytes)||u.active_caches_size_in_bytes>8*1024**3)fail('C250_CACHE_BUDGET');
}
async function run(){
 const p=await readPlan(),lane=process.env.LANE;if(!LANES.includes(lane))fail('C250_LANE');const expected=lane==='windows'?'win32':lane==='ma'?'darwin':'linux';if(process.platform!==expected)fail('C250_OS');if(Number(process.versions.node.split('.')[0])!==(lane==='mobile20'?20:22))fail('C250_NODE');
 const key=Buffer.from(process.env.CLASSIC_CI_PAYLOAD_KEY||'','base64'),token=process.env.GH_TOKEN||'';delete process.env.CLASSIC_CI_PAYLOAD_KEY;delete process.env.GH_TOKEN;
 const encrypted=await get('payload.sealed');if(encrypted.length!==p.payloadBytes||hash(encrypted)!==p.payloadSha256)fail('C250_PAYLOAD_HASH');
 const root=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP||process.cwd(),'classic250-')),archive=path.join(root,'source.tar.gz'),source=path.join(root,'source'),out=path.join(root,'result');fs.mkdirSync(out);failureCapture=async error=>{const report={id:p.id,sourceSha:p.sourceSha,controlSha:p.controlSha,lane,runId:process.env.GITHUB_RUN_ID,ok:false,message:String(error?.message||error).slice(0,2000),stderr:String(error?.stderr||'').slice(0,16000)};fs.writeFileSync(path.join(out,'setup-failure.json'),JSON.stringify(report));const diagnosticTar=path.join(root,'setup-failure.tar.gz');exec('tar',['-czf',diagnosticTar,'-C',out,'.']);const dir=path.join(process.cwd(),'classic250-encrypted-results');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,lane+'-'+process.env.GITHUB_RUN_ID+'.sealed'),seal(fs.readFileSync(diagnosticTar),key,aad(p,'result|'+lane+'|'+process.env.GITHUB_RUN_ID)));key.fill(0);};fs.writeFileSync(archive,unseal(encrypted,key,aad(p,'source')));unpack(archive,source);configureSourceGit(source);
 if(exec('git',['rev-parse','HEAD'],source)!==p.sourceSha||exec('git',['rev-parse','HEAD^{tree}'],source)!==p.sourceTree||exec('git',['status','--porcelain','--untracked-files=all'],source)!=='')fail('C250_SOURCE');
 const hashes={};for(const name of ['ci.yml','mobile-toolchain.yml','desktop-classic.yml']){hashes[name]=hash(fs.readFileSync(path.join(source,'.github/workflows',name)));if(hashes[name]!==p.workflowHashes[name])fail('C250_WORKFLOW_DRIFT');}
 const env={...cleanEnv(process.env),TZ:'Asia/Seoul',GITHUB_REPOSITORY:'A1STUDIO0323/A1PROGRAM-HOME',GITHUB_SHA:p.sourceSha,GITHUB_WORKSPACE:source,GATE_TEST_ROOT:path.join(source,'.release-gate-test')};
 // Public-release reads are needed only by the existing Windows prebuild; token cannot access private source/signing keys.
 if(lane==='windows'){env.GH_TOKEN=token;const bash='C:/Program Files/Git/bin/bash.exe';if(!fs.existsSync(bash))fail('C250_GIT_BASH');prependPath(env,path.dirname(bash));}
 const results=[];for(const [i,c]of commands(lane).entries()){
  const log=fs.openSync(path.join(out,'step-'+i+'.log'),'w');let result;try{result=spawnSync(process.platform==='win32'&&c.bin==='bash'?'C:/Program Files/Git/bin/bash.exe':c.bin,c.args,{cwd:path.resolve(source,c.cwd||'.'),env,stdio:['ignore',log,log],timeout:35*60000,shell:process.platform==='win32'&&c.bin==='npm.cmd'});}finally{fs.closeSync(log);}
  results.push({step:i,exit:result.status,error:!!result.error});if(result.status!==0)break;
 }
 const ok=results.length===commands(lane).length&&results.every(r=>r.exit===0),runId=process.env.GITHUB_RUN_ID;
 const receipt={v:1,id:p.id,sourceSha:p.sourceSha,sourceTree:p.sourceTree,version:p.version,controlSha:p.controlSha,runId,lane,platform:process.platform,node:process.versions.node,ok,results,workflowHashes:hashes,files:[]};
 if(ok&&lane==='windows')for(const name of ['A1Runner-Setup-'+VERSION+'.exe','A1Runner-Setup-'+VERSION+'.exe.blockmap','latest.yml','source-'+VERSION+'.tar.gz','classic-build.json']){const file=path.join(source,'desktop/dist',name),bytes=fs.readFileSync(file);receipt.files.push({name,size:bytes.length,sha256:hash(bytes)});fs.writeFileSync(path.join(out,name),bytes);}
 fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify(receipt));const bundle=path.join(root,'result.tar.gz');exec('tar',['-czf',bundle,'-C',out,'.']);const result=seal(fs.readFileSync(bundle),key,aad(p,'result|'+lane+'|'+runId));if(result.length>256*1024*1024)fail('C250_RESULT_SIZE');const encryptedDir=path.join(process.cwd(),'classic250-encrypted-results');fs.mkdirSync(encryptedDir,{recursive:true});fs.writeFileSync(path.join(encryptedDir,lane+'-'+runId+'.sealed'),result);key.fill(0);failureCapture=null;if(!ok)fail('C250_CHECK_FAILED');console.log('C250_LANE_OK '+lane);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))try{if(process.argv[2]==='check'){await readPlan();await cacheBudget();console.log('C250_PLAN_OK');}else if(process.argv[2]==='run')await run();else if(process.argv[2]==='collect')await collect();else fail('C250_COMMAND');}catch(error){if(failureCapture)try{await failureCapture(error);}catch{}const code=/^C250_[A-Z0-9_]+$/.test(error?.message||'')?error.message:'C250_EXECUTION_FAILED';console.error(code+'; encrypted diagnostic result required');process.exitCode=1;}
