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

test('compileDomain refuses domain with only draft (unlocked) cards', () => {
  const project = makeProject('test');
  project.cards = [
    createCard('axiom', { one_sentence: 'Draft', full_statement: 'x', why: 'x' }),
    createCard('boundary', { scope: 'x', out_of_scope: 'y' }),
  ];
  assert.throws(
    () => compileDomain(project),
    (e) => e.code === 'EMPTY_DOMAIN',
  );
});

test('compileDomain refuses domain with locked non-judgment cards only', () => {
  // A locked 'term' or 'framework' is structural metadata, not a judgment.
  // The gate requires at least one locked card of a judgment-bearing type.
  const project = makeProject('test');
  const term = createCard('term', { term: 'x', definition: 'y' });
  term.locked = true; // bypass state machine to simulate buggy upstream
  project.cards = [term];
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
