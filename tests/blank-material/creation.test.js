'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createSession, verifyCreationEvidence } = require('../../src');
const { admitBytes } = require('@aikdna/kdna-core');

// All people, materials and replies here are synthetic fixtures. This adapter
// substitutes a human-channel integration, not a real human or identity proof.
function fixture() {
  const queue = [];
  let current;
  const session = createSession({
    agent: { name: 'synthetic-authoring-agent', version: 'fixture-1' },
    syntheticFixture: true,
    humanInput: {
      channel: 'synthetic-human-channel',
      receive: async review => {
        current = queue.shift();
        if (!current) throw new Error('Synthetic reply was not supplied.');
        return {
          id: current.id || crypto.randomUUID(), role: 'human',
          channel: 'synthetic-human-channel', review_id: review.review_id,
          text: current.text, ...(current.override || {}),
        };
      },
    },
    interpretHuman: async () => current.intent,
  });
  const reply = async (text, intent, extras = {}) => {
    queue.push({ text, intent, ...extras });
    return session.receiveHumanReply();
  };
  return { session, reply };
}

function prepare(f) {
  assert.equal(f.session.inspect().materials.length, 0);
  assert.equal(f.session.inspect().candidates.length, 0);
  f.session.agent.setBrief({ title: 'Synthetic review judgment', scope: 'A fictional editorial review exercise.' });
  const material = f.session.agent.recordMaterial({
    kind: 'interview', title: 'Synthetic interview',
    coordinate: 'synthetic://interview/one#turn-1',
    content: 'Synthetic respondent: a claim needs traceable support; revise an unsupported assertion before sharing it.',
  });
  const authored = {
    title: 'Check the support', subject: 'A proposed editorial assertion',
    scope: 'The fictional exercise only', statement: 'Revise an assertion if its support cannot be traced.',
    rationale: 'Readers need enough evidence to check the assertion.', materialRefs: [material.id],
  };
  const candidate = f.session.agent.propose(authored);
  return { material, authored, candidate };
}

async function ready() {
  const f = fixture();
  const prepared = prepare(f);
  await f.reply('保留这条判断。', { kind: 'select', candidateRefs: [prepared.candidate.ref] });
  const preview = f.session.agent.compilePreview();
  await f.reply('我确认当前展示的稿件，可以导出这份合成测试文件。', { kind: 'confirm' });
  return { ...f, ...prepared, preview };
}

test('blank material through proposal, rejection, revision, human review, Compiler and accepted Core', async () => {
  const f = fixture();
  const { authored, candidate } = prepare(f);
  const rejected = f.session.agent.propose({ ...authored, title: 'Overbroad alternative', statement: 'Every assertion is ready to share.' });
  await f.reply('第二个候选过于绝对，弃用。', { kind: 'reject', candidateRefs: [rejected.ref] });
  await f.reply('第一条请补充：修订后仍要再次审查。', { kind: 'revise', candidateRefs: [candidate.ref] });
  assert.throws(() => f.session.agent.compilePreview(), { code: 'REVIEW_INCOMPLETE' });
  f.session.agent.revise(candidate.ref, {
    authored: { ...authored, statement: 'Revise an unsupported assertion and review the revised text before sharing it.' },
    explanation: 'The synthetic human asked for another review after revision.',
  });
  await f.reply('保留修订后的第一条。', { kind: 'select', candidateRefs: [candidate.ref] });
  const preview = f.session.agent.compilePreview();
  await f.reply('我确认当前展示的修改稿，按这份内容导出。', { kind: 'confirm' });
  const result = f.session.exportAsset();
  assert.equal(result.verification.status, 'consistent');
  assert.equal(result.binding.asset_digest, preview.artifact_digest);
  assert.equal(result.evidence.synthetic_fixture, true);
  assert.equal(result.evidence.candidates.find(item => item.ref === rejected.ref).status, 'rejected');
  assert.ok(result.evidence.history.some(item => item.event === 'candidate_revised'));
  assert.equal(admitBytes(result.bytes).status, 'accepted');
  assert.equal(result.evidence.confirmation, 'claimed_unverified');
  assert.equal(result.evidence.creation.accepted, 'not_evaluated');
  assert.equal(result.evidence.action_authorization, 'not_evaluated');
  assert.equal(result.bytes.includes(Buffer.from('synthetic://interview')), false);
  assert.equal(result.bytes.includes(Buffer.from('Synthetic respondent:')), false);
  assert.equal(result.bytes.includes(Buffer.from('human_final_decision')), false);
  assert.throws(() => f.session.agent.setBrief({ title: 'changed', scope: 'changed' }), { code: 'SESSION_SEALED' });
});

