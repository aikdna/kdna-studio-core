'use strict';

// Current component creation uses one exact public dependency graph.
const crypto=require('node:crypto');
const {own,fail,hash,clone,freeze,record,hostRecord,text,group}=require('./component-input');
const {getBoundRuntime}=require('./component-runtime-binding');
const {buildMaterialization}=require('../compile/component-materialization');
const {encodeComponentRuntime}=require('../compile/component-encoding');
const {compileComponentMaterial}=require('../compile/component-compiler');
const contexts=require('./creation-context');
const packageInfo=require('../../package.json');

function createComponentSession(options){
  hostRecord(options,['agent','adoptionInput','interpretReply','syntheticFixture'],['agent','adoptionInput','interpretReply']);
  // Callable Host values are checked separately from the strict JSON records.
  const runtime=getBoundRuntime();
  record(options.agent,['name','version']);text(options.agent.name);text(options.agent.version);
  hostRecord(options.adoptionInput,['kind','channel','authorization','receive'],['kind','channel','receive']);
  const channel={...options.adoptionInput};
  if(!channel || typeof channel.receive!=='function' || typeof options.interpretReply!=='function')fail('CREATION_ADOPTION_CHANNEL_REQUIRED');
  if(!['human_claim_unverified','delegated_agent_editorial'].includes(channel.kind))fail('CREATION_ADOPTION_KIND_UNSUPPORTED');
  text(channel.channel);
  if(channel.kind==='delegated_agent_editorial'){
    record(channel.authorization,['coordinate','statement']);text(channel.authorization.coordinate);text(channel.authorization.statement);
  } else if(own(channel,'authorization'))fail('CREATION_HUMAN_AUTHORIZATION_FIELD_FORBIDDEN');
  if(own(options,'syntheticFixture')&&typeof options.syntheticFixture!=='boolean')fail('CREATION_FIXTURE_INVALID');
  const agent=freeze(clone(options.agent)),interpretReply=options.interpretReply,syntheticFixture=options.syntheticFixture===true;
  if(own(channel,'authorization'))channel.authorization=freeze(clone(channel.authorization));Object.freeze(channel);
  const sessionId='session:'+crypto.randomUUID(),createdAt=new Date().toISOString();
  const asset={asset_id:'asset:'+crypto.randomUUID(),asset_uid:'urn:uuid:'+crypto.randomUUID()};
  let state={session_id:sessionId,revision:0,brief:null,materials:[],groups:[],choices:null,history:[]};
  let preview=null,token=null,busy=false,phase='draft';const seen=new Set(),saveOwner={};
  const append=(event,detail)=>{const e={sequence:state.history.length+1,revision:state.revision,event,at:new Date().toISOString(),detail:clone(detail),previous_digest:state.history.at(-1)?.digest||null};state.history.push({...e,digest:hash(e)});};
  const open=()=>{if(busy)fail('CREATION_SESSION_BUSY');if(phase!=='draft')fail('CREATION_SESSION_SEALED');};
  const invalidate=()=>{contexts.abandonContext(token);token=null;preview=null;};
  const evolve=(event,detail,fn)=>{invalidate();fn();state.revision++;append(event,detail);};
  function inspect(){return freeze(clone({...state,phase,preview:preview?.review||null,authority:{identity:'not_verified',creation:'not_evaluated',action:'not_evaluated'}}));}
  function setBrief(input){open();record(input,['title','scope']);text(input.title);text(input.scope);evolve('brief',input,()=>{state.brief=clone(input);state.choices=null;});return inspect();}
  function recordMaterial(input){
    open();record(input,['kind','title','content','coordinate']);if(!['text','interview'].includes(input.kind))fail('CREATION_MATERIAL_KIND_UNSUPPORTED');
    for(const k of ['title','content','coordinate'])text(input[k]);
    if(state.materials.some(m=>m.coordinate===input.coordinate))fail('CREATION_MATERIAL_COORDINATE_REUSED');
    const m={id:'material:'+crypto.randomUUID(),...clone(input),content_digest:'sha256:'+crypto.createHash('sha256').update(input.content,'utf8').digest('hex'),recorded_at:new Date().toISOString()};
    evolve('material',m,()=>{state.materials.push(m);state.choices=null;});return freeze(clone(m));
  }
  function propose(input){open();const g=group(input,state.materials);if(state.groups.some(x=>x.localKey===g.localKey))fail('CREATION_JUDGMENT_KEY_DUPLICATE');g.revision=1;evolve('proposal',g,()=>{state.groups.push(g);state.choices=null;});return freeze(clone(g));}
  function revise(key,input){
    open();record(input,['baseRevision','alternatives','explanation']);text(input.explanation);
    const index=state.groups.findIndex(g=>g.localKey===key);if(index<0)fail('CREATION_JUDGMENT_UNKNOWN');
    const prior=state.groups[index];if(input.baseRevision!==prior.revision)fail('CREATION_REVISION_BASE_STALE');
    const next={...group({localKey:key,alternatives:input.alternatives},state.materials),revision:prior.revision+1};
    evolve('revision',{prior,next,explanation:input.explanation},()=>{state.groups[index]=next;state.choices=null;});return freeze(clone(next));
  }
  function snapshot(){
    if(!state.brief||!state.materials.length||!state.groups.length||!state.choices)fail('CREATION_REVIEW_INCOMPLETE');
    return freeze(clone({session_id:sessionId,revision:state.revision,agent,asset:{...asset,version:'0.1.'+state.revision},createdAt,adoption_channel:{kind:channel.kind,channel:channel.channel},corePackageVersion:runtime.coreVersion,synthetic_fixture:syntheticFixture,brief:state.brief,materials:state.materials,groups:state.groups,history:state.history,authorization:channel.kind==='delegated_agent_editorial'?channel.authorization:null,selected:state.groups.map(g=>({judgmentLocalKey:g.localKey,alternative:g.alternatives.find(a=>a.localKey===state.choices[g.localKey])}))}));
  }
  function compilePreview(){
    open();invalidate();const s=snapshot();
    const plan=buildMaterialization(s,runtime.descriptor,{adoption_kind:channel.kind,phase:'preview-only'});
    const review={session_id:sessionId,revision:state.revision,kind:'pre_compiler_authoring_review',context_digest:hash(s),selected:clone(s.selected),expected_component_bindings:plan.expectedComponents,presence:plan.presence,proposal_digests:plan.proposalDigests,creation_accepted:'not_evaluated'};
    preview={snapshot:s,review:freeze({...review,preview_digest:hash(review)})};return preview.review;
  }
  async function receiveAdoptionReply(){
    open();busy=true;contexts.abandonContext(token);token=null;
    const review=freeze(clone({review_id:'review:'+crypto.randomUUID(),session_id:sessionId,revision:state.revision,kind:channel.kind,channel:channel.channel,groups:state.groups,preview:preview?.review||null}));
    try{
      const response=await channel.receive(review);if(phase!=='draft'||state.revision!==review.revision)fail('CREATION_SESSION_ABORTED');record(response,['id','role','channel','review_id','text']);text(response.id);text(response.text);
      if(response.role!==(channel.kind==='delegated_agent_editorial'?'agent':'human')||response.channel!==channel.channel||response.review_id!==review.review_id)fail('CREATION_REPLY_UNBOUND');
      if(seen.has(response.id))fail('CREATION_REPLY_REPLAY');seen.add(response.id);
      const intent=await interpretReply(response.text,review);if(phase!=='draft'||state.revision!==review.revision)fail('CREATION_SESSION_ABORTED');record(intent,['kind','choices'],['kind']);
      if(!['select','confirm','note','reject'].includes(intent.kind))fail('CREATION_INTENT_INVALID');
      const entry={response:clone(response),interpretation:clone(intent),review:clone(review),interpreted_by:agent,identity:'not_verified'};
      if(intent.kind==='select'){
        if(!Array.isArray(intent.choices)||intent.choices.length!==state.groups.length)fail('CREATION_SELECTION_INCOMPLETE');
        const choices={};for(const c of intent.choices){record(c,['judgmentLocalKey','alternativeLocalKey']);const g=state.groups.find(g=>g.localKey===c.judgmentLocalKey);if(!g||own(choices,c.judgmentLocalKey)||!g.alternatives.some(a=>a.localKey===c.alternativeLocalKey))fail('CREATION_SELECTION_INVALID');choices[c.judgmentLocalKey]=c.alternativeLocalKey;}
        evolve('selection',entry,()=>{state.choices=choices;});
      }else if(intent.kind==='confirm'){
        if(own(intent,'choices')||!preview||preview.snapshot.revision!==state.revision)fail('CREATION_FINAL_UNBOUND');
        const decision={format:'kdna.studio-decision/2',adoption_kind:channel.kind,session_id:sessionId,revision:state.revision,context_digest:hash(preview.snapshot),preview_digest:preview.review.preview_digest,proposal_digests:preview.review.proposal_digests,actual_reply:entry,authorization:channel.kind==='delegated_agent_editorial'?clone(channel.authorization):null};
        append('final_adoption',decision);token=contexts.issueContext(preview.snapshot,decision,runtime.descriptor);phase='confirmed';
      }else{
        if(own(intent,'choices'))fail('CREATION_INTENT_INVALID');evolve(intent.kind,entry,()=>{if(intent.kind==='reject')state.choices=null;});
      }
      return inspect();
    }catch(e){invalidate();append('reply_rejected',{code:typeof e.code==='string'?e.code:'CREATION_CHANNEL_FAILURE'});throw e;}
    finally{busy=false;}
  }
  function exportAsset(){
    if(busy)fail('CREATION_SESSION_BUSY');if(phase!=='confirmed'||!token||!preview)fail('CREATION_FINAL_REQUIRED');
    const stored=contexts.consumeContext(token,preview.snapshot);token=null;phase='compiling';
    try{
      const expected=buildMaterialization(stored.snapshot,stored.descriptor,stored.decision);
      const expectedBytes=encodeComponentRuntime(expected); // Before invoking Compiler, captured externally.
      if(runtime.admitBytes(expectedBytes).status!=='accepted')fail('CREATION_EXPECTED_CORE_REJECTED');
      const actualBytes=compileComponentMaterial(clone({manifest:expected.manifest,payload:expected.payload}));
      if(!Buffer.from(actualBytes).equals(expectedBytes))fail('CREATION_COMPILER_EXPECTATION_MISMATCH');
      const evidence=freeze({format:{id:'kdna.studio-creation-evidence/2',version:'2.0.0'},reference_contract:runtime.tuple,component_definition:runtime.descriptor.definition_digest,compiler:{name:packageInfo.name,version:packageInfo.version,provider:'javascript',artifact_sha256:'UNKNOWN'},session_id:sessionId,revision:state.revision,context:stored.snapshot,decision:stored.decision,history:clone(state.history),expected_component_bindings:expected.expectedComponents,presence:expected.presence,adoption:expected.adoption,artifact:{bytes:actualBytes.length,digest:'sha256:'+crypto.createHash('sha256').update(actualBytes).digest('hex')},identity:'not_verified',action_authorization:'not_evaluated',creation_accepted:'not_evaluated'});
      contexts.prepareSave(saveOwner,expected,expectedBytes,evidence);phase='awaiting_saved_readback';
      return Object.freeze({bytes:Buffer.from(actualBytes),evidence,binding:freeze({session_id:sessionId,asset_digest:evidence.artifact.digest,evidence_digest:hash(evidence)}),verification:freeze({status:'pending_saved_readback',creation_accepted:'not_evaluated'})});
    }catch(e){phase='failed';throw e;}
  }
  function completeSave(bytes){if(busy||phase!=='awaiting_saved_readback')fail('CREATION_SAVE_STATE_INVALID');phase='sealed';try{return contexts.completeSave(saveOwner,bytes,runtime.admitBytes);}catch(e){phase='failed';throw e;}}
  function abort(){invalidate();contexts.abandonSave(saveOwner);phase='aborted';return inspect();}
  return Object.freeze({agent:Object.freeze({setBrief,recordMaterial,propose,revise,compilePreview}),receiveAdoptionReply,exportAsset,completeSave,inspect,abort});
}
module.exports={createComponentSession};
