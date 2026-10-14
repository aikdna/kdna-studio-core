"use strict";
// The declared system layer: materialization into shared declarations and
// relationships, the named refusals around it, timing independence and
// deterministic ids. The suite's own lifecycle tests keep the old, undeclared
// inputs byte-identical; this file proves the declared face end to end through
// the real public API, Core admission and the public read surface.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const api=require('..'),core=require('@aikdna/kdna-core');
const {readBrowser}=require('@aikdna/kdna-read/browser');
const {createTrustedReadControlProvider,createTrustedHostReadProvider}=require('@aikdna/kdna-read/embedding');
const {buildMaterialization}=require('../src/compile/component-materialization');
const descriptor=require('@aikdna/kdna-core/components').getComponentSemanticsContract();
const artifactRoot=path.resolve(process.env.STUDIO_TEST_ARTIFACT_ROOT||path.join(__dirname,'.artifacts',String(process.pid)));
fs.mkdirSync(artifactRoot,{recursive:true});
let serial=0;const clone=x=>JSON.parse(JSON.stringify(x));
const feelingMethod={method:{term:'feeling'},components:[{localKey:'basis',type:'taxonomy',method:{term:'feeling'},role:'个人感受',statement:'The authored preference rests on an actual felt priority.',content:{items:[{key:'care',title:'Felt priority',meaning:'The authored statement rests on an actual felt priority.'}],broader:[]}}]};
function twoGroups(){
  const a=(key,statement)=>({localKey:key,title:'Candidate '+key,subject:'A synthetic observation',scope:'Only the declared scope',statement,rationale:'Stated basis for the synthetic candidate.',materialRefs:[],method:clone(feelingMethod)});
  return {
    'system-a':{preserve:a('a-preserve','Retain unknown when evidence is absent.'),alt:a('a-infer','Treat absence as a negative result.')},
    'system-b':{preserve:a('b-preserve','Keep the existing boundary until the author decides.'),alt:a('b-infer','Move the boundary to the new case immediately.')},
  };
}
function fixture({declare,kind='delegated_agent_editorial',declareBeforeProposal=false}={}){
  const id=++serial;let turn=0,next='select';const channel='synthetic-provider:'+id;
  const groups=twoGroups();
  const options={agent:{name:'Synthetic system fixture',version:'1'},syntheticFixture:true,
    adoptionInput:{kind,channel,...(kind==='delegated_agent_editorial'?{authorization:{coordinate:'fixture:local-only',statement:'Authorized synthetic implementation testing, no real editorial adoption.'}}:{}),
      receive:async review=>({id:'response:'+id+':'+(++turn),role:kind==='delegated_agent_editorial'?'agent':'human',channel,review_id:review.review_id,text:next})},
    interpretReply:async text=>text==='select'
      ?{kind:'select',choices:[{judgmentLocalKey:'system-a',alternativeLocalKey:'a-preserve'},{judgmentLocalKey:'system-b',alternativeLocalKey:'b-preserve'}]}
      :{kind:text}};
  const s=api.createSession(options);
  s.agent.setBrief({title:'Synthetic system fixture',scope:'Local test of the declared system layer.',highest_question:'Which choice carries the author\'s actual ordering?'});
  const m=s.agent.recordMaterial({kind:'text',title:'Private input',content:'PRIVATE_MATERIAL_NEVER_RUNTIME_'+id,coordinate:'private:system:'+id});
  const propose=(k)=>{const g=groups[k];for(const a of Object.values(g))a.materialRefs=[m.id];s.agent.propose({localKey:k,alternatives:[g.preserve,g.alt]});};
  if(declareBeforeProposal)declare(s);
  propose('system-a');propose('system-b');
  if(!declareBeforeProposal)declare(s);
  return {id,s,groups,async ready(){next='select';await s.receiveAdoptionReply();s.agent.compilePreview();next='confirm';await s.receiveAdoptionReply();const out=s.exportAsset();const file=path.join(artifactRoot,'system-'+id+'.kdna');fs.writeFileSync(file,out.bytes,{flag:'wx'});const completed=s.completeSave(fs.readFileSync(file));assert.equal(completed.status,'accepted_with_live_context');assert.equal(api.verifyCreationEvidence(out.bytes,out.evidence,out.binding).status,'consistent');return file;}};
}
const standardDeclaration=()=>({worldview:{statement:'How this synthetically authored work reads a case.',items:['Practice before novelty.']},
  value_order:{statement:'Ordering used when two synthetic judgments disagree.',items:['Boundary first.','Then the newest observation.']},
  relations:[{localKey:'rel-supports',kind:'support',from:'system-b',to:'system-a',statement:'The boundary judgment backs the earlier choice.'},
    {localKey:'rel-conflicts',kind:'conflict',from:'system-a',to:'system-b',statement:'The two selected judgments disagree in the synthetic case.'}],
  });
