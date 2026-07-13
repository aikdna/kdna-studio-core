const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createProject, createCard, transitionCard, lockCard } = require('../src/cards');
const { createProject: makeProject } = require('../src/project');
const { compileDomain } = require('../src/compile');

function lockedAxiom() {
  let card = createCard('axiom', {
    one_sentence: 'Test axiom.',
    full_statement: 'A complete testable explanation of the judgment principle.',
    why: 'Without this axiom the agent makes wrong calls.',
    applies_when: ['when testing'],
    does_not_apply_when: ['when not testing'],
    failure_risk: 'Test may fail.',
  });
  card = transitionCard(card, 'revised', { by: 'u' });
  card = lockCard(card, {
    by: 'u',
    statement: 'ok',
    checked: { applies_when: true, does_not_apply_when: true, failure_risk: true },
  });
  return card;
}

// PR-2: empty-domain gate. Without this, compileDomain would return a
// "successful" result with payload.kdnab carrying empty judgment, which
// downstream Registry / Lab / Studio would happily advertise.

test('compileDomain refuses empty domain (no cards)', () => {
  const project = makeProject('test');
  assert.throws(
    () => compileDomain(project),
    (e) => e.code === 'EMPTY_DOMAIN',
  );
});

test('compileDomain accepts draft cards because review evidence is optional', () => {
  const project = makeProject('test');
  project.cards = [
    createCard('axiom', { one_sentence: 'Draft', full_statement: 'x', why: 'x' }),
    createCard('boundary', { scope: 'x', out_of_scope: 'y' }),
  ];
  const result = compileDomain(project);
  assert.equal(result.stats.compiled_cards, 2);
  assert.equal(result.stats.locked_cards, 0);
});

test('compileDomain refuses domain with no judgment-bearing cards', () => {
  // A project that has only cards of types the gate considers structural
  // (e.g. an unsupported future type) should still trip the empty-domain
  // guard. We construct a card object directly because createCard rejects
  // unknown types. Bug (2026-06-28 audit follow-up): the prior version of
  // this test relied on `term` being excluded, but `term` is now treated
  // as judgment-bearing alongside framework/reasoning/evolution_stage.
  const project = makeProject('test');
  const ghost = { id: 'gh_1', type: 'unsupported_metadata', locked: true, fields: {} };
  project.cards = [ghost];
  assert.throws(
    () => compileDomain(project),
    (e) => e.code === 'EMPTY_DOMAIN',
  );
});

test('compileDomain accepts domain with at least one locked judgment card', () => {
  const project = makeProject('test');
  project.cards = [lockedAxiom()];
  const result = compileDomain(project);
  assert.ok(result.files);
  assert.ok(result.files['payload.kdnab']);
});
