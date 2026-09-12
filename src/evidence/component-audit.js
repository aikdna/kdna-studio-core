"use strict";
const crypto=require('node:crypto');
const {record,own,text,group,hash,clone,fail}=require('../creation-engine/component-input');
function validateAudit(evidence,descriptor,buildMaterialization){
 const c=evidence.context,d=evidence.decision;
 record(c,['session_id','revision','agent','asset','createdAt','adoption_channel','corePackageVersion','synthetic_fixture','brief','materials','groups','history','authorization','selected']);
 record(c.agent,['name','version']);text(c.agent.name);text(c.agent.version);
 record(c.asset,['asset_id','asset_uid','version']);for(const x of Object.values(c.asset))text(x);
 record(c.adoption_channel,['kind','channel']);text(c.adoption_channel.channel);
 record(c.brief,['title','scope']);text(c.brief.title);text(c.brief.scope);
 if(!Number.isSafeInteger(c.revision)||c.revision<1||typeof c.synthetic_fixture!=='boolean'||!Number.isFinite(Date.parse(c.createdAt)))fail('CREATION_CONTEXT_INVALID');
 record(d,['format','adoption_kind','session_id','revision','context_digest','preview_digest','proposal_digests','actual_reply','authorization']);
 if(d.format!=='kdna.studio-decision/2'||d.adoption_kind!==c.adoption_channel.kind)fail('CREATION_DECISION_INVALID');
 let state={revision:0,brief:null,materials:[],groups:[],choices:null};let previous=null;const seen=new Set();
 function reply(entry){
  record(entry,['response','interpretation','review','interpreted_by','identity']);record(entry.response,['id','role','channel','review_id','text']);text(entry.response.id);text(entry.response.text);
  record(entry.review,['review_id','session_id','revision','kind','channel','groups','preview']);
  if(entry.identity!=='not_verified'||hash(entry.interpreted_by)!==hash(c.agent)||entry.response.role!==(c.adoption_channel.kind==='delegated_agent_editorial'?'agent':'human')||entry.response.channel!==c.adoption_channel.channel||entry.review.channel!==c.adoption_channel.channel||entry.review.kind!==c.adoption_channel.kind||entry.review.session_id!==c.session_id||entry.response.review_id!==entry.review.review_id||seen.has(entry.response.id))fail('CREATION_AUDIT_REPLY_INVALID');
  seen.add(entry.response.id);record(entry.interpretation,['kind','choices'],['kind']);
 }
 function selection(intent){
  if(!Array.isArray(intent.choices)||intent.choices.length!==state.groups.length)fail('CREATION_SELECTION_INCOMPLETE');const choices={};
  for(const x of intent.choices){record(x,['judgmentLocalKey','alternativeLocalKey']);const g=state.groups.find(g=>g.localKey===x.judgmentLocalKey);if(!g||own(choices,x.judgmentLocalKey)||!g.alternatives.some(a=>a.localKey===x.alternativeLocalKey))fail('CREATION_SELECTION_INVALID');choices[x.judgmentLocalKey]=x.alternativeLocalKey;}
  return choices;
 }
 function validateMaterial(m){record(m,['id','kind','title','content','coordinate','content_digest','recorded_at']);for(const k of ['id','title','content','coordinate','recorded_at'])text(m[k]);if(!['text','interview'].includes(m.kind)||!Number.isFinite(Date.parse(m.recorded_at))||m.content_digest!=='sha256:'+crypto.createHash('sha256').update(m.content,'utf8').digest('hex')||state.materials.some(x=>x.id===m.id||x.coordinate===m.coordinate))fail('CREATION_MATERIAL_MISMATCH');}
 for(let i=0;i<c.history.length;i++){
  const event=c.history[i];record(event,['sequence','revision','event','at','detail','previous_digest','digest']);const {digest,...body}=event;
  if(event.sequence!==i+1||event.previous_digest!==previous||hash(body)!==digest||!Number.isFinite(Date.parse(event.at)))fail('CREATION_HISTORY_MISMATCH');previous=digest;
  const v=event.detail;
  if(event.event==='reply_rejected'){record(v,['code']);text(v.code);if(event.revision!==state.revision)fail('CREATION_HISTORY_REVISION_MISMATCH');continue;}
  if(event.event==='brief'){record(v,['title','scope']);text(v.title);text(v.scope);state.brief=clone(v);state.choices=null;}
  else if(event.event==='material'){validateMaterial(v);state.materials.push(clone(v));state.choices=null;}
  else if(event.event==='proposal'){record(v,['localKey','alternatives','revision']);if(v.revision!==1||state.groups.some(g=>g.localKey===v.localKey))fail('CREATION_AUDIT_PROPOSAL_INVALID');group({localKey:v.localKey,alternatives:v.alternatives},state.materials);state.groups.push(clone(v));state.choices=null;}
  else if(event.event==='revision'){record(v,['prior','next','explanation']);text(v.explanation);const index=state.groups.findIndex(g=>g.localKey===v.prior.localKey);if(index<0||hash(state.groups[index])!==hash(v.prior)||v.next.localKey!==v.prior.localKey||v.next.revision!==v.prior.revision+1)fail('CREATION_AUDIT_REVISION_INVALID');record(v.next,['localKey','alternatives','revision']);group({localKey:v.next.localKey,alternatives:v.next.alternatives},state.materials);state.groups[index]=clone(v.next);state.choices=null;}
  else if(['selection','note','reject'].includes(event.event)){
   reply(v);if(v.review.revision!==state.revision||hash(v.review.groups)!==hash(state.groups))fail('CREATION_AUDIT_REVIEW_STALE');
   if(event.event==='selection'){if(v.interpretation.kind!=='select')fail('CREATION_AUDIT_INTENT_MISMATCH');state.choices=selection(v.interpretation);}
   else{if(v.interpretation.kind!==event.event||own(v.interpretation,'choices'))fail('CREATION_AUDIT_INTENT_MISMATCH');if(event.event==='reject')state.choices=null;}
  }else fail('CREATION_HISTORY_EVENT_UNSUPPORTED');
  state.revision++;if(event.revision!==state.revision)fail('CREATION_HISTORY_REVISION_MISMATCH');
 }
 if(!state.choices||state.revision!==c.revision||hash(state.brief)!==hash(c.brief)||hash(state.materials)!==hash(c.materials)||hash(state.groups)!==hash(c.groups))fail('CREATION_AUDIT_STATE_MISMATCH');
 const selected=state.groups.map(g=>({judgmentLocalKey:g.localKey,alternative:g.alternatives.find(a=>a.localKey===state.choices[g.localKey])}));if(hash(selected)!==hash(c.selected))fail('CREATION_AUDIT_SELECTED_MISMATCH');
 const plan=buildMaterialization(c,descriptor,{adoption_kind:d.adoption_kind,phase:'preview-only'});
 const review={session_id:c.session_id,revision:c.revision,kind:'pre_compiler_authoring_review',context_digest:hash(c),selected:clone(c.selected),expected_component_bindings:plan.expectedComponents,presence:plan.presence,proposal_digests:plan.proposalDigests,creation_accepted:'not_evaluated'};
 const preview={...review,preview_digest:hash(review)};reply(d.actual_reply);
 if(d.actual_reply.review.revision!==c.revision||hash(d.actual_reply.review.groups)!==hash(c.groups)||d.actual_reply.interpretation.kind!=='confirm'||own(d.actual_reply.interpretation,'choices')||hash(d.actual_reply.review.preview)!==hash(preview)||d.preview_digest!==preview.preview_digest||hash(d.proposal_digests)!==hash(plan.proposalDigests))fail('CREATION_PREVIEW_ADOPTION_MISMATCH');
 if(evidence.history.length!==c.history.length+1||hash(evidence.history.slice(0,-1))!==hash(c.history))fail('CREATION_CONTEXT_HISTORY_MISMATCH');
 const final=evidence.history.at(-1);record(final,['sequence','revision','event','at','detail','previous_digest','digest']);const {digest,...body}=final;
 if(final.sequence!==c.history.length+1||final.revision!==c.revision||final.event!=='final_adoption'||hash(final.detail)!==hash(d)||final.previous_digest!==previous||hash(body)!==digest||!Number.isFinite(Date.parse(final.at)))fail('CREATION_FINAL_HISTORY_MISMATCH');
}
module.exports={validateAudit};
