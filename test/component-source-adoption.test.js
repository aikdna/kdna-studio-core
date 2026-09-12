"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const api=require('..'),core=require('@aikdna/kdna-core');
const root=path.resolve(process.env.STUDIO_TEST_ARTIFACT_ROOT || path.join(__dirname,'.artifacts',String(process.pid)));fs.mkdirSync(root,{recursive:true});let serial=0;
function fixture(mutate){
 const id=++serial,channel='synthetic-source-'+id;let next='select';
 const s=api.createSession({agent:{name:'Synthetic source/adoption fixture',version:'1'},syntheticFixture:true,adoptionInput:{kind:'delegated_agent_editorial',channel,authorization:{coordinate:'fixture:local-only',statement:'Synthetic implementation test, not actual Agent editorial adoption.'},receive:review=>{const response={id:'reply-'+id+'-'+next,role:'agent',channel,review_id:review.review_id,text:next};return mutate?mutate(response,review):response;}},interpretReply:text=>text==='select'?{kind:'select',choices:[{judgmentLocalKey:'observation',alternativeLocalKey:'preserve'}]}:{kind:'confirm'}});
 s.agent.setBrief({title:'Public source mapping',scope:'Synthetic missing observation'});const material=s.agent.recordMaterial({kind:'text',title:'Private note',content:'PRIVATE_SOURCE_NOTE_'+id,coordinate:'private:synthetic-source-'+id});
 const a={localKey:'preserve',title:'Preserve uncertainty',subject:'An observation',scope:'Missing input',statement:'Retain uncertainty.',rationale:'Absence is not a negative observation.',materialRefs:[material.id],publicSources:[{localKey:'reference',identity:'urn:synthetic:public-reference',version:'1',uses:[{localKey:'statement',role:'support'}]}],publicNotices:[{localKey:'license',statement:'Synthetic public notice — source identity is explicit.',sourceLocalKeys:['reference']}]};
 s.agent.propose({localKey:'observation',alternatives:[a,{...a,localKey:'infer',statement:'Infer a negative finding.'}]});
 return {s,material,async ready(){await s.receiveAdoptionReply();s.agent.compilePreview();next='confirm';await s.receiveAdoptionReply();return s.exportAsset();}};
}
test('public source and notice map without publishing private authoring material',async()=>{
 const f=fixture(),out=await f.ready(),file=path.join(root,'public-source-notice.kdna');fs.writeFileSync(file,out.bytes,{flag:'wx'});const readback=fs.readFileSync(file);assert.equal(f.s.completeSave(readback).status,'accepted_with_live_context');const admitted=core.admitBytes(readback);assert.equal(admitted.status,'accepted');
 const ir=JSON.stringify(admitted.snapshot.ir);assert.ok(ir.includes('urn:synthetic:public-reference'));assert.ok(ir.includes('Synthetic public notice'));assert.equal(ir.includes(f.material.content),false);assert.equal(ir.includes(f.material.coordinate),false);assert.equal(api.verifyCreationEvidence(readback,out.evidence,out.binding).status,'consistent');
});
for(const [name,mutate] of [['wrong role',r=>({...r,role:'human'})],['wrong review',r=>({...r,review_id:'different-review'})],['wrong channel',r=>({...r,channel:'different-channel'})]])test('adoption does not accept '+name,async()=>{const f=fixture(mutate);await assert.rejects(f.s.receiveAdoptionReply());assert.throws(()=>f.s.exportAsset());});
