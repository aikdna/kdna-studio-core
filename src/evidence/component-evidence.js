'use strict';
const crypto=require('node:crypto');
const {getBoundRuntime}=require('../creation-engine/component-runtime-binding');
const {hash,clone,freeze,record,group}=require('../creation-engine/component-input');
const {buildMaterialization}=require('../compile/component-materialization');
const {encodeComponentRuntime}=require('../compile/component-encoding');
const {validateAudit}=require('./component-audit');
function verifyCreationEvidence(bytes,evidence,expectedBinding){
  const reject=reason=>freeze({status:'inconsistent',reason,creation_accepted:'not_evaluated',live_context:'unavailable',identity:'not_verified',action_authorization:'not_evaluated'});
  try{
    const runtime=getBoundRuntime();
    if(!(bytes instanceof Uint8Array))return reject('CREATION_BYTES_INVALID');
    const captured=Buffer.from(bytes),admission=runtime.admitBytes(captured);
    if(admission.status!=='accepted')return reject('CREATION_CORE_REJECTED');
    if(evidence?.format?.id!=='kdna.studio-creation-evidence/2'||evidence.format.version!=='2.0.0')return reject('STUDIO_EVIDENCE_FORMAT_NOT_CURRENT');
    record(evidence,['format','reference_contract','component_definition','compiler','session_id','revision','context','decision','history','expected_component_bindings','presence','adoption','artifact','identity','action_authorization','creation_accepted']);
    record(evidence.format,['id','version']);
    record(evidence.compiler,['name','version','provider','artifact_sha256']);
    const compiler=evidence.compiler;
    const knownProvider=(compiler.provider==='javascript'&&compiler.name==='@aikdna/kdna-studio-core'&&compiler.version==='4.0.0-rc.components.1')||(compiler.provider==='swift'&&compiler.name==='KDNAStudioCore'&&compiler.version==='0.6.0-rc.components.1');
    if(!knownProvider||compiler.artifact_sha256!=='UNKNOWN'||hash(evidence.reference_contract)!==hash(runtime.tuple)||evidence.component_definition!==runtime.descriptor.definition_digest)return reject('CREATION_PROVIDER_CONTRACT_NOT_CURRENT');
    record(evidence.artifact,['bytes','digest']);
    if(evidence.artifact.bytes!==captured.length||evidence.artifact.digest!==admission.snapshot.digests.A.observed)return reject('CREATION_ARTIFACT_BINDING_MISMATCH');
    record(expectedBinding,['session_id','asset_digest','evidence_digest']);
    if(hash(evidence)!==expectedBinding.evidence_digest||evidence.session_id!==expectedBinding.session_id||admission.snapshot.digests.A.observed!==expectedBinding.asset_digest)return reject('CREATION_BINDING_MISMATCH');
    if(evidence.identity!=='not_verified'||evidence.action_authorization!=='not_evaluated'||evidence.creation_accepted!=='not_evaluated')return reject('CREATION_AUTHORITY_CLAIM_INVALID');
    const context=clone(evidence.context),decision=clone(evidence.decision);
    if(context.session_id!==evidence.session_id||context.revision!==evidence.revision||decision.session_id!==evidence.session_id||decision.revision!==evidence.revision||hash(context)!==decision.context_digest)return reject('CREATION_CONTEXT_BINDING_MISMATCH');
    if(!['human_claim_unverified','delegated_agent_editorial'].includes(decision.adoption_kind)||context.adoption_channel.kind!==decision.adoption_kind||hash(context.authorization)!==hash(decision.authorization))return reject('CREATION_ADOPTION_KIND_UNBOUND');
    if(decision.adoption_kind==='delegated_agent_editorial'){record(context.authorization,['coordinate','statement']);if(!context.authorization.coordinate||!context.authorization.statement)return reject('CREATION_AUTHORIZATION_RECORD_MISSING');}else if(context.authorization!==null)return reject('CREATION_AUTHORIZATION_RECORD_INVALID');
    if(context.corePackageVersion!==runtime.coreVersion)return reject('CREATION_CONTEXT_GRAPH_NOT_CURRENT');
    for(const m of context.materials){const digest='sha256:'+crypto.createHash('sha256').update(m.content,'utf8').digest('hex');if(m.content_digest!==digest)return reject('CREATION_MATERIAL_MISMATCH');}
    for(const g of context.groups)group({localKey:g.localKey,alternatives:g.alternatives},context.materials);
    if(context.selected.length!==context.groups.length||new Set(context.selected.map(s=>s.judgmentLocalKey)).size!==context.selected.length)return reject('CREATION_SELECTION_INVALID');
    for(const s of context.selected){const g=context.groups.find(g=>g.localKey===s.judgmentLocalKey);if(!g||!g.alternatives.some(a=>hash(a)===hash(s.alternative)))return reject('CREATION_SELECTED_INPUT_MISMATCH');}
    const final=decision.actual_reply,response=final?.response,review=final?.review;
    if(!response||response.channel!==context.adoption_channel.channel||review?.channel!==context.adoption_channel.channel||review?.kind!==decision.adoption_kind||response.role!==(decision.adoption_kind==='delegated_agent_editorial'?'agent':'human')||response.review_id!==review?.review_id||review.session_id!==context.session_id||review.revision!==context.revision||final.interpretation?.kind!=='confirm'||review.preview?.preview_digest!==decision.preview_digest)return reject('CREATION_FINAL_REPLY_UNBOUND');
    let previous=null;
    for(let i=0;i<evidence.history.length;i++){const {digest,...entry}=evidence.history[i];if(entry.sequence!==i+1||entry.previous_digest!==previous||hash(entry)!==digest)return reject('CREATION_HISTORY_MISMATCH');previous=digest;}
    const finalEvent=evidence.history.at(-1);if(finalEvent?.event!=='final_adoption'||hash(finalEvent.detail)!==hash(decision))return reject('CREATION_FINAL_HISTORY_MISMATCH');
    validateAudit(evidence,runtime.descriptor,buildMaterialization);
    const expected=buildMaterialization(context,runtime.descriptor,decision);
    const expectedAdmission=runtime.admitBytes(encodeComponentRuntime(expected));
    if(expectedAdmission.status!=='accepted'||hash(expectedAdmission.snapshot.ir)!==hash(admission.snapshot.ir)||hash(expected.expectedComponents)!==hash(evidence.expected_component_bindings)||hash(expected.presence)!==hash(evidence.presence)||hash(expected.adoption)!==hash(evidence.adoption))return reject('CREATION_STATIC_MATERIALIZATION_MISMATCH');
    return freeze({status:'consistent',format:clone(evidence.format),asset_digest:admission.snapshot.digests.A.observed,evidence_digest:expectedBinding.evidence_digest,adoption_kind:decision.adoption_kind,core:'valid',interpretation:'supported',creation_accepted:'not_evaluated',live_context:'unavailable',identity:'not_verified',action_authorization:'not_evaluated'});
  }catch(e){return reject(typeof e.code==='string'?e.code:'CREATION_EVIDENCE_MALFORMED');}
}
module.exports={verifyCreationEvidence};
