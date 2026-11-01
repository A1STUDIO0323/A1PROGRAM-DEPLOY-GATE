import {requireGate,sha256} from './gate.mjs';
import {isDeepStrictEqual} from 'node:util';

const others = tracks => JSON.stringify(tracks.filter(x => x.track !== 'alpha').sort((a,b)=>a.track.localeCompare(b.track)));
const sameNotes=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((x,i)=>x.language===b[i].language&&x.text===b[i].text);
function alphaRelease(tracks) {
  const track=tracks.filter(x=>x.track==='alpha');
  requireGate(track.length===1&&Array.isArray(track[0].releases)&&track[0].releases.length===1,'E_GATE_ALPHA_SHAPE');
  const release=track[0].releases[0];
  requireGate(release.status==='completed'&&Array.isArray(release.versionCodes)&&release.versionCodes.length===1&&
    Object.keys(release).every(k=>['name','versionCodes','status','releaseNotes','countryTargeting','inAppUpdatePriority'].includes(k)),'E_GATE_ALPHA_SHAPE');
  if(Object.hasOwn(release,'countryTargeting'))requireGate(release.countryTargeting&&
    Object.keys(release.countryTargeting).every(k=>['countries','includeRestOfWorld'].includes(k))&&
    (release.countryTargeting.countries===undefined||(Array.isArray(release.countryTargeting.countries)&&release.countryTargeting.countries.every(x=>/^[A-Z]{2}$/.test(x))))&&
    (release.countryTargeting.includeRestOfWorld===undefined||typeof release.countryTargeting.includeRestOfWorld==='boolean'),'E_GATE_ALPHA_SHAPE');
  if(Object.hasOwn(release,'inAppUpdatePriority'))requireGate(Number.isInteger(release.inAppUpdatePriority)&&release.inAppUpdatePriority>=0&&release.inAppUpdatePriority<=5,'E_GATE_ALPHA_SHAPE');
  return release;
}
const releaseEqual=(actual,expected)=>sameNotes(actual.releaseNotes,expected.releaseNotes)&&isDeepStrictEqual({...actual,releaseNotes:[]},{...expected,releaseNotes:[]});
function releaseFor(tracks,track,code) {
  return tracks.find(x=>x.track===track)?.releases?.find(x=>x.status==='completed'&&x.versionCodes?.length===1&&String(x.versionCodes[0])===String(code));
}
export async function promoteAlpha({api,base,plan,internalReceipt,notes,writeReceipt}) {
  requireGate(['completed','commit-response-unknown','published-readback-failed','live-readback-failed','published-readback-pending'].includes(internalReceipt?.status) &&
    internalReceipt.sourceSha===plan.sourceSha && internalReceipt.versionCode===plan.mgVersionCode &&
    internalReceipt.signedSha256===plan.mgSignedSha256 && /^[a-f0-9]{64}$/.test(plan.mgSignedSha256||''), 'E_GATE_INTERNAL_RECEIPT');
  requireGate(typeof internalReceipt.releaseNotes==='string'&&internalReceipt.releaseNotes.length>0&&internalReceipt.notesSha256===sha256(internalReceipt.releaseNotes),'E_GATE_INTERNAL_NOTES');
  requireGate(Array.isArray(notes)&&notes.length===1&&notes[0].language==='ko-KR'&&typeof notes[0].text==='string'&&notes[0].text.length>0&&notes[0].text.length<=500, 'E_GATE_ALPHA_NOTES');
  const receipt={sourceSha:plan.sourceSha,versionCode:plan.mgVersionCode,signedSha256:plan.mgSignedSha256,notesSha256:sha256(JSON.stringify(notes)),track:'alpha',status:'preparing',physical:'unverified'};
  let edit,readEdit,commitAttempted=false;
  try {
    edit=(await api(base+'/edits','POST',{})).id;
    const before=(await api(base+'/edits/'+edit+'/tracks')).tracks||[];
    requireGate(before.some(x=>x.track==='alpha'), 'E_GATE_EXISTING_ALPHA_REQUIRED');
    const actualInternal=releaseFor(before,'internal',plan.mgVersionCode);
    requireGate(actualInternal, 'E_GATE_INTERNAL_READBACK');
    requireGate(sameNotes(actualInternal.releaseNotes,[{language:'ko-KR',text:internalReceipt.releaseNotes}]),'E_GATE_INTERNAL_NOTES_READBACK');
    const bundles=(await api(base+'/edits/'+edit+'/bundles')).bundles||[];
    const same=bundles.find(x=>Number(x.versionCode)===plan.mgVersionCode);
    requireGate(same?.sha256===plan.mgSignedSha256, 'E_GATE_BUNDLE_MISMATCH');
    const previous=alphaRelease(before);
    const expected={name:plan.version,versionCodes:[String(plan.mgVersionCode)],status:'completed',releaseNotes:notes};
    for(const key of ['countryTargeting','inAppUpdatePriority'])if(Object.hasOwn(previous,key))expected[key]=structuredClone(previous[key]);
    const already=releaseFor(before,'alpha',plan.mgVersionCode);
    if(already) {
      requireGate(releaseEqual(previous,expected), 'E_GATE_EXISTING_ALPHA_NOTES_MISMATCH');
    } else {
      await api(base+'/edits/'+edit+'/tracks/alpha','PUT',{track:'alpha',releases:[expected]});
      const staged=(await api(base+'/edits/'+edit+'/tracks')).tracks||[];
      requireGate(others(before)===others(staged), 'E_GATE_OTHER_TRACK_CHANGED');
      requireGate(releaseEqual(alphaRelease(staged),expected), 'E_GATE_ALPHA_STAGED');
      await api(base+'/edits/'+edit+':validate','POST',{});
      commitAttempted=true;
      await api(base+'/edits/'+edit+':commit','POST',{});
      writeReceipt({...receipt,status:'submitted-readback-pending'});
    }
    readEdit=(await api(base+'/edits','POST',{})).id;
    const after=(await api(base+'/edits/'+readEdit+'/tracks')).tracks||[];
    requireGate(releaseEqual(alphaRelease(after),expected)&&others(before)===others(after), 'E_GATE_ALPHA_READBACK');
    const result={...receipt,status:'committed-track-readback',internalReadbackVerified:true,review:'check-console',published:'check-console',physical:'unverified'};
    writeReceipt(result);return result;
  } catch(error) {
    writeReceipt({...receipt,status:commitAttempted?'commit-outcome-unconfirmed':'stopped-before-commit',errorCode:/^E_GATE_[A-Z_]+$/.test(error.message)?error.message:'E_GATE_PLAY_FAILED'});
    throw error;
  } finally {
    for(const id of [readEdit,!commitAttempted&&edit].filter(Boolean)) { try { await api(base+'/edits/'+id,'DELETE'); } catch {} }
  }
}