test('missing material, empty material and missing source coordinates fail closed', () => {
  const f = fixture();
  assert.throws(() => f.session.agent.propose({}), { code: 'MATERIAL_REQUIRED' });
  assert.throws(() => f.session.agent.recordMaterial({ kind: 'text', title: 'test', content: '', coordinate: 'synthetic://empty' }), { code: 'INPUT_INVALID' });
  assert.throws(() => f.session.agent.recordMaterial({ kind: 'text', title: 'test', content: 'A fixture.' }), { code: 'INPUT_INVALID' });
  assert.throws(() => f.session.exportAsset(), { code: 'CREATION_EVIDENCE_REQUIRED' });
});

test('Agent cannot submit a final decision or inject a Creator, asset ID, version, old card or wire', () => {
  for (const forbidden of ['asset_id', 'version', 'judgment_version', 'creator', 'human_confirmed', 'cards', 'payload', 'lineage']) {
    const f = fixture();
    const { authored } = prepare(f);
    assert.throws(() => f.session.agent.propose({ ...authored, [forbidden]: 'forged' }), { code: 'INPUT_FIELD_FORBIDDEN' });
  }
  const f = fixture();
  assert.equal(f.session.agent.confirm, undefined);
  assert.equal(f.session.recordConfirmation, undefined);
  assert.equal(f.session.loadWorkspace, undefined);
  assert.throws(() => f.session.agent.recordMaterial({ kind: 'kdna', title: 'old asset', content: 'old', coordinate: 'fixture://old' }), { code: 'MATERIAL_KIND_UNSUPPORTED' });
});

test('a final-decision interpretation without a compiled review cannot authorize export', async () => {
  const f = fixture(); prepare(f);
  await assert.rejects(f.reply('先不要导出。', { kind: 'confirm' }), { code: 'FINAL_DECISION_UNBOUND' });
  assert.throws(() => f.session.exportAsset(), { code: 'CREATION_EVIDENCE_REQUIRED' });
});

test('Agent-origin reply, wrong channel and stale review token are rejected before interpretation', async () => {
  for (const override of [{ role: 'agent' }, { channel: 'another-channel' }, { review_id: 'old-review' }, { final_decision: true }]) {
    const f = fixture(); prepare(f);
    await assert.rejects(f.reply('确认。', { kind: 'confirm' }, { override }), error =>
      ['HUMAN_MESSAGE_UNBOUND', 'INPUT_FIELD_FORBIDDEN'].includes(error.code));
    assert.equal(f.session.inspect().final_decision, null);
  }
});

test('human message replay is rejected even when it is rebound to a fresh review token', async () => {
  const f = fixture(); const { candidate } = prepare(f);
  await f.reply('保留这条。', { kind: 'select', candidateRefs: [candidate.ref] }, { id: 'same-message' });
  f.session.agent.compilePreview();
  await assert.rejects(f.reply('确认导出。', { kind: 'confirm' }, { id: 'same-message' }), { code: 'HUMAN_MESSAGE_REPLAY' });
});

test('starting a new human review revokes the prior final decision even if the channel fails', async () => {
  const f = await ready();
  await assert.rejects(f.reply('暂停导出，继续审查。', { kind: 'note' }, { override: { review_id: 'stale' } }), { code: 'HUMAN_MESSAGE_UNBOUND' });
  assert.equal(f.session.inspect().final_decision, null);
  assert.throws(() => f.session.exportAsset(), { code: 'CREATION_EVIDENCE_REQUIRED' });
});

test('revision and new material invalidate the exact confirmed preview', async () => {
  for (const kind of ['revision', 'material']) {
    const f = await ready();
    if (kind === 'revision') {
      f.session.agent.revise(f.candidate.ref, { authored: { ...f.authored, statement: 'A changed assertion.' }, explanation: 'A synthetic revision.' });
    } else {
      f.session.agent.recordMaterial({ kind: 'text', title: 'New material', content: 'Another synthetic source.', coordinate: 'synthetic://new' });
    }
    assert.equal(f.session.inspect().final_decision, null);
    assert.throws(() => f.session.exportAsset(), { code: 'CREATION_EVIDENCE_REQUIRED' });
  }
});

