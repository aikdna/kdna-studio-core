'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {verifyCreationEvidence}=require('../../src');
const {digest}=require('../../src/evidence/blank-material');
const {canonicalStringify,contract}=require('../../src/evidence/provider-contract');
const fixtures=path.join(__dirname,'../../fixtures/cross-provider');
function input(name){const dir=path.join(fixtures,name);return {bytes:fs.readFileSync(path.join(dir,'artifact.kdna')),evidence:JSON.parse(fs.readFileSync(path.join(dir,'evidence.json'))),binding:JSON.parse(fs.readFileSync(path.join(dir,'binding.json')))};}
function verifyChanged(f,mutate,rebind=true){const evidence=structuredClone(f.evidence);mutate(evidence);const binding=rebind?{...f.binding,evidence_digest:digest(evidence)}:f.binding;return verifyCreationEvidence(f.bytes,evidence,binding);}
const current=input('javascript'),legacy=input('legacy');
test('actual format 1 producer and original 3.0 RC producer both verify with their exact private binding',()=>{
 const a=verifyCreationEvidence(current.bytes,current.evidence,current.binding),b=verifyCreationEvidence(legacy.bytes,legacy.evidence,legacy.binding);
 assert.equal(a.status,'consistent');assert.equal(a.evidence_format,contract.format);assert.equal(a.implementation_artifact_sha256,contract.implementations.javascript.artifact.sha256);
 assert.equal(b.status,'consistent');assert.equal(b.evidence_format,'studio-blank-material-evidence/legacy');
 for(const result of [a,b]){assert.equal(result.provider_assertion,'declared_not_authenticated');assert.equal(result.compiler_artifact_sha256,'UNKNOWN');assert.equal(result.confirmation,'claimed_unverified');assert.equal(result.identity,'not_verified');assert.equal(result.creation_accepted,'not_evaluated');}
 assert.equal(b.implementation_artifact_sha256,'UNKNOWN');assert.equal(b.reference_contract,'UNKNOWN');assert.equal(Object.hasOwn(legacy.evidence,'format'),false);
});
test('unsupported format, unknown provider, mismatched compiler, reference and mixed legacy declarations fail closed',()=>{
 const cases=[
  [e=>e.format='kdna.studio-creation-evidence/2','CREATION_EVIDENCE_FORMAT_UNSUPPORTED'],
  [e=>e.core.implementation.provider='unknown','CREATION_PROVIDER_DECLARATION_UNSUPPORTED'],
  [e=>e.compiler.provider='swift','CREATION_PROVIDER_DECLARATION_UNSUPPORTED'],
  [e=>e.core.implementation.artifact.sha256='0'.repeat(64),'CREATION_PROVIDER_DECLARATION_UNSUPPORTED'],
  [e=>e.core.reference_contract.core.artifact_sha256='02b766c244d67d4ed36d8304b26cd1be784010c75bbe6a83b0938b049f548a63','CREATION_CORE_CONTRACT_UNSUPPORTED'],
  [e=>e.core.reference_contract.tuple.read='kdna.read/0.2.0','CREATION_CORE_CONTRACT_UNSUPPORTED'],
  [e=>e.core.package='@aikdna/kdna-core','CREATION_EVIDENCE_FORMAT_AMBIGUOUS'],
  [e=>{e.core={package:'@aikdna/kdna-core',version:'0.23.0',status:'valid',digests:e.core.digests}},'CREATION_EVIDENCE_FORMAT_AMBIGUOUS'],
  [e=>e.extra=true,'CREATION_EVIDENCE_MALFORMED'],
  [e=>e.compiler.extra=true,'CREATION_EVIDENCE_MALFORMED'],
 ];for(const [mutate,reason] of cases)assert.equal(verifyChanged(current,mutate).reason,reason);
 for(const mutate of [e=>e.core.implementation=contract.implementations.javascript,e=>e.compiler.provider='javascript'])assert.equal(verifyChanged(legacy,mutate).reason,'CREATION_EVIDENCE_FORMAT_AMBIGUOUS');
});
test('ordinary supported declaration tampering fails original binding; complete reassertion cannot authenticate execution',()=>{
 assert.equal(verifyChanged(current,e=>e.core.implementation.artifact.sha256='0'.repeat(64),false).reason,'CREATION_BINDING_MISMATCH');
 const result=verifyChanged(current,e=>{e.core.implementation=structuredClone(contract.implementations.swift);e.compiler={name:'KDNAStudioCore',version:'0.5.0-rc.public-creation.1',provider:'swift',artifact_sha256:'UNKNOWN'};let previous=null;for(const entry of e.history){if(entry.event==='compiler_preview')entry.detail.compiler=structuredClone(e.compiler);entry.previous_digest=previous;delete entry.digest;entry.digest=digest(entry);previous=entry.digest;}});
 assert.equal(result.status,'consistent');assert.equal(result.provider_assertion,'declared_not_authenticated');
});
test('compiler declaration must be identical in every preview, including when an attacker recomputes binding',()=>{
 assert.equal(verifyChanged(current,e=>e.history.find(x=>x.event==='compiler_preview').detail.compiler.version='other').reason,'CREATION_PROVIDER_DECLARATION_UNSUPPORTED');
});
test('material, history, review and final checks remain active with a recomputed external binding',()=>{
 for(const [mutate,reason] of [
  [e=>e.materials[0].content+='tamper','MATERIAL_DIGEST_MISMATCH'],
  [e=>e.candidates[0].material_refs=['missing'],'CREATION_REVIEW_INCOMPLETE'],
  [e=>e.history[0].previous_digest='forged','CREATION_AUDIT_CHAIN_MISMATCH'],
  [e=>e.final_decision.text+='tamper','FINAL_DECISION_UNBOUND'],
  [e=>e.confirmation='verified','AUTHORITY_CLAIM_UNSUPPORTED'],
 ])assert.equal(verifyChanged(current,mutate).reason,reason);
});
test('format 1 numeric rules cover every numeric value and required revisions without coercion',()=>{
 for(const mutate of [e=>e.revision=-1,e=>e.artifact.bytes='123',e=>e.final_decision.revision=2**53,e=>e.candidates[0].revision=1.5,e=>delete e.human_messages[0].review.revision,e=>e.history[0].detail.unrelatedNumber=1.5,e=>e.history.find(x=>x.event==='candidate_revised').detail.previous.revision='1'])assert.equal(verifyChanged(current,mutate).reason,'CREATION_EVIDENCE_MALFORMED');
});
test('legacy retains original missing-Core reason, decimal values, depth and digest meaning',()=>{
 assert.equal(verifyChanged(legacy,e=>delete e.core).reason,'CREATION_CORE_EVIDENCE_MISMATCH');
 const result=verifyChanged(legacy,e=>{e.historical_extra={number:1.5,nested:null};let x=e.historical_extra;for(let i=0;i<70;i++){x.next={};x=x.next;}});assert.equal(result.status,'consistent');assert.equal(result.implementation_artifact_sha256,'UNKNOWN');
});
test('format 1 rejects getters without invocation and rejects non-JSON or malformed Unicode input',()=>{
 let calls=0;const evidence=structuredClone(current.evidence);Object.defineProperty(evidence,'agent',{enumerable:true,get(){calls++;return {};}});assert.equal(verifyCreationEvidence(current.bytes,evidence,current.binding).reason,'CREATION_EVIDENCE_MALFORMED');assert.equal(calls,0);
 for(const v of [NaN,Infinity,undefined,1n,Symbol('x'),()=>0,new Date(),new Map(),['hole',,],{'bad\ud800':'x'},'bad\udfff'])assert.throws(()=>canonicalStringify(v));
 const cyclic={};cyclic.self=cyclic;assert.throws(()=>canonicalStringify(cyclic));
});
test('private format encoder has exact UTF-16 key order, distinct normalization and ECMAScript finite-number bytes',()=>{
 const vectors=JSON.parse(fs.readFileSync(path.join(fixtures,'canonical-vectors.json')));
 for(const v of vectors.vectors ?? vectors){const encoded=canonicalStringify(v.input);assert.equal(encoded,v.canonical);assert.equal(Buffer.from(encoded).toString('hex'),v.utf8_hex);assert.equal(crypto.createHash('sha256').update(encoded).digest('hex'),v.sha256);}
});
test('private format encoder uses only declared depth and total-value limits, including arrays beyond 10000',()=>{
 assert.equal(JSON.parse(canonicalStringify(Array(10001).fill(0))).length,10001);
 assert.doesNotThrow(()=>canonicalStringify(Array(99999).fill(null)));assert.throws(()=>canonicalStringify(Array(100000).fill(null)));
 let allowed=0;for(let i=0;i<64;i++)allowed=[allowed];assert.doesNotThrow(()=>canonicalStringify(allowed));assert.throws(()=>canonicalStringify([allowed]));
});
