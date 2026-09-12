'use strict';

const crypto = require('node:crypto');
const { admitBytes } = require('@aikdna/kdna-core');
const { preflight, declarationReason, resultDeclarations } = require('./provider-contract');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

// This is a private Studio evidence digest, not public A/C/E/IR canonicalization.
// It retains the existing Creation Engine's sorted-key audit representation.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function digest(value) {
  return sha256(Buffer.from(stableStringify(value), 'utf8'));
}

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim() ||
      Buffer.byteLength(value, 'utf8') > 1024 * 1024 || !value.isWellFormed()) {
    throw Object.assign(new Error(`${label} requires nonempty Unicode text.`), { code: 'INPUT_INVALID' });
  }
  return value;
}

function closedRecord(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw Object.assign(new Error('Expected a plain input record.'), { code: 'INPUT_INVALID' });
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !fields.includes(key) || !Object.hasOwn(descriptor, 'value')) {
      throw Object.assign(new Error('Unknown input field or accessor; asset identity and versions are compiler managed.'), { code: 'INPUT_FIELD_FORBIDDEN' });
    }
  }
}

function materialEntry(input) {
  closedRecord(input, ['kind', 'title', 'content', 'coordinate']);
  if (!['text', 'interview'].includes(input.kind)) {
    throw Object.assign(new Error('Blank creation accepts text or interview material, never an existing asset.'), { code: 'MATERIAL_KIND_UNSUPPORTED' });
  }
  const content = requiredText(input.content, 'material.content');
  // The existing evidence entry's byte hash and random ID are retained; the
  // blank path additionally requires an immutable private source coordinate.
  return {
    id: `ev_${crypto.randomUUID()}`, type: input.kind,
    title: requiredText(input.title, 'material.title'), content,
    coordinate: requiredText(input.coordinate, 'material.coordinate'),
    content_hash: sha256(Buffer.from(content, 'utf8')),
    imported_at: new Date().toISOString(),
  };
}

function appendHistory(state, event, detail) {
  const entry = {
    sequence: state.history.length + 1, revision: state.revision, event,
    at: new Date().toISOString(), detail: clone(detail),
    previous_digest: state.history.at(-1)?.digest || null,
  };
  state.history.push({ ...entry, digest: digest(entry) });
}

function verifyCreationEvidence(bytes, evidence, expectedBinding) {
  function reject(reason, core = 'not_evaluated') {
    return freeze({ status: 'inconsistent', reason, core,
      creation_accepted: 'not_evaluated', confirmation: 'not_evaluated',
      identity: 'not_verified', action_authorization: 'not_evaluated' });
  }
  const admission = admitBytes(bytes);
  if (admission.status !== 'accepted') return reject(admission.reason, 'invalid');
  if (!evidence || !expectedBinding) return reject('CREATION_EVIDENCE_REQUIRED', 'valid');
  try {
    const current = preflight(evidence);
    if (typeof current === 'string') return reject(current, 'valid');
    closedRecord(expectedBinding, ['session_id', 'asset_digest', 'evidence_digest']);
    const assetDigest = admission.snapshot.digests.A.observed;
    if (evidence.session_id !== expectedBinding.session_id ||
        assetDigest !== expectedBinding.asset_digest || digest(evidence) !== expectedBinding.evidence_digest ||
        evidence.artifact?.digest !== assetDigest || evidence.artifact?.bytes !== bytes.length) {
      return reject('CREATION_BINDING_MISMATCH', 'valid');
    }
    const unsupported = declarationReason(evidence, current);
    if (unsupported) return reject(unsupported, 'valid');
    if (evidence.kind !== 'studio-blank-material-evidence' || !evidence.materials?.length ||
        !evidence.agent?.name || !evidence.agent?.version ||
        !evidence.compiler?.name || !evidence.compiler?.version ||
        !Array.isArray(evidence.candidates) || !Array.isArray(evidence.human_messages) ||
        !Array.isArray(evidence.history)) return reject('CREATION_PREMISE_MISSING', 'valid');
    if (evidence.core?.status !== 'valid' || (!current && (evidence.core?.package !== '@aikdna/kdna-core' || evidence.core?.version !== '0.23.0')) ||
        digest(evidence.core.digests) !== digest(admission.snapshot.digests)) {
      return reject('CREATION_CORE_EVIDENCE_MISMATCH', 'valid');
    }
    if (evidence.materials.some(material => !material.coordinate || !material.content ||
        sha256(Buffer.from(material.content, 'utf8')) !== material.content_hash)) {
      return reject('MATERIAL_DIGEST_MISMATCH', 'valid');
    }
    const materialIds = new Set(evidence.materials.map(material => material.id));
    if (materialIds.size !== evidence.materials.length ||
        !evidence.candidates.some(item => item.status === 'selected') ||
        evidence.candidates.some(item => !['selected', 'rejected'].includes(item.status) ||
          !item.material_refs?.length || item.material_refs.some(ref => !materialIds.has(ref)))) {
      return reject('CREATION_REVIEW_INCOMPLETE', 'valid');
    }
    let previous = null;
    for (let i = 0; i < evidence.history.length; i++) {
      const { digest: stored, ...entry } = evidence.history[i];
      if (entry.sequence !== i + 1 || entry.previous_digest !== previous || digest(entry) !== stored) {
        return reject('CREATION_AUDIT_CHAIN_MISMATCH', 'valid');
      }
      previous = stored;
    }
    const decision = evidence.final_decision;
    const messages = evidence.human_messages;
    if (new Set(messages.map(message => message.id)).size !== messages.length) {
      return reject('HUMAN_MESSAGE_REPLAY', 'valid');
    }
    const message = messages.find(item => item.id === decision?.message_id);
    const preview = evidence.history.filter(item => item.event === 'compiler_preview').at(-1);
    const final = evidence.history.filter(item => item.event === 'human_final_decision').at(-1);
    if (!decision || !message || !preview || !final ||
        message.role !== 'human' || message.interpretation?.kind !== 'confirm' ||
        message.text !== decision.text || message.channel !== decision.channel ||
        message.review_id !== decision.review_id || message.review?.review_id !== decision.review_id ||
        message.review?.compiled?.artifact_digest !== assetDigest ||
        decision.session_id !== evidence.session_id || decision.artifact_digest !== assetDigest ||
        decision.revision !== evidence.revision || preview.detail.artifact_digest !== assetDigest ||
        preview.revision !== evidence.revision || digest(final.detail) !== digest(decision) ||
        final.sequence <= preview.sequence) return reject('FINAL_DECISION_UNBOUND', 'valid');
    if (evidence.confirmation !== 'claimed_unverified' || evidence.creation?.accepted !== 'not_evaluated' ||
        evidence.identity !== 'not_verified' || evidence.action_authorization !== 'not_evaluated') {
      return reject('AUTHORITY_CLAIM_UNSUPPORTED', 'valid');
    }
    return freeze({
      status: 'consistent', core: 'valid', requiredness: 'satisfied',
      creation_accepted: 'not_evaluated', confirmation: 'claimed_unverified',
      identity: 'not_verified', read_permission: 'not_evaluated', action_authorization: 'not_evaluated',
      asset_digest: assetDigest, evidence_digest: expectedBinding.evidence_digest,
      ...resultDeclarations(evidence, current),
    });
  } catch {
    return reject('CREATION_EVIDENCE_MALFORMED', 'valid');
  }
}

module.exports = {
  clone, freeze, digest, sha256, requiredText, closedRecord, materialEntry,
  appendHistory, verifyCreationEvidence,
};
