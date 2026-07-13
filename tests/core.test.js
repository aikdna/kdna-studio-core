const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createProject, validateProject } = require('../src/project');
const { createCard, lockCard, getLockedCards, transitionCard, CARD_TYPES } = require('../src/cards');
const { compileDomain } = require('../src/compile');
const { computeReadiness } = require('../src/quality');
const { buildProvenance } = require('../src/provenance');

// ─── Project ──────────────────────────────────────────────────────────

test('createProject returns valid project', () => {
  const p = createProject('test_domain');
  assert.equal(p.name, 'test_domain');
  assert.equal(p.type, 'domain');
  assert.equal(p.status, 'drafting');
  assert.ok(p.project_id);
  assert.ok(Array.isArray(p.cards));
});

test('validateProject catches missing name', () => {
  const r = validateProject({ type: 'domain', cards: [] });
  assert.equal(r.valid, false);
  assert.ok(r.issues.length > 0);
});

test('validateProject accepts every Studio card type', () => {
  const p = createProject('all_types');
  p.cards = CARD_TYPES.map((type) => createCard(type, {}, `${type}_test`));
  const r = validateProject(p);
  assert.equal(r.valid, true, r.issues.join('\n'));
});

// ─── Cards State Machine ──────────────────────────────────────────────

test('createCard returns draft card', () => {
  const card = createCard('axiom', { one_sentence: 'Test axiom' });
  assert.equal(card.status, 'draft');
  assert.equal(card.locked, false);
  assert.equal(card.type, 'axiom');
});

test('transitionCard: draft → revised', () => {
  const card = createCard('axiom', {});
  const result = transitionCard(card, 'revised', { by: 'test_user' });
  assert.equal(result.status, 'revised');
});

test('transitionCard blocks draft → locked', () => {
  const card = createCard('axiom', {});
  assert.throws(() => transitionCard(card, 'locked'), /Invalid transition/);
});

test('lockCard sets human_lock and transitions to locked', () => {
  let card = createCard('axiom', { one_sentence: 'Test', full_statement: 'A complete testable explanation with enough detail for the agent.', why: 'Without this the agent would make wrong calls.' });
  card = transitionCard(card, 'revised', { by: 'test_user' });
  card = lockCard(card, {
    by: 'test_user',
    statement: 'I confirm this judgment.',
    checked: { applies_when: true, does_not_apply_when: true, failure_risk: true },
  });
  assert.equal(card.status, 'locked');
  assert.equal(card.locked, true);
  assert.ok(card.human_lock);
  assert.equal(card.human_lock.by, 'test_user');
});

test('lockCard rejects missing checked fields', () => {
  let card = createCard('axiom', {});
  card = transitionCard(card, 'revised', { by: 'test_user' });
  assert.throws(() => lockCard(card, { by: 'u', statement: 'ok', checked: {} }), /applies_when/);
});

test('getLockedCards filters correctly', () => {
  const project = { cards: [] };
  let c1 = createCard('axiom', { full_statement: 'A complete testable explanation for the agent to use.', why: 'This prevents the agent from making wrong calls.' });
  c1 = transitionCard(c1, 'revised', { by: 'u' });
  c1 = lockCard(c1, { by: 'u', statement: 'ok', checked: { applies_when: true, does_not_apply_when: true, failure_risk: true } });
  project.cards.push(c1);
  project.cards.push(createCard('misunderstanding', {})); // draft
  assert.equal(getLockedCards(project).length, 1);
});

// ─── Compile ──────────────────────────────────────────────────────────

test('compileDomain includes non-deprecated cards and reports review provenance separately', () => {
  const project = createProject('test');
  let card = createCard('axiom', {
    one_sentence: 'Test axiom.',
    full_statement: 'A complete testable explanation of the judgment principle.',
    why: 'Without this axiom the agent makes wrong calls.',
    applies_when: ['when testing'],
    does_not_apply_when: ['when not testing'],
    failure_risk: 'Test may fail.',
  });
  card = transitionCard(card, 'revised', { by: 'u' });
  card = lockCard(card, { by: 'u', statement: 'ok', checked: { applies_when: true, does_not_apply_when: true, failure_risk: true } });
  project.cards = [card, createCard('axiom', { one_sentence: 'Draft axiom' })];

  const result = compileDomain(project);
  assert.ok('KDNA_Core.json' in result.files);
  assert.ok('KDNA_CARD.json' in result.files);
  const kdnaCard = JSON.parse(result.files['KDNA_CARD.json']);
  assert.equal(kdnaCard.name, 'test');
  assert.equal(kdnaCard.human_lock_summary.locked_cards, 1);
  assert.equal(result.stats.locked_cards, 1);
  assert.equal(result.stats.compiled_cards, 2);
  assert.equal(result.stats.excluded_cards, 0);
  const core = JSON.parse(result.files['KDNA_Core.json']);
  assert.equal(core.axioms.length, 2);
});

// ─── Quality ──────────────────────────────────────────────────────────

test('computeReadiness empty project → draft_grade', () => {
  const r = computeReadiness({ cards: [], tests: [] });
  assert.equal(r.grade, 'draft_grade');
  assert.equal(r.publishable, false);
});

test('computeReadiness locked cards → human_controlled', () => {
  const project = createProject('test');
  let card = createCard('axiom', {
    one_sentence: 'Test.',
    full_statement: 'When testing this principle, the agent should apply specific judgment rules.',
    why: 'Without this axiom the agent would produce incorrect and misleading results.',
    applies_when: ['when test'],
    does_not_apply_when: ['when not test'],
    failure_risk: 'risk',
  });
  card = transitionCard(card, 'revised', { by: 'u' });
  card = lockCard(card, { by: 'u', statement: 'ok', checked: { applies_when: true, does_not_apply_when: true, failure_risk: true } });
  project.cards = [card];
  const r = computeReadiness(project);
  assert.equal(r.grade, 'draft_grade'); // still need 3 locked cards for human_controlled
  assert.ok(r.warnings.length > 0);
});

// ─── Provenance ───────────────────────────────────────────────────────

test('buildProvenance returns metadata', () => {
  const project = createProject('test', 'domain', { author: { name: 'Tester', id: 'tester' } });
  project.cards = [];
  const prov = buildProvenance(project, {});
  assert.equal(prov.studio_core, 'aikdna/kdna-studio-core');
  assert.ok(prov.build_id);
  assert.ok(prov.content_fingerprint);
});
