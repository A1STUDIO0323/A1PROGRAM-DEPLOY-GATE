import {requireGate,sha256} from './gate.mjs';

const others = tracks => JSON.stringify(tracks.filter(x => x.track !== 'alpha').sort((a,b)=>a.track.localeCompare(b.track)));
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
    requireGate(JSON.stringify(actualInternal.releaseNotes)===JSON.stringify([{language:'ko-KR',text:internalReceipt.releaseNotes}]),'E_GATE_INTERNAL_NOTES_READBACK');
    const bundles=(await api(base+'/edits/'+edit+'/bundles')).bundles||[];
    const same=bundles.find(x=>Number(x.versionCode)===plan.mgVersionCode);
    requireGate(same?.sha256===plan.mgSignedSha256, 'E_GATE_BUNDLE_MISMATCH');
    const already=releaseFor(before,'alpha',plan.mgVersionCode);
    if(already) {
      requireGate(JSON.stringify(already.releaseNotes)===JSON.stringify(notes), 'E_GATE_EXISTING_ALPHA_NOTES_MISMATCH');
    } else {
      await api(base+'/edits/'+edit+'/tracks/alpha','PUT',{track:'alpha',releases:[{name:plan.version,versionCodes:[String(plan.mgVersionCode)],status:'completed',releaseNotes:notes}]});
      const staged=(await api(base+'/edits/'+edit+'/tracks')).tracks||[];
      requireGate(others(before)===others(staged), 'E_GATE_OTHER_TRACK_CHANGED');
      const found=releaseFor(staged,'alpha',plan.mgVersionCode);
      requireGate(found&&JSON.stringify(found.releaseNotes)===JSON.stringify(notes), 'E_GATE_ALPHA_STAGED');
      await api(base+'/edits/'+edit+':validate','POST',{});
      commitAttempted=true;
      await api(base+'/edits/'+edit+':commit','POST',{});
      writeReceipt({...receipt,status:'submitted-readback-pending'});
    }
    readEdit=(await api(base+'/edits','POST',{})).id;
    const after=(await api(base+'/edits/'+readEdit+'/tracks')).tracks||[];
    const found=releaseFor(after,'alpha',plan.mgVersionCode);
    requireGate(found&&JSON.stringify(found.releaseNotes)===JSON.stringify(notes)&&others(before)===others(after), 'E_GATE_ALPHA_READBACK');
    const result={...receipt,status:'committed-track-readback',internalReadbackVerified:true,review:'check-console',published:'check-console',physical:'unverified'};
    writeReceipt(result);return result;
  } catch(error) {
    writeReceipt({...receipt,status:commitAttempted?'commit-outcome-unconfirmed':'stopped-before-commit',errorCode:/^E_GATE_[A-Z_]+$/.test(error.message)?error.message:'E_GATE_PLAY_FAILED'});
    throw error;
  } finally {
    for(const id of [readEdit,!commitAttempted&&edit].filter(Boolean)) { try { await api(base+'/edits/'+id,'DELETE'); } catch {} }
  }
}
