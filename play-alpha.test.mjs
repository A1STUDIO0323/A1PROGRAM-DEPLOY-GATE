import test from 'node:test';
import assert from 'node:assert/strict';
import {promoteAlpha} from './play-alpha.mjs';
const plan={sourceSha:'a'.repeat(40),mgVersionCode:29891489,mgSignedSha256:'b'.repeat(64),version:'0.16.210'};
const receipt={status:'completed',storeNotesVerified:true,sourceSha:plan.sourceSha,versionCode:plan.mgVersionCode,signedSha256:plan.mgSignedSha256};
const notes=[{language:'ko-KR',text:'고객 기능과 연결 복구를 개선했습니다. 기기 확인은 별도 진행합니다.'}];
const clone=x=>structuredClone(x);
function mock(options={}) {
 let committed=[{track:'internal',releases:[{status:'completed',versionCodes:[String(plan.mgVersionCode)]}]},{track:'alpha',releases:[{status:'completed',versionCodes:['200']}]},{track:'production',releases:[]}];
 if(options.noInternal)committed[0].releases=[];
 if(options.noAlpha)committed=committed.filter(x=>x.track!=='alpha');
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
for(const [name,opts] of [['missing internal',{noInternal:true}],['missing existing alpha',{noAlpha:true}],['different signed bundle',{wrongBundle:true}],['other track changed',{changeProduction:true}]])
 test('stops before commit: '+name,async()=>{const m=mock(opts);await assert.rejects(promoteAlpha({...m,base:'/app',plan,internalReceipt:receipt,notes}));assert.ok(m.calls.every(x=>!x.url.endsWith(':commit')));});
test('wrong internal receipt cannot call API',async()=>{const m=mock();await assert.rejects(promoteAlpha({...m,base:'/app',plan,internalReceipt:{...receipt,versionCode:1},notes}));assert.equal(m.calls.length,0);});
test('lost commit response is unknown; no automatic commit retry or edit deletion',async()=>{
 const m=mock({commitLost:true});await assert.rejects(promoteAlpha({...m,base:'/app',plan,internalReceipt:receipt,notes}));
 assert.equal(m.calls.filter(x=>x.url.endsWith(':commit')).length,1);
 assert.equal(m.receipts.at(-1).status,'commit-outcome-unconfirmed');assert.ok(m.calls.every(x=>x.method!=='DELETE'));
});
