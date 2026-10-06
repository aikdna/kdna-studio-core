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
  // R2 IR vocabulary: one `method_component` node per declared component whose
  // value is the decoded native component. The judgment-level hash above already
  // binds the whole method declaration; these nodes additionally bind each
  // component observation to the plan's expected native component.
  const methodComponentNodes=snapshot.ir.nodes.filter(n=>n.role==='method_component');
  const expectedJudgments=pending.expected.payload.judgments;
  const observedJudgments=snapshot.ir.nodes.filter(n=>n.role==='judgment').map(n=>n.value);
  const sort=a=>[...a].sort((x,y)=>Buffer.compare(Buffer.from(x.id),Buffer.from(y.id)));
  if(hash(sort(observedJudgments))!==hash(sort(expectedJudgments)))fail('CREATION_SAVED_JUDGMENT_MISMATCH');
  for(const j of expectedJudgments) {
    const nodes=methodComponentNodes.filter(n=>n.owner_judgment_id===j.id);
    if(!Object.hasOwn(j,'method')) {if(nodes.length)fail('CREATION_METHOD_INVENTED');continue;}
    const expected=pending.expected.expectedComponents.filter(c=>c.carrier.judgment_ref===j.id);
    if(nodes.length!==expected.length)fail('CREATION_COMPONENT_SET_CHANGED');
    for(const e of expected) {
      const a=nodes.find(n=>n.value.id===e.native_component.id);
      if(!a || hash(a.value)!==hash(e.native_component))fail('CREATION_COMPONENT_CHANGED');
    }
  }
  return freeze({status:'accepted_with_live_context',scope:'captured saved bytes equal external pre-compiler expectation and fresh public Core observations',asset_digest:snapshot.digests.A.observed,evidence_digest:hash(pending.evidence),adoption_kind:pending.expected.decision.adoption_kind,identity:'not_verified',action_authorization:'not_evaluated',filesystem_durability:'not_proven_by_library'});
}
module.exports={issueContext,consumeContext,abandonContext,abandonSave,prepareSave,completeSave};
