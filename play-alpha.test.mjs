import test from 'node:test';
import assert from 'node:assert/strict';
import {promoteAlpha} from './play-alpha.mjs';
import {sha256} from './gate.mjs';
const plan={sourceSha:'a'.repeat(40),mgVersionCode:29891489,mgSignedSha256:'b'.repeat(64),version:'0.16.210'};
const notes=[{language:'ko-KR',text:'고객 기능과 연결 복구를 개선했습니다. 기기 확인은 별도 진행합니다.'}];
const receipt={status:'completed',storeNotesVerified:true,sourceSha:plan.sourceSha,versionCode:plan.mgVersionCode,signedSha256:plan.mgSignedSha256,releaseNotes:notes[0].text,notesSha256:sha256(notes[0].text)};
const clone=x=>structuredClone(x);
function mock(options={}) {
 let committed=[{track:'internal',releases:[{status:'completed',versionCodes:[String(plan.mgVersionCode)],releaseNotes:clone(notes)}]},{track:'alpha',releases:[{status:'completed',versionCodes:['200']}]},{track:'production',releases:[]}];
 if(options.wrongInternalNotes)committed[0].releases[0].releaseNotes[0].text='different';
 if(options.noInternal)committed[0].releases=[];
 if(options.noAlpha)committed=committed.filter(x=>x.track!=='alpha');
 if(options.alpha)committed.find(x=>x.track==='alpha').releases=clone(options.alpha);
 if(options.reorderNotes)committed[0].releases[0].releaseNotes=notes.map(x=>({text:x.text,language:x.language}));
 const edits=new Map(),calls=[],receipts=[];let i=0;
 return {calls,receipts,api:async(url,method='GET',body)=>{
  calls.push({url,method,body});
  if(url==='/app/edits'&&method==='POST'){const id=String(++i);edits.set(id,clone(committed));return {id};}
  const m=url.match(/^\/app\/edits\/(\d+)(.*)$/);assert.ok(m,url);const [,id,tail]=m;
  if(method==='DELETE'){edits.delete(id);return {};}
  if(tail==='/tracks'&&method==='GET')return {tracks:clone(edits.get(id))};
  if(tail==='/bundles')return {bundles:[{versionCode:plan.mgVersionCode,sha256:options.wrongBundle?'c'.repeat(64):plan.mgSignedSha256}]};
  if(tail==='/tracks/alpha'&&method==='PUT'){
   const tracks=edits.get(id),n=tracks.findIndex(x=>x.track==='alpha');tracks[n]=clone(body);
   if(options.dropTargeting)delete tracks[n].releases[0].countryTargeting;
   if(options.changeProduction)tracks.find(x=>x.track==='production').releases=[{versionCodes:['999']}];return {};
  }
  if(tail===':validate')return {};
  if(tail===':commit') {if(options.commitLost)throw Error('network timeout');committed=clone(edits.get(id));return {};}
  throw Error('unexpected mock call');
 },writeReceipt:x=>receipts.push(x)};
}
test('promotes existing exact bundle after internal readback, preserves other tracks, separates review/publish/physical',async()=>{
 const m=mock();const r=await promoteAlpha({...m,base:'/app',plan,internalReceipt:receipt,notes});
 assert.equal(r.status,'committed-track-readback');assert.equal(r.review,'check-console');assert.equal(r.published,'check-console');assert.equal(r.physical,'unverified');
 assert.equal(m.calls.filter(x=>x.method==='PUT').length,1);
 assert.ok(m.calls.every(x=>!x.url.includes('/upload/')));
});
for(const [name,opts] of [['missing internal',{noInternal:true}],['wrong internal notes',{wrongInternalNotes:true}],['missing existing alpha',{noAlpha:true}],['different signed bundle',{wrongBundle:true}],['other track changed',{changeProduction:true}]])
 test('stops before commit: '+name,async()=>{const m=mock(opts);await assert.rejects(promoteAlpha({...m,base:'/app',plan,internalReceipt:receipt,notes}));assert.ok(m.calls.every(x=>!x.url.endsWith(':commit')));});
