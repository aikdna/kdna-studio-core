'use strict';

// Private Studio evidence format. This is not a public Core/IR canonicalizer.
const contract = require('./provider-contract.json');
const own = (value, key) => value != null && Object.hasOwn(value, key);
const uint = value => Number.isSafeInteger(value) && value >= 0;
function malformed() { throw new TypeError('Malformed Studio format 1 evidence.'); }

function validateJSON(value, evidenceNumbers = false) {
  let count = 0;
  const active = new Set();
  function visit(item, depth) {
    if (++count > 100000 || depth > 64) malformed();
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') { if (!item.isWellFormed()) malformed(); return; }
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || (evidenceNumbers && !uint(item))) malformed();
      return;
    }
    if (!item || typeof item !== 'object' || active.has(item)) malformed();
    active.add(item);
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || Reflect.ownKeys(item).length !== item.length + 1) malformed();
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (!descriptor || !descriptor.enumerable || !own(descriptor, 'value')) malformed();
        visit(descriptor.value, depth + 1);
      }
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) malformed();
      for (const key of Reflect.ownKeys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (typeof key !== 'string' || !key.isWellFormed() || !descriptor.enumerable || !own(descriptor, 'value')) malformed();
        if (evidenceNumbers && ['revision', 'sequence', 'bytes'].includes(key) && !uint(descriptor.value)) malformed();
        visit(descriptor.value, depth + 1);
      }
    }
    active.delete(item);
  }
  visit(value, 0);
}
function sortedJSON(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${sortedJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function canonicalStringify(value) { validateJSON(value); return sortedJSON(value); }
function closed(value, fields, required = fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !fields.includes(key)) || required.some(key => !own(value, key))) malformed();
}
function revision(value) { if (!value || !uint(value.revision)) malformed(); }
function review(value) {
  revision(value);
  if (!Array.isArray(value.candidates)) malformed();
  value.candidates.forEach(revision);
  if (value.compiled !== null) revision(value.compiled);
}
function message(value) { revision(value); review(value.review); }
function preflight(evidence) {
  const descriptor = Object.getOwnPropertyDescriptor(evidence, 'format');
  if (!descriptor) return false;
  if (!own(descriptor, 'value')) malformed();
  if (descriptor.value !== contract.format) return 'CREATION_EVIDENCE_FORMAT_UNSUPPORTED';
  validateJSON(evidence, true);
  closed(evidence, contract.evidence_fields);
  closed(evidence.compiler, contract.compiler_fields);
  const mixedCore = own(evidence.core, 'package') || own(evidence.core, 'version');
  closed(evidence.core, [...contract.core_fields, 'package', 'version'], mixedCore ? [] : contract.core_fields);
  closed(evidence.artifact, ['digest', 'bytes']);
  if (typeof evidence.synthetic_fixture !== 'boolean' || !Array.isArray(evidence.materials) ||
      !Array.isArray(evidence.candidates) || !Array.isArray(evidence.human_messages) || !Array.isArray(evidence.history)) malformed();
  revision(evidence); revision(evidence.final_decision);
  evidence.candidates.forEach(revision);
  evidence.human_messages.forEach(message);
  for (const entry of evidence.history) {
    revision(entry); if (!uint(entry.sequence)) malformed();
    switch (entry.event) {
      case 'candidate_proposed': case 'compiler_preview': case 'human_final_decision': revision(entry.detail); break;
      case 'candidate_revised': revision(entry.detail?.previous); revision(entry.detail?.replacement); break;
      case 'human_reply': message(entry.detail); break;
    }
  }
  return true;
}
function declarationReason(evidence, current) {
  if (!current) {
    if (['reference_contract', 'implementation', 'provider'].some(key => own(evidence.core, key)) ||
        ['provider', 'artifact_sha256'].some(key => own(evidence.compiler, key))) return 'CREATION_EVIDENCE_FORMAT_AMBIGUOUS';
    return null;
  }
  if (own(evidence.core, 'package') || own(evidence.core, 'version')) return 'CREATION_EVIDENCE_FORMAT_AMBIGUOUS';
  if (sortedJSON(evidence.core.reference_contract) !== sortedJSON(contract.reference_contract)) return 'CREATION_CORE_CONTRACT_UNSUPPORTED';
  const implementation = evidence.core.implementation;
  const supported = implementation && own(contract.implementations, implementation.provider) ? contract.implementations[implementation.provider] : null;
  const compiler = evidence.compiler;
  if (!supported || sortedJSON(implementation) !== sortedJSON(supported) || compiler.provider !== implementation.provider ||
      typeof compiler.name !== 'string' || !compiler.name.trim() || typeof compiler.version !== 'string' || !compiler.version.trim() ||
      typeof compiler.artifact_sha256 !== 'string' || !/^(UNKNOWN|[0-9a-f]{64})$/.test(compiler.artifact_sha256) ||
      evidence.history.some(entry => entry.event === 'compiler_preview' && sortedJSON(entry.detail.compiler) !== sortedJSON(compiler))) {
    return 'CREATION_PROVIDER_DECLARATION_UNSUPPORTED';
  }
  return null;
}
function resultDeclarations(evidence, current) {
  return {
    evidence_format: current ? contract.format : 'studio-blank-material-evidence/legacy',
    provider_assertion: 'declared_not_authenticated',
    implementation_artifact_sha256: current ? evidence.core.implementation.artifact.sha256 : 'UNKNOWN',
    compiler_artifact_sha256: current ? evidence.compiler.artifact_sha256 : 'UNKNOWN',
    reference_contract: current ? 'declared_supported_exact' : 'UNKNOWN',
  };
}
// Internal consumers receive immutable declarations; no caller-selected module/path.
function deepFreeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; }
deepFreeze(contract);
module.exports = { contract, canonicalStringify, preflight, declarationReason, resultDeclarations };
