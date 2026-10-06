'use strict';

// Authoring grammar only. Graph validity and shared interpretation stay in Core.
const crypto = require('node:crypto');
const { canonicalStringify } = require('../evidence/component-json');
const own = (v, k) => Object.hasOwn(v, k);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = v => 'sha256:' + crypto.createHash('sha256').update(canonicalStringify(v), 'utf8').digest('hex');
const clone = v => JSON.parse(canonicalStringify(v));
function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
function record(v, allowed, required = allowed) {
  canonicalStringify(v); // Reject accessors, symbols, cycles and non-JSON values before reading fields.
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !allowed.includes(k)) || required.some(k => !own(v,k))) fail('COMPONENT_INPUT_INVALID');
}
function hostRecord(v,allowed,required=allowed){
  if(!v||typeof v!=='object'||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))fail('CREATION_HOST_INPUT_INVALID');
  for(const k of Reflect.ownKeys(v)){const d=Object.getOwnPropertyDescriptor(v,k);if(typeof k!=='string'||!allowed.includes(k)||!d.enumerable||!own(d,'value'))fail('CREATION_HOST_INPUT_INVALID');}
  if(required.some(k=>!own(v,k)))fail('CREATION_HOST_INPUT_INVALID');
}
function text(v) { if (typeof v !== 'string' || !v.trim() || !v.isWellFormed() || Buffer.byteLength(v) > 1024*1024) fail('COMPONENT_TEXT_INVALID'); return v; }
function local(v) { if (typeof v !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(v)) fail('COMPONENT_LOCAL_KEY_INVALID'); return v; }
function array(v) { if (!Array.isArray(v)) fail('COMPONENT_ARRAY_INVALID'); return v; }
function uniqueKeys(items) { const keys = items.map(x => local(x.localKey)); if (new Set(keys).size !== keys.length) fail('COMPONENT_LOCAL_KEY_DUPLICATE'); }
function component(v, judgmentTerm, semantics) {
  record(v, ['localKey','type','method','role','content','statement'], ['localKey','type','method','role','content','statement']); local(v.localKey);
  if (!['taxonomy','candidate-set','discriminator-set'].includes(v.type)) fail('COMPONENT_TYPE_UNSUPPORTED');
  // R2 method law: the component's declared basic method always equals the
  // judgment term (base kinds); its role comes from that kind's role family.
  // The statement is authored, never a mechanical representation (CS2).
  record(v.method,['term'],['term']); text(v.method.term);
  if (v.method.term !== judgmentTerm) fail('COMPONENT_METHOD_TERM_MISMATCH');
  text(v.role);
  text(v.statement);
  if (v.type === 'taxonomy') record(v.content,['items','broader']);
  if (v.type === 'candidate-set') record(v.content,['items']);
  if (v.type === 'discriminator-set') { record(v.content,['candidateSetLocalKey','items']); local(v.content.candidateSetLocalKey); }
  array(v.content.items);
  if (v.type === 'taxonomy') array(v.content.broader);
  // Item body, edges and contrast rules are checked by the pinned Core before Compiler.
  return clone(v);
}
function method(v, semantics) {
  record(v,['method','components'],['method']);
  record(v.method,['term','extension'],['term']); text(v.method.term);
  const spec = semantics.methodRoles[v.method.term];
  if (!semantics.baseKinds.includes(v.method.term) || !spec) fail('COMPONENT_METHOD_TERM_UNSUPPORTED');
  if (!own(v,'components')) fail('CREATION_METHOD_INCOMPLETE');
  array(v.components).forEach(c => component(c, v.method.term, semantics));
  uniqueKeys(v.components);
  // Role family: unknown roles reject; every required role must be covered.
  const family = [...spec.required, ...spec.optional];
  if (v.components.some(c => !family.includes(c.role))) fail('COMPONENT_ROLE_UNKNOWN');
  if (spec.required.some(role => !v.components.some(c => c.role === role))) fail('CREATION_METHOD_INCOMPLETE');
  // A required role must carry actual typed content; an empty typed body is
  // incomplete, not a declaration (R01: actual required roles).
  if (v.components.some(c => spec.required.includes(c.role) && c.content.items.length === 0)) fail('CREATION_METHOD_INCOMPLETE');
  for (const c of v.components) if (c.type === 'discriminator-set' && !v.components.some(t => t.localKey === c.content.candidateSetLocalKey && t.type === 'candidate-set')) fail('COMPONENT_TARGET_UNKNOWN');
  return clone(v); // Missing own fields remain missing; null was rejected above.
}
function alternative(v, materials, semantics) {
  const required = ['localKey','title','subject','scope','statement','rationale','materialRefs'];
  record(v,[...required,'method','formationRule','publicSources','publicNotices'],required); local(v.localKey);
  for (const k of ['title','subject','scope','statement','rationale']) text(v[k]);
  array(v.materialRefs); if (!v.materialRefs.length || new Set(v.materialRefs).size !== v.materialRefs.length || v.materialRefs.some(id => !materials.some(m => m.id === id))) fail('COMPONENT_MATERIAL_REFERENCE_INVALID');
  // The method is mandatory and complete: absence is a named rejection, never a default.
  if (!own(v,'method')) fail('CREATION_METHOD_REQUIRED');
  method(v.method, semantics);
  if (own(v,'formationRule')) { record(v.formationRule,['conditions']); array(v.formationRule.conditions).forEach(x=>{record(x,['kind','statement']);if(x.kind!=='interpreted')fail('CREATION_CONDITION_KIND_UNSUPPORTED');text(x.statement);});
    // R2 conditions are owned references on the payload; inline interpreted
    // condition mapping is not part of this contract yet, so a non-empty set
    // is a named rejection rather than a silent drop.
    if (v.formationRule.conditions.length) fail('CREATION_FORMATION_CONDITIONS_UNSUPPORTED'); }
  if (own(v,'publicSources')) {
    uniqueKeys(array(v.publicSources));
    for (const s of v.publicSources) {
      record(s,['localKey','identity','version','digest','uses'],['localKey','identity','uses']); text(s.identity);
      if (own(s,'version')) text(s.version); if (own(s,'digest') && !/^sha256:[0-9a-f]{64}$/.test(s.digest)) fail('COMPONENT_SOURCE_DIGEST_INVALID');
      uniqueKeys(array(s.uses));
      for (const u of s.uses) {
        record(u,['localKey','role','componentLocalKey'],['localKey','role']); text(u.role);
        if (own(u,'componentLocalKey') && !(v.method?.components || []).some(c => c.localKey === u.componentLocalKey)) fail('COMPONENT_SOURCE_TARGET_UNKNOWN');
      }
    }
  }
  if (own(v,'publicNotices')) {
    uniqueKeys(array(v.publicNotices));
    for (const n of v.publicNotices) {
      record(n,['localKey','statement','sourceLocalKeys']); text(n.statement); array(n.sourceLocalKeys);
      if (new Set(n.sourceLocalKeys).size !== n.sourceLocalKeys.length || n.sourceLocalKeys.some(k => !(v.publicSources || []).some(s => s.localKey === k))) fail('COMPONENT_NOTICE_SOURCE_UNKNOWN');
    }
  }
  return clone(v);
}
function group(v, materials, semantics) {
  record(v,['localKey','alternatives']); local(v.localKey); array(v.alternatives);
  if (v.alternatives.length < 2) fail('CREATION_TWO_ALTERNATIVES_REQUIRED');
  uniqueKeys(v.alternatives); const alternatives = v.alternatives.map(a => alternative(a,materials,semantics));
  const meanings = alternatives.map(a => { const x = clone(a); for (const k of ['localKey','title','rationale','materialRefs']) delete x[k]; return hash(x); });
  if (new Set(meanings).size !== alternatives.length) fail('CREATION_ALTERNATIVES_NOT_DISTINCT');
  return {localKey:v.localKey,alternatives};
}
module.exports = { own,fail,hash,clone,freeze,record,hostRecord,text,local,array,group };