async function readSelection(file){
  const admission=core.admitBytes(fs.readFileSync(file));assert.equal(admission.status,'accepted');
  const snapshot=admission.snapshot;
  const control=createTrustedReadControlProvider(()=>({admission_response_limit_bytes:262144}));
  const host=createTrustedHostReadProvider({observe:({request,snapshot})=>({host_id:'synthetic-local-host',host_epoch:'fixture-epoch',decision_id:'fixture-decision',request_id:request.request_id,snapshot_id:snapshot.snapshot_id,A:snapshot.digests.A.observed,C:snapshot.digests.C.observed,scope:snapshot.ir.nodes.map(n=>n.id),issued_at:1000,expires_at:10000,current_ms:1001,decision:'allow',policy_id:'synthetic-read-only'})});
  return readBrowser(snapshot,{request_id:'fixture-read',tuple:snapshot.tuple,budget_bytes:1048576,mode:'exact_selection',selection:{asset_id:snapshot.asset.asset_id,asset_version:snapshot.asset.asset_version,judgment_id:snapshot.ir.catalog[0].judgment_id},handle:null},control,host);
}
test('a declared system layer materializes into shared declarations and relationships',async()=>{
  const f=fixture({declare:s=>s.agent.declareSystem(standardDeclaration())});
  const file=await f.ready();
  const read=await readSelection(file);
  assert.equal(read.channel,'read_envelope');assert.equal(read.envelope.status,'ready');
  const content=read.envelope.content;
  const shared=content.closure.filter(entry=>entry.role==='shared_declaration').map(entry=>({kind:entry.value.kind,value:entry.value.value,subject:entry.value.subject,applies_to:entry.value.applies_to}));
  assert.deepEqual(shared.map(s=>s.kind).sort(),['value_order','worldview']);
  const valueOrder=shared.find(s=>s.kind==='value_order');
  assert.deepEqual(valueOrder.value,['Boundary first.','Then the newest observation.']);
  assert.deepEqual(valueOrder.subject.actor_ids,[]);
  assert.equal(valueOrder.applies_to.kind,'asset');
  const relations=(content.relationships??[]).map(r=>({kind:r.kind.term,operator:r.operator?.term,effect:r.effect?.term,direction:r.direction,roles:r.participants.map(p=>p.role.term)}));
  assert.deepEqual(relations.sort((a,b)=>a.kind<b.kind?-1:1),[
    {kind:'conflict',operator:'conflicts_with',effect:'preserves_disagreement',direction:'undirected',roles:['side_a','side_b']},
    {kind:'support',operator:'supports',effect:'offers_support',direction:'directed',roles:['supporter','claim']},
  ]);
  const support=(content.relationships??[]).find(r=>r.kind.term==='support');
  assert.notEqual(support.participants[0].judgment_ref,support.participants[1].judgment_ref);
  // The private material never reaches the runtime payload.
  assert.equal(fs.readFileSync(file).includes(Buffer.from('PRIVATE_MATERIAL_NEVER_RUNTIME_'+f.id)),false);
});
test('declaring before or after the proposals resolves to the same modeled system',async()=>{
  const before=await fixture({declare:s=>s.agent.declareSystem(standardDeclaration()),declareBeforeProposal:true}).ready();
  const after=await fixture({declare:s=>s.agent.declareSystem(standardDeclaration())}).ready();
  const shape=async file=>{
    const content=(await readSelection(file)).envelope.content;
    return {shared:content.closure.filter(entry=>entry.role==='shared_declaration').map(entry=>({kind:entry.value.kind,value:entry.value.value})).sort((a,b)=>a.kind<b.kind?-1:1),
      relations:(content.relationships??[]).map(r=>({kind:r.kind.term,roles:r.participants.map(p=>p.role.term),statement:r.statement})).sort((a,b)=>a.kind<b.kind?-1:1)};
  };
  assert.deepEqual(await shape(before),await shape(after));
});
test('unknown keys resolve to a named refusal at compile, never a silent drop',async()=>{
  const f=fixture({declare:s=>s.agent.declareSystem({relations:[{localKey:'rel-unknown',kind:'support',from:'no-such-key',to:'system-a',statement:'References a judgment that does not exist.'}]})});
  await f.s.receiveAdoptionReply(); // select
  assert.throws(()=>f.s.agent.compilePreview(),{code:'CREATION_SYSTEM_JUDGMENT_UNKNOWN'});
});
test('a proposed-but-unselected judgment reference is a named mapping refusal',async()=>{
  // The session and the audit both refuse a partial selection by name
  // (CREATION_SELECTION_INCOMPLETE), and the audit additionally hash-pins the
  // stored selected set against the replayed choices, so no session-derived
  // snapshot can omit a proposed group. The documented code is therefore the
  // mapping's own boundary: handed a snapshot whose selected set omits a
  // proposed group, it refuses the relation by name, never silently drops it.
  const groups=twoGroups();
  const snapshot={asset:{asset_id:'asset:fixed',asset_uid:'uid:fixed',version:'0.1.2'},createdAt:'2026-10-15T00:00:00.000Z',corePackageVersion:'0.37.2',synthetic_fixture:true,
    brief:{title:'Unselected',scope:'Scope.',highest_question:'Question?'},materials:[],
    groups:[{localKey:'system-a',alternatives:[groups['system-a'].preserve,groups['system-a'].alt]},{localKey:'system-b',alternatives:[groups['system-b'].preserve,groups['system-b'].alt]}],
    history:[],authorization:{coordinate:'fixture:local-only',statement:'Authorized synthetic implementation testing, no real editorial adoption.'},
    selected:[{judgmentLocalKey:'system-a',alternative:groups['system-a'].preserve}],
    system:{relations:[{localKey:'rel-unselected',kind:'support',from:'system-b',to:'system-a',statement:'References a proposed judgment outside the selection.'}]}};
  assert.throws(()=>buildMaterialization(snapshot,descriptor,{adoption_kind:'delegated_agent_editorial',phase:'preview-only'}),{code:'CREATION_SYSTEM_JUDGMENT_UNSELECTED'});
  // And the session boundary that keeps that snapshot out of reach: with the
  // same relation declared, a select intent that omits a proposed group is
  // refused before any preview is built.
  let turn=0;
  const s=api.createSession({agent:{name:'Synthetic partial-selection fixture',version:'1'},syntheticFixture:true,
    adoptionInput:{kind:'delegated_agent_editorial',channel:'synthetic-provider:partial',authorization:{coordinate:'fixture:local-only',statement:'Authorized synthetic implementation testing, no real editorial adoption.'},receive:async review=>({id:'response:partial:'+(++turn),role:'agent',channel:'synthetic-provider:partial',review_id:review.review_id,text:'select'})},
    interpretReply:async()=>({kind:'select',choices:[{judgmentLocalKey:'system-a',alternativeLocalKey:'a-preserve'}]})});
  s.agent.setBrief({title:'Partial',scope:'Partial scope.',highest_question:'Partial question?'});
  const m=s.agent.recordMaterial({kind:'text',title:'Private input',content:'PRIVATE_PARTIAL_SELECTION_'+serial,coordinate:'private:partial:'+(++serial)});
  for(const key of ['system-a','system-b']){const g=groups[key];for(const a of Object.values(g))a.materialRefs=[m.id];s.agent.propose({localKey:key,alternatives:[g.preserve,g.alt]});}
  s.agent.declareSystem(standardDeclaration());
  await assert.rejects(()=>s.receiveAdoptionReply(),{code:'CREATION_SELECTION_INCOMPLETE'});
});
test('system declaration grammar refuses boundaries, empties and unknown kinds by name',async()=>{
  const {createSession}=api;
  const make=()=>createSession({agent:{name:'Synthetic grammar fixture',version:'1'},syntheticFixture:true,
    adoptionInput:{kind:'delegated_agent_editorial',channel:'synthetic-provider:grammar',authorization:{coordinate:'fixture:local-only',statement:'Authorized synthetic implementation testing, no real editorial adoption.'},receive:async()=>({})},
    interpretReply:async()=>({kind:'note'})});
  const opener=()=>{const s=make();s.agent.setBrief({title:'Grammar',scope:'Grammar scope.',highest_question:'Grammar question?'});return s;};
  let s=opener();
  assert.throws(()=>s.agent.declareSystem({boundaries:[{statement:'x'}]}),error=>error.code==='CREATION_BOUNDARIES_ACTOR_REQUIRED'&&/identity-model unit/u.test(error.detail));
  assert.throws(()=>s.agent.declareSystem({}),{code:'CREATION_SYSTEM_EMPTY'});
  assert.throws(()=>s.agent.declareSystem({worldview:{statement:'x',items:[]}}),{code:'CREATION_SYSTEM_LIST_EMPTY'});
  assert.throws(()=>s.agent.declareSystem({relations:[{localKey:'r',kind:'supports',from:'system-a',to:'system-b',statement:'x'}]}),{code:'CREATION_SYSTEM_RELATION_KIND_UNSUPPORTED'});
  assert.throws(()=>s.agent.declareSystem({worldview:{statement:'x'}}),{code:'COMPONENT_INPUT_INVALID'});
  assert.throws(()=>s.agent.declareSystem({extra:true}),{code:'COMPONENT_INPUT_INVALID'});
  // A refused declaration leaves the session in its previous state.
  assert.equal(Object.hasOwn(s.inspect(),'system'),false);
});
test('the declared system layer is deterministic and its ids stay collision-free',()=>{
  const groups=twoGroups();
  const snapshot=declare=>({asset:{asset_id:'asset:fixed',asset_uid:'uid:fixed',version:'0.1.2'},createdAt:'2026-10-15T00:00:00.000Z',corePackageVersion:'0.37.2',synthetic_fixture:true,
    brief:{title:'Determinism',scope:'Scope.',highest_question:'Question?'},materials:[],
    groups:[{localKey:'system-a',alternatives:[groups['system-a'].preserve,groups['system-a'].alt]},{localKey:'system-b',alternatives:[groups['system-b'].preserve,groups['system-b'].alt]}],
    history:[],authorization:{coordinate:'fixture:local-only',statement:'Authorized synthetic implementation testing, no real editorial adoption.'},
    selected:[{judgmentLocalKey:'system-a',alternative:groups['system-a'].preserve},{judgmentLocalKey:'system-b',alternative:groups['system-b'].preserve}],
    ...(declare?{system:declare}:{})});
  const decision={adoption_kind:'delegated_agent_editorial',phase:'preview-only'};
  const first=buildMaterialization(snapshot(standardDeclaration()),descriptor,decision);
  const second=buildMaterialization(snapshot(clone(standardDeclaration())),descriptor,decision);
  assert.equal(JSON.stringify(first.payload),JSON.stringify(second.payload));
  const without=buildMaterialization(snapshot(null),descriptor,decision);
  assert.deepEqual(without.payload.shared_declarations,[]);
  assert.deepEqual(without.payload.relationships,[]);
  assert.deepEqual(without.payload.declarations.boundaries,{state:'none',value:null});
  const ids=new Set(first.generated_ids);
  assert.equal(ids.size,first.generated_ids.length);
  for(const id of first.payload.shared_declarations.map(s=>s.id).concat(first.payload.relationships.map(r=>r.id)))assert.ok(ids.has(id));
});
test('reject and abort paths stay complete around a declared system layer',async()=>{
  let mode='reject';let turn=0;
  const s=api.createSession({agent:{name:'Synthetic lifecycle fixture',version:'1'},syntheticFixture:true,
    adoptionInput:{kind:'delegated_agent_editorial',channel:'synthetic-provider:reject',authorization:{coordinate:'fixture:local-only',statement:'Authorized synthetic implementation testing, no real editorial adoption.'},receive:async review=>({id:'response:reject:'+(++turn),role:'agent',channel:'synthetic-provider:reject',review_id:review.review_id,text:mode})},
    interpretReply:async text=>text==='select'?{kind:'select',choices:[{judgmentLocalKey:'system-a',alternativeLocalKey:'a-preserve'},{judgmentLocalKey:'system-b',alternativeLocalKey:'b-preserve'}]}:{kind:text}});
  s.agent.setBrief({title:'Lifecycle',scope:'Lifecycle scope.',highest_question:'Lifecycle question?'});
  const m=s.agent.recordMaterial({kind:'text',title:'Private input',content:'PRIVATE_LIFECYCLE_'+serial,coordinate:'private:lifecycle:'+(++serial)});
  const groups=twoGroups();
  for(const key of ['system-a','system-b']){const g=groups[key];for(const a of Object.values(g))a.materialRefs=[m.id];s.agent.propose({localKey:key,alternatives:[g.preserve,g.alt]});}
  s.agent.declareSystem(standardDeclaration());
  await s.receiveAdoptionReply();
  await s.receiveAdoptionReply();
  assert.throws(()=>s.exportAsset(),{code:'CREATION_FINAL_REQUIRED'});
  mode='select';await s.receiveAdoptionReply();
  s.agent.compilePreview();mode='confirm';await s.receiveAdoptionReply();
  const out=s.exportAsset();
  const file=path.join(artifactRoot,'system-reject-'+serial+'.kdna');
  fs.writeFileSync(file,out.bytes,{flag:'wx'});
  assert.equal(s.completeSave(fs.readFileSync(file)).status,'accepted_with_live_context');
  assert.equal(api.verifyCreationEvidence(out.bytes,out.evidence,out.binding).status,'consistent');
  const other=api.createSession({agent:{name:'Synthetic abort fixture',version:'1'},syntheticFixture:true,
    adoptionInput:{kind:'delegated_agent_editorial',channel:'synthetic-provider:abort',authorization:{coordinate:'fixture:local-only',statement:'Authorized synthetic implementation testing, no real editorial adoption.'},receive:async()=>({})},
    interpretReply:async()=>({kind:'note'})});
  other.agent.setBrief({title:'Abort',scope:'Abort scope.',highest_question:'Abort question?'});
  other.agent.declareSystem(standardDeclaration());
  assert.equal(other.abort().phase,'aborted');
});
