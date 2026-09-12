'use strict';

const crypto = require('node:crypto');
const { compileBlankMaterial } = require('../compile/blank-material');
const {
  clone, digest, freeze, requiredText, closedRecord, materialEntry,
  appendHistory, verifyCreationEvidence,
} = require('../evidence/blank-material');
const { contract } = require('../evidence/provider-contract');
const packageInfo = require('../../package.json');

// Session history, material hashing and invalidation retain the existing
// Creation Engine's evolve model. No old workspace/card can enter this path.
function createSession(options) {
  closedRecord(options, ['agent', 'humanInput', 'interpretHuman', 'syntheticFixture']);
  closedRecord(options.agent, ['name', 'version']);
  closedRecord(options.humanInput, ['channel', 'receive']);
  const agent = {
    name: requiredText(options.agent.name, 'agent.name'),
    version: requiredText(options.agent.version, 'agent.version'),
  };
  const channel = requiredText(options.humanInput.channel, 'humanInput.channel');
  const receive = options.humanInput.receive;
  const interpret = options.interpretHuman;
  if (typeof receive !== 'function' || typeof interpret !== 'function') {
    throw failure('HUMAN_CHANNEL_REQUIRED', 'Provide a human message channel and an Agent interpreter.');
  }
  if (options.syntheticFixture !== undefined && typeof options.syntheticFixture !== 'boolean') {
    throw failure('INPUT_INVALID', 'syntheticFixture must be a boolean.');
  }
  const compiler = { name: packageInfo.name, version: packageInfo.version, provider: 'javascript', artifact_sha256: 'UNKNOWN' };
  const sessionId = `session:${crypto.randomUUID()}`;
  const assetId = `asset:${crypto.randomUUID()}`;
  const assetUid = `urn:uuid:${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  let state = {
    session_id: sessionId, revision: 0, agent, compiler,
    synthetic_fixture: options.syntheticFixture === true,
    brief: null, materials: [], candidates: [], human_messages: [], history: [],
  };
  let preview = null;
  let finalDecision = null;
  let busy = false;
  let exported = false;
  const seenMessages = new Set();

  function ensureOpen() {
    if (exported) throw failure('SESSION_SEALED', 'Start a new blank session after export.');
    if (busy) throw failure('SESSION_BUSY', 'A human review is in progress.');
  }

  function evolve(event, detail, mutate) {
    const next = clone(state);
    mutate(next);
    next.revision += 1;
    appendHistory(next, event, detail);
    state = next;
    preview = null;
    finalDecision = null;
  }

  function candidate(ref, next = state) {
    const found = next.candidates.find(item => item.ref === ref);
    if (!found) throw failure('CANDIDATE_UNKNOWN', 'Select an existing candidate.');
    return found;
  }

  function authoredCandidate(input) {
    closedRecord(input, ['title', 'subject', 'scope', 'statement', 'rationale', 'materialRefs']);
    if (!state.materials.length) throw failure('MATERIAL_REQUIRED', 'Record source material before proposing a judgment.');
    const result = {};
    for (const field of ['title', 'subject', 'scope', 'statement', 'rationale']) {
      result[field] = requiredText(input[field], field);
    }
    if (!Array.isArray(input.materialRefs) || !input.materialRefs.length ||
        new Set(input.materialRefs).size !== input.materialRefs.length ||
        input.materialRefs.some(ref => !state.materials.some(item => item.id === ref))) {
      throw failure('MATERIAL_REFERENCE_INVALID', 'Candidates must reference recorded material coordinates.');
    }
    result.material_refs = [...input.materialRefs];
    return result;
  }

  function inspect() {
    return freeze(clone({
      ...state,
      status: exported ? 'exported' : finalDecision ? 'confirmed_claim_unverified' :
        preview ? 'awaiting_final_decision' : 'draft',
      final_decision: finalDecision,
      preview: preview ? preview.review : null,
      authority: {
        confirmation: finalDecision ? 'claimed_unverified' : 'not_evaluated',
        creation_accepted: 'not_evaluated', identity: 'not_verified',
        read_permission: 'not_evaluated', action_authorization: 'not_evaluated',
      },
    }));
  }

  function setBrief(input) {
    ensureOpen();
    closedRecord(input, ['title', 'scope']);
    const brief = { title: requiredText(input.title, 'title'), scope: requiredText(input.scope, 'scope') };
    evolve('brief_recorded', brief, next => { next.brief = brief; });
    return inspect();
  }

  function recordMaterial(input) {
    ensureOpen();
    const material = materialEntry(input);
    if (state.materials.some(item => item.coordinate === material.coordinate)) {
      throw failure('MATERIAL_COORDINATE_REUSED', 'Record a distinct immutable material coordinate.');
    }
    evolve('material_recorded', material, next => { next.materials.push(material); });
    return freeze(clone(material));
  }

  function propose(input) {
    ensureOpen();
    const item = {
      ref: `candidate:${crypto.randomUUID()}`, revision: 1,
      ...authoredCandidate(input), status: 'proposed', revision_request: null,
    };
    evolve('candidate_proposed', item, next => { next.candidates.push(item); });
    return freeze(clone(item));
  }

  function revise(ref, input) {
    ensureOpen();
    closedRecord(input, ['authored', 'explanation']);
    const previous = candidate(ref);
    const authored = authoredCandidate(input.authored);
    const explanation = requiredText(input.explanation, 'explanation');
    const replacement = {
      ref, revision: previous.revision + 1, ...authored,
      status: 'proposed', revision_request: null,
    };
    evolve('candidate_revised', {
      previous: clone(previous), replacement, explanation,
      requested_by_message: previous.revision_request,
    }, next => { Object.assign(candidate(ref, next), replacement); });
    return freeze(clone(replacement));
  }

  function compilePreview() {
    ensureOpen();
    if (!state.brief) throw failure('BRIEF_REQUIRED', 'Record the intended scope before compilation.');
    if (!state.materials.length) throw failure('MATERIAL_REQUIRED', 'Creation requires source material.');
    const selected = state.candidates.filter(item => item.status === 'selected');
    if (!selected.length || state.candidates.some(item => !['selected', 'rejected'].includes(item.status))) {
      throw failure('REVIEW_INCOMPLETE', 'Resolve the proposed candidates and requested revisions first.');
    }
    const compiled = compileBlankMaterial({
      brief: state.brief, candidates: selected,
      asset: { asset_id: assetId, asset_uid: assetUid, version: `0.1.${state.revision}` },
      createdAt, syntheticFixture: state.synthetic_fixture,
    });
    const review = freeze({
      session_id: sessionId, revision: state.revision,
      artifact_digest: compiled.assetDigest,
      title: state.brief.title, scope: state.brief.scope,
      judgments: selected.map(item => ({
        candidate_ref: item.ref, title: item.title, subject: item.subject,
        scope: item.scope, statement: item.statement, rationale: item.rationale,
      })),
      format_valid: true, creation_accepted: 'not_evaluated',
    });
    preview = { compiled, review, revision: state.revision };
    finalDecision = null;
    appendHistory(state, 'compiler_preview', { ...review, compiler, agent });
    return review;
  }

  async function receiveHumanReply() {
    ensureOpen();
    busy = true;
    finalDecision = null;
    const reviewId = `review:${crypto.randomUUID()}`;
    const review = freeze({
      review_id: reviewId, session_id: sessionId, revision: state.revision,
      brief: clone(state.brief), candidates: clone(state.candidates),
      compiled: preview ? clone(preview.review) : null,
    });
    try {
      // The embedding owns channel provenance. The Agent supplies a proposed
      // interpretation of the human's natural language, never a human identity.
      const received = await receive(review);
      closedRecord(received, ['id', 'role', 'channel', 'review_id', 'text']);
      const message = clone(received);
      requiredText(message.id, 'message.id');
      requiredText(message.text, 'message.text');
      if (message.role !== 'human' || message.channel !== channel || message.review_id !== reviewId) {
        throw failure('HUMAN_MESSAGE_UNBOUND', 'The reply must come from the declared human channel for this review.');
      }
      if (seenMessages.has(message.id)) throw failure('HUMAN_MESSAGE_REPLAY', 'This message has already been consumed.');
      seenMessages.add(message.id);
      const interpreted = await interpret(message.text, review);
      closedRecord(interpreted, ['kind', 'candidateRefs']);
      const intent = clone(interpreted);
      if (!['select', 'reject', 'revise', 'note', 'confirm'].includes(intent.kind)) {
        throw failure('HUMAN_INTERPRETATION_INVALID', 'Unsupported human reply interpretation.');
      }
      const refs = intent.candidateRefs;
      if (['select', 'reject', 'revise'].includes(intent.kind)) {
        if (!Array.isArray(refs) || !refs.length || new Set(refs).size !== refs.length) {
          throw failure('HUMAN_INTERPRETATION_INVALID', 'Interpretation requires existing candidate references.');
        }
        refs.forEach(ref => candidate(ref));
      } else if (refs !== undefined) {
        throw failure('HUMAN_INTERPRETATION_INVALID', 'This reply does not select individual candidates.');
      }
      const record = {
        ...message, interpreted_by: agent, interpretation: intent,
        revision: state.revision, review: clone(review),
        identity_verification: 'not_verified',
      };
      if (intent.kind === 'confirm') {
        if (!preview || preview.revision !== state.revision) {
          throw failure('FINAL_DECISION_UNBOUND', 'Review the current compiled output before final confirmation.');
        }
        state.human_messages.push(record);
        finalDecision = {
          message_id: message.id, channel, text: message.text,
          review_id: reviewId, session_id: sessionId, revision: state.revision,
          artifact_digest: preview.compiled.assetDigest,
          confirmation: 'claimed_unverified', identity_verification: 'not_verified',
        };
        appendHistory(state, 'human_final_decision', finalDecision);
      } else {
        evolve('human_reply', record, next => {
          next.human_messages.push(record);
          for (const ref of refs || []) {
            const item = candidate(ref, next);
            item.status = { select: 'selected', reject: 'rejected', revise: 'awaiting_revision' }[intent.kind];
            item.revision_request = intent.kind === 'revise' ? message.id : null;
          }
        });
      }
      return inspect();
    } catch (error) {
      appendHistory(state, 'human_reply_rejected', {
        review_id: reviewId, code: typeof error.code === 'string' ? error.code : 'HUMAN_CHANNEL_FAILURE',
      });
      throw error;
    } finally {
      busy = false;
    }
  }

  function exportAsset() {
    ensureOpen();
    if (!preview || !finalDecision || finalDecision.revision !== state.revision ||
        finalDecision.artifact_digest !== preview.compiled.assetDigest) {
      throw failure('CREATION_EVIDENCE_REQUIRED', 'Export requires the current compiled output and a bound human final decision.');
    }
    const evidence = {
      format: contract.format, kind: 'studio-blank-material-evidence', session_id: sessionId,
      synthetic_fixture: state.synthetic_fixture,
      agent, compiler, revision: state.revision,
      materials: clone(state.materials), candidates: clone(state.candidates),
      human_messages: clone(state.human_messages), history: clone(state.history),
      final_decision: clone(finalDecision),
      artifact: { digest: preview.compiled.assetDigest, bytes: preview.compiled.bytes.length },
      core: { status: 'valid', reference_contract: contract.reference_contract, implementation: contract.implementations.javascript, digests: preview.compiled.digests },
      creation: { requiredness: 'satisfied', accepted: 'not_evaluated' },
      confirmation: 'claimed_unverified', identity: 'not_verified',
      read_permission: 'not_evaluated', action_authorization: 'not_evaluated',
    };
    const binding = freeze({
      session_id: sessionId, asset_digest: evidence.artifact.digest, evidence_digest: digest(evidence),
    });
    const result = verifyCreationEvidence(preview.compiled.bytes, evidence, binding);
    if (result.status !== 'consistent') throw failure('CREATION_EVIDENCE_INCONSISTENT', result.reason);
    exported = true;
    return Object.freeze({
      bytes: Buffer.from(preview.compiled.bytes), evidence: freeze(evidence), binding,
      verification: result,
    });
  }

  return Object.freeze({
    agent: Object.freeze({ setBrief, recordMaterial, propose, revise, compilePreview }),
    receiveHumanReply, exportAsset, inspect,
  });
}

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = { createSession, verifyCreationEvidence };