test('wrong internal receipt cannot call API',async()=>{const m=mock();await assert.rejects(promoteAlpha({...m,base:'/app',plan,internalReceipt:{...receipt,versionCode:1},notes}));assert.equal(m.calls.length,0);});
test('lost commit response is unknown; no automatic commit retry or edit deletion',async()=>{
 const m=mock({commitLost:true});await assert.rejects(promoteAlpha({...m,base:'/app',plan,internalReceipt:receipt,notes}));
 assert.equal(m.calls.filter(x=>x.url.endsWith(':commit')).length,1);
 assert.equal(m.receipts.at(-1).status,'commit-outcome-unconfirmed');assert.ok(m.calls.every(x=>x.method!=='DELETE'));
});
test('explicit Alpha recovery checks actual internal notes and same bundle after an uncertain prior internal commit, without re-upload',async()=>{
 const m=mock();const r=await promoteAlpha({...m,base:'/app',plan,internalReceipt:{...receipt,status:'commit-response-unknown',storeNotesVerified:false},notes});
 assert.equal(r.internalReadbackVerified,true);assert.ok(m.calls.every(x=>!x.url.includes('/upload/')));
 assert.deepEqual(m.calls.filter(x=>x.method==='PUT').map(x=>x.url),['/app/edits/1/tracks/alpha']);
});

test('preserves existing Alpha country targeting and update priority, regardless of note property order',async()=>{
 const previous={status:'completed',versionCodes:['200'],countryTargeting:{countries:['KR'],includeRestOfWorld:false},inAppUpdatePriority:3};
 const m=mock({alpha:[previous],reorderNotes:true});
 await promoteAlpha({...m,base:'/app',plan,internalReceipt:receipt,notes});
 const body=m.calls.find(x=>x.method==='PUT').body;
 assert.deepEqual(body.releases[0].countryTargeting,previous.countryTargeting);assert.equal(body.releases[0].inAppUpdatePriority,3);
});
for(const releases of [[{status:'draft',versionCodes:['200']}],[{status:'inProgress',versionCodes:['200'],userFraction:0.1}],
 [{status:'halted',versionCodes:['200']}],[{status:'completed',versionCodes:['200']},{status:'draft',versionCodes:['201']}],
 [{status:'completed',versionCodes:['200'],unknownPolicy:true}]])
 test('unapproved Alpha shape stops before PUT and commit: '+JSON.stringify(releases),async()=>{
  const m=mock({alpha:releases});await assert.rejects(promoteAlpha({...m,base:'/app',plan,internalReceipt:receipt,notes}),/E_GATE_ALPHA_SHAPE/);
  assert.ok(m.calls.every(x=>x.method!=='PUT'&&!x.url.endsWith(':commit')));
 });
test('staged Alpha targeting drift stops before commit',async()=>{
 const m=mock({alpha:[{status:'completed',versionCodes:['200'],countryTargeting:{countries:['KR'],includeRestOfWorld:false}}],dropTargeting:true});
 await assert.rejects(promoteAlpha({...m,base:'/app',plan,internalReceipt:receipt,notes}),/E_GATE_ALPHA_STAGED/);
 assert.ok(m.calls.every(x=>!x.url.endsWith(':commit')));
});
for(const targeting of [{countries:['KR']},{includeRestOfWorld:true}])
 test('preserves omitted optional targeting fields without adding defaults: '+JSON.stringify(targeting),async()=>{
  const m=mock({alpha:[{status:'completed',versionCodes:['200'],countryTargeting:targeting}]});
  await promoteAlpha({...m,base:'/app',plan,internalReceipt:receipt,notes});
  assert.deepEqual(m.calls.find(x=>x.method==='PUT').body.releases[0].countryTargeting,targeting);
 });
