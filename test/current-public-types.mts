import { createSession, verifyCreationEvidence, type JudgmentDraft, type MethodDraft } from '../src/index.js';
const draft: JudgmentDraft = { localKey:'observation', alternatives:[{localKey:'preserve',title:'Preserve',subject:'Observation',scope:'Missing data',statement:'Retain unknown.',rationale:'Missing is not negative.',materialRefs:[],method:{method:{term:'direct-preference'},components:[],bindings:[]},formationRule:{conditions:[]}},{localKey:'infer',title:'Infer',subject:'Observation',scope:'Missing data',statement:'Infer a negative.',rationale:'An explicit counterproposal.',materialRefs:[]}] };
const session=createSession({agent:{name:'Synthetic type consumer',version:'1'},syntheticFixture:true,adoptionInput:{kind:'delegated_agent_editorial',channel:'test',authorization:{coordinate:'fixture:local',statement:'Synthetic type test only.'},receive:review=>({id:'reply',role:'agent',channel:'test',review_id:review.review_id,text:'select'})},interpretReply:async()=>({kind:'select',choices:[{judgmentLocalKey:'observation',alternativeLocalKey:'preserve'}]})});
session.agent.setBrief({title:'Typed public creation',scope:'Only local test'});session.agent.propose(draft);
const output=session.exportAsset();const pending:'pending_saved_readback'=output.verification.status;
const saved=session.completeSave(output.bytes);const accepted:'accepted_with_live_context'=saved.status;
const staticOnly=verifyCreationEvidence(output.bytes,output.evidence,output.binding);const unavailable:'unavailable'=staticOnly.live_context;
// @ts-expect-error Authoring cannot inject the public definition digest.
const injected:MethodDraft={method:{term:'direct-preference'},definition_digest:'forged'};
// @ts-expect-error Method presence cannot be null.
const absentMethod:MethodDraft=null;
// @ts-expect-error No caller-supplied private context capability.
session.completeSave(output.bytes,{});
// @ts-expect-error Delegated agent channel requires authorization evidence.
createSession({agent:{name:'Synthetic',version:'1'},adoptionInput:{kind:'delegated_agent_editorial',channel:'x',receive:()=>({id:'x',role:'agent',channel:'x',review_id:'x',text:'x'})},interpretReply:()=>({kind:'confirm'})});
void [pending,accepted,unavailable,injected,absentMethod];