test('format-valid bytes without Creation evidence remain Creation insufficient', async () => {
  const f = await ready(); const result = f.session.exportAsset();
  const verification = verifyCreationEvidence(result.bytes, null, result.binding);
  assert.equal(verification.core, 'valid');
  assert.equal(verification.reason, 'CREATION_EVIDENCE_REQUIRED');
  assert.equal(verification.creation_accepted, 'not_evaluated');
});

test('artifact drift, material drift, forged final receipt and cross-session replay fail the exact binding', async () => {
  const first = (await ready()).session.exportAsset();
  const other = (await ready()).session.exportAsset();
  assert.equal(verifyCreationEvidence(other.bytes, first.evidence, first.binding).status, 'inconsistent');
  for (const mutate of [
    evidence => { evidence.materials[0].content += 'modified'; },
    evidence => { evidence.final_decision.artifact_digest = 'sha256:' + '0'.repeat(64); },
    evidence => { evidence.confirmation = 'verified'; },
    evidence => { evidence.history.pop(); },
  ]) {
    const changed = JSON.parse(JSON.stringify(first.evidence)); mutate(changed);
    assert.equal(verifyCreationEvidence(first.bytes, changed, first.binding).reason, 'CREATION_BINDING_MISMATCH');
  }
  const bytes = Buffer.from(first.bytes); bytes[bytes.length - 1] ^= 1;
  assert.equal(verifyCreationEvidence(bytes, first.evidence, first.binding).status, 'inconsistent');
});

test('private evidence cannot be upgraded to verified identity by recomputing its local digest', async () => {
  const result = (await ready()).session.exportAsset();
  const { digest } = require('../../src/evidence/blank-material');
  const evidence = JSON.parse(JSON.stringify(result.evidence)); evidence.confirmation = 'verified';
  const forgedBinding = { ...result.binding, evidence_digest: digest(evidence) };
  assert.equal(verifyCreationEvidence(result.bytes, evidence, forgedBinding).reason, 'AUTHORITY_CLAIM_UNSUPPORTED');
});

test('format 1 rejects an absent required Core record before evidence hashing', async () => {
  const result = (await ready()).session.exportAsset();
  const { digest } = require('../../src/evidence/blank-material');
  const evidence = JSON.parse(JSON.stringify(result.evidence)); delete evidence.core;
  const binding = { ...result.binding, evidence_digest: digest(evidence) };
  assert.equal(verifyCreationEvidence(result.bytes, evidence, binding).reason, 'CREATION_EVIDENCE_MALFORMED');
});

test('material and returned state are immutable copies; unknown references and accessors reject', () => {
  const f = fixture(); const { authored, material } = prepare(f);
  assert.throws(() => { material.content = 'changed'; }, TypeError);
  assert.throws(() => { f.session.inspect().materials[0].content = 'changed'; }, TypeError);
  assert.throws(() => f.session.agent.propose({ ...authored, materialRefs: ['unknown'] }), { code: 'MATERIAL_REFERENCE_INVALID' });
  let calls = 0;
  assert.throws(() => f.session.agent.setBrief({ get title() { calls++; return 'bad'; }, scope: 'scope' }), { code: 'INPUT_FIELD_FORBIDDEN' });
  assert.equal(calls, 0);
});

test('an asynchronous human-channel turn excludes concurrent Agent edits', async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const session = createSession({
    agent: { name: 'synthetic-agent', version: 'fixture-1' }, syntheticFixture: true,
    humanInput: { channel: 'synthetic', receive: async review => {
      await wait;
      return { id: 'one', role: 'human', channel: 'synthetic', review_id: review.review_id, text: '这是补充意见。' };
    } },
    interpretHuman: async () => ({ kind: 'note' }),
  });
  const pending = session.receiveHumanReply();
  assert.throws(() => session.agent.setBrief({ title: 'changed', scope: 'changed' }), { code: 'SESSION_BUSY' });
  release(); await pending;
});
