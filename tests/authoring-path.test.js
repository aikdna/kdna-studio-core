'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const cbor = require('cbor-x');

const studio = require('../src');

function addJudgment(project, overrides = {}) {
  return studio.authoring.addSourceJudgment(project, {
    sourceType: 'ai',
    sourceLabel: 'AI synthesis of interview notes',
    sourceReference: 'interview:writing-01',
    statement: 'Diagnose structural problems before editing individual sentences.',
    rationale: 'Sentence polishing cannot repair a missing argument or an incoherent sequence.',
    appliesWhen: ['Reviewing the structure of a long-form article'],
    doesNotApplyWhen: ['The request is limited to spelling or punctuation'],
    failureRisk: 'A structural review may exceed the requested editing scope.',
    ...overrides,
  });
}

test('the public package root exposes the admitted authoring primitives', () => {
  for (const name of [
    'project',
    'cards',
    'compile',
    'evidence',
    'distillation',
    'exportRuntime',
    'protocolContract',
    'authoring',
  ]) {
    assert.ok(studio[name], `missing Studio public primitive: ${name}`);
  }
  for (const name of [
    'quality',
    'governance',
    'testlab',
    'feynman',
    'pipeline',
    'packaging',
  ]) {
    assert.equal(studio[name], undefined, `experimental workshop leaked from package root: ${name}`);
  }
});

test('source -> review -> confirm -> export preserves provenance and boundaries', () => {
  const project = studio.authoring.createProject('@example/writing-judgment', {
    version: '0.1.0',
  });
  const card = addJudgment(project);

  assert.throws(
    () => studio.authoring.exportRuntimeAsset(project),
    /review is missing/,
  );

  studio.authoring.reviewJudgment(project, card.id, {
    by: 'reviewer-01',
    statement: 'I checked the source, judgment, scope, boundary, and risk.',
  });
  studio.authoring.confirmJudgment(project, card.id, {
    by: 'reviewer-01',
    statement: 'I confirm this judgment for the declared scope.',
  });

  const exported = studio.authoring.exportRuntimeAsset(project, {
    asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000401',
    timestamp: '2026-07-20T00:00:00.000Z',
  });
  const axiom = cbor.decode(exported.files['payload.kdnab']).core.axioms[0];
  assert.deepEqual(axiom.source_provenance, {
    type: 'ai',
    label: 'AI synthesis of interview notes',
    reference: 'interview:writing-01',
  });
  assert.deepEqual(axiom.applies_when, ['Reviewing the structure of a long-form article']);
  assert.deepEqual(axiom.does_not_apply_when, ['The request is limited to spelling or punctuation']);
  assert.equal(axiom.failure_risk, 'A structural review may exceed the requested editing scope.');
});

test('AI-derived content cannot claim a person or organization without matching confirmation', () => {
  const project = studio.authoring.createProject('@example/represented-judgment');
  const card = addJudgment(project, {
    represents: { type: 'person', id: 'author-01', name: 'Author' },
  });
  studio.authoring.reviewJudgment(project, card.id, {
    by: 'reviewer-01',
    statement: 'I reviewed the AI synthesis against the supplied source.',
  });

  assert.throws(
    () => studio.authoring.confirmJudgment(project, card.id, {
      by: 'reviewer-01',
      subjectId: 'someone-else',
      statement: 'I confirm this as the subject judgment.',
    }),
    /does not match represented subject author-01/,
  );

  studio.authoring.confirmJudgment(project, card.id, {
    by: 'reviewer-01',
    subjectId: 'author-01',
    statement: 'The represented subject confirms this scoped judgment.',
  });
  const exported = studio.authoring.exportRuntimeAsset(project, {
    asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000402',
    timestamp: '2026-07-20T00:00:00.000Z',
  });
  const axiom = cbor.decode(exported.files['payload.kdnab']).core.axioms[0];
  assert.equal(axiom.representation.status, 'confirmed');
  assert.equal(axiom.human_lock.by, 'reviewer-01');
});

test('source identity is explicit and never defaults to AI or a human owner', () => {
  const project = studio.authoring.createProject('@example/source-required');
  assert.throws(() => addJudgment(project, { sourceType: undefined }), /sourceType is required/);
  assert.throws(() => addJudgment(project, { sourceType: 'unknown' }), /sourceType must be one of/);
  const legacyDraft = studio.cards.createCard('axiom');
  assert.equal(legacyDraft.audit_log[0].by, 'unspecified-source');
});
