'use strict';

const crypto=require('node:crypto');
const {hash,clone,freeze,fail}=require('./component-input');
const tokens=new WeakMap(),pendingSaves=new WeakMap();

// Module-private capabilities never serialize into evidence or Runtime.
function issueContext(snapshot,decision,descriptor) {
  const token=Object.freeze({});
  tokens.set(token,freeze({snapshot:clone(snapshot),decision:clone(decision),descriptor:clone(descriptor),nonce:crypto.randomUUID()}));
  return token;
}
function consumeContext(token,currentSnapshot) {
  const stored=tokens.get(token);tokens.delete(token); // Burn on every admission attempt.
  if(!stored || hash(stored.snapshot)!==hash(currentSnapshot))fail('CREATION_CONTEXT_REPLAY_OR_STALE');
  return stored;
}
function abandonContext(token){tokens.delete(token);}
function abandonSave(owner){pendingSaves.delete(owner);}
function prepareSave(owner,expected,expectedBytes,evidence) {
  if(pendingSaves.has(owner))fail('CREATION_SAVE_ALREADY_PENDING');
  // expectedBytes must be built before Compiler returns, never supplied by it.
  pendingSaves.set(owner,{expected:freeze(clone(expected)),bytes:Buffer.from(expectedBytes),evidence:freeze(clone(evidence))});
}
function completeSave(owner,actualBytes,admitBytes) {
  const pending=pendingSaves.get(owner);pendingSaves.delete(owner); // Failed save checks also cannot replay.
  if(!pending)fail('CREATION_SAVE_CONTEXT_MISSING');
  if(!(actualBytes instanceof Uint8Array))fail('CREATION_SAVED_BYTES_INVALID');
  const captured=Buffer.from(actualBytes),admission=admitBytes(captured);
  if(admission.status!=='accepted')fail('CREATION_SAVED_CORE_REJECTED');
  if(!captured.equals(pending.bytes))fail('CREATION_SAVED_EXPECTATION_MISMATCH');
  const snapshot=admission.snapshot,asset=pending.expected.payload.asset;
  if(hash(snapshot.asset)!==hash(asset))fail('CREATION_SAVED_ASSET_MISMATCH');
  const methodNodes=snapshot.ir.nodes.filter(n=>n.role==='method');
  const expectedJudgments=pending.expected.payload.judgments;
  const observedJudgments=snapshot.ir.nodes.filter(n=>n.role==='judgment').map(n=>n.value);
  const sort=a=>[...a].sort((x,y)=>Buffer.compare(Buffer.from(x.id),Buffer.from(y.id)));
  if(hash(sort(observedJudgments))!==hash(sort(expectedJudgments)))fail('CREATION_SAVED_JUDGMENT_MISMATCH');
  for(const j of expectedJudgments) {
    const nodes=methodNodes.filter(n=>n.owner_judgment_id===j.id);
    if(!Object.hasOwn(j,'method')) {if(nodes.length)fail('CREATION_METHOD_INVENTED');continue;}
    if(nodes.length!==1 || hash(nodes[0].value.declaration)!==hash(j.method))fail('CREATION_METHOD_CHANGED');
    const expectedPresence=pending.expected.presence.find(p=>p.judgment_ref===j.id);
    const state=expectedPresence?{components_state:expectedPresence.components_state,bindings_state:expectedPresence.bindings_state}:{components_state:'declared',bindings_state:'declared'};
    if(hash(nodes[0].value.declaration_presence)!==hash(state))fail('CREATION_PRESENCE_CHANGED');
    const expected=pending.expected.expectedComponents.filter(c=>c.carrier.judgment_ref===j.id);
    const observed=nodes[0].value.component_interpretations;
    if(observed.length!==expected.length)fail('CREATION_COMPONENT_SET_CHANGED');
    for(const e of expected) {
      const a=observed.find(c=>c.component_ref===e.carrier.component_ref);
      if(!a || a.status!=='supported' || hash(a.authored_content)!==hash(e.carrier.content))fail('CREATION_COMPONENT_CHANGED');
      for(const k of ['judgment_ref','component_type','definition_digest','profile_id','content_digest','component_declaration_digest','statement_origin','bindings_digest','adoption_proposal_digest'])if(a[k]!==e.carrier[k])fail('CREATION_COMPONENT_BINDING_CHANGED');
      if(a.declaration_digest!==hash(e.carrier))fail('CREATION_COMPONENT_DECLARATION_CHANGED');
    }
  }
  return freeze({status:'accepted_with_live_context',scope:'captured saved bytes equal external pre-compiler expectation and fresh public Core observations',asset_digest:snapshot.digests.A.observed,evidence_digest:hash(pending.evidence),adoption_kind:pending.expected.decision.adoption_kind,identity:'not_verified',action_authorization:'not_evaluated',filesystem_durability:'not_proven_by_library'});
}
module.exports={issueContext,consumeContext,abandonContext,abandonSave,prepareSave,completeSave};
