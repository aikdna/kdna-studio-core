const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createProject, checkHumanLockGate, exportProject } = require('../src/project');
const { createCard, lockCard, transitionCard } = require('../src/cards');
const { cardJudgmentFingerprint } = require('../src/judgment-fields');

// ─── Human Lock Gate ──────────────────────────────────────────────────

test('checkHumanLockGate: empty project has no issues (no judgment cards)', () => {
  const p = createProject('test');
  const gate = checkHumanLockGate(p);
  assert.equal(gate.blocked, false);
  assert.equal(gate.issues.length, 0);
});

test('checkHumanLockGate: blocks when axiom is not approved for Studio export', () => {
  const p = createProject('test');
  p.cards.push(createCard('axiom', { one_sentence: 'Test axiom', full_statement: 'Full.', why: 'Reason.' }));
  const gate = checkHumanLockGate(p);
  assert.equal(gate.blocked, true);
  assert.ok(gate.issues.some(i => i.reason.includes('not approved for Studio export')));
});

test('checkHumanLockGate: blocks when locked axiom has no human_lock record', () => {
  const p = createProject('test');
  const card = createCard('axiom', { one_sentence: 'Test axiom', full_statement: 'Full.', why: 'Reason.' });
  card.status = 'locked'; // Simulate locked without actual lockCard() call
  card.locked = true;
  p.cards.push(card);
  const gate = checkHumanLockGate(p);
  assert.equal(gate.blocked, true);
  assert.ok(gate.issues.some(i => i.reason.includes('no valid Human Lock')));
});

test('checkHumanLockGate: passes when axiom is properly locked', () => {
  const p = createProject('test');
  let card = createCard('axiom', { one_sentence: 'Test', full_statement: 'A complete testable explanation of this judgment principle for the agent.', why: 'Without this the agent would make wrong judgment calls.' });
  card = transitionCard(card, 'revised', { by: 'tester' });
  card = lockCard(card, {
    by: 'tester',
    statement: 'I confirm this judgment is correct.',
    checked: { applies_when: true, does_not_apply_when: true, failure_risk: true },
  });
  p.cards.push(card);
  const gate = checkHumanLockGate(p);
  assert.equal(gate.blocked, false);
  assert.equal(gate.issues.length, 0);
  assert.equal(gate.lockedJudgmentCards, 1);
});

test('checkHumanLockGate: blocks missing applies_when check', () => {
  const p = createProject('test');
  let card = createCard('axiom', { one_sentence: 'Test', full_statement: 'Full.', why: 'Because.' });
  card = transitionCard(card, 'revised', { by: 'tester' });
  // Calling lockCard with checked.applies_when = false should fail
  assert.throws(() => {
    lockCard(card, {
      by: 'tester',
      statement: 'I confirm.',
      checked: { applies_when: false, does_not_apply_when: true, failure_risk: true },
    });
  }, /applies_when/);
});

test('checkHumanLockGate: boundary card requires lock', () => {
  const p = createProject('test');
  const card = createCard('boundary', { out_of_scope: 'Not this.' });
  p.cards.push(card);
  const gate = checkHumanLockGate(p);
  assert.equal(gate.blocked, true);
  assert.ok(gate.issues.some(i => i.type === 'boundary'));
});

test('checkHumanLockGate: risk card requires lock', () => {
  const p = createProject('test');
  const card = createCard('risk', { failure_risk: 'Data loss.' });
  p.cards.push(card);
  const gate = checkHumanLockGate(p);
  assert.equal(gate.blocked, true);
  assert.ok(gate.issues.some(i => i.type === 'risk'));
});

test('checkHumanLockGate: all 16 judgment card types block when not locked', () => {
  // Bug #23 follow-up: prior version only treated 4 types (axiom /
  // boundary / risk / aesthetic) as judgment-bearing. The audit
  // expanded the set to all 16 CARD_TYPES, so the gate now blocks
  // self_check / case / scenario too. This test exercises one
  // representative of each of the other 12 to lock that in.
  const types = [
    'axiom', 'boundary', 'risk', 'aesthetic',
    'ontology', 'misunderstanding', 'self_check', 'scenario', 'case',
    'stance', 'pattern', 'reasoning', 'framework',
    'term', 'banned_term', 'evolution_stage',
  ];
  for (const t of types) {
    const p = createProject(`test-${t}`);
    p.cards.push(createCard(t, {}));
    const gate = checkHumanLockGate(p);
    assert.equal(gate.blocked, true, `expected type "${t}" to block the gate`);
  }
});

// ─── exportProject Human Lock enforcement ────────────────────────────

test('exportProject: allows unreviewed cards without claiming Human Lock passed', () => {
  const p = createProject('test');
  p.cards.push(createCard('axiom', { one_sentence: 'Test axiom' }));
  const parsed = JSON.parse(exportProject(p));
  assert.equal(parsed.release.locked_judgment_cards, 0);
  assert.equal(parsed.release.human_lock_gate_passed, false);
  assert.throws(() => exportProject(p, { requireHumanLock: true }), /Human Lock Gate blocked export/);
});

test('exportProject: succeeds when properly locked', () => {
  const p = createProject('test');
  let card = createCard('axiom', { one_sentence: 'Test', full_statement: 'A complete testable explanation for the agent to apply.', why: 'Without this axiom the agent would produce wrong results.' });
  card = transitionCard(card, 'revised', { by: 'tester' });
  card = lockCard(card, {
    by: 'tester',
    statement: 'Confirmed.',
    checked: { applies_when: true, does_not_apply_when: true, failure_risk: true },
  });
  p.cards.push(card);
  const json = exportProject(p);
  assert.ok(typeof json === 'string');
  const parsed = JSON.parse(json);
  assert.equal(parsed.release.locked_judgment_cards, 1);
  assert.equal(parsed.release.human_lock_gate_passed, true);
});

test('exportProject: force override allows blocked export', () => {
  const p = createProject('test');
  p.cards.push(createCard('axiom', { one_sentence: 'Emergency fix' }));
  const json = exportProject(p, { requireHumanLock: true, force: true, forceReason: 'Critical security fix' });
  const parsed = JSON.parse(json);
  assert.ok(parsed._human_lock_override);
  assert.equal(parsed._human_lock_override.reason, 'Critical security fix');
  assert.equal(parsed.release.human_lock_gate_passed, true);
});

test('exportProject: reviewed-only mode blocks a partial Human Lock', () => {
  const p = createProject('test');

  // Properly locked axiom
  let ax = createCard('axiom', { one_sentence: 'Test 1', full_statement: 'A complete testable explanation for agent use.', why: 'Prevents incorrect agent judgment calls.' });
  ax = transitionCard(ax, 'revised', { by: 'tester' });
  ax = lockCard(ax, {
    by: 'tester', statement: 'OK',
    checked: { applies_when: true, does_not_apply_when: true, failure_risk: true },
  });
  p.cards.push(ax);

  // Unlocked boundary — should block
  p.cards.push(createCard('boundary', { out_of_scope: 'Not covered.' }));

  assert.doesNotThrow(() => exportProject(p));
  assert.throws(() => exportProject(p, { requireHumanLock: true }), /Human Lock Gate/);
});

// ─── cardJudgmentFingerprint ─────────────────────────────────────────

test('cardJudgmentFingerprint: produces stable hash for same content', () => {
  const card1 = createCard('axiom', { one_sentence: 'A', full_statement: 'B', why: 'C' });
  const card2 = createCard('axiom', { one_sentence: 'A', full_statement: 'B', why: 'C' });
  assert.equal(cardJudgmentFingerprint(card1), cardJudgmentFingerprint(card2));
});

test('cardJudgmentFingerprint: different content produces different hash', () => {
  const card1 = createCard('axiom', { one_sentence: 'A' });
  const card2 = createCard('axiom', { one_sentence: 'B' });
  assert.notEqual(cardJudgmentFingerprint(card1), cardJudgmentFingerprint(card2));
});

test('cardJudgmentFingerprint: covers every authored field, including nested protocol extensions', () => {
  const card1 = createCard('axiom', {
    one_sentence: 'A',
    source_refs: ['source:chapter-1'],
    protocol_extension: { relation: { from: 'ax_01', to: 'ax_02' } },
  });
  const changedReference = createCard('axiom', {
    one_sentence: 'A',
    source_refs: ['source:chapter-2'],
    protocol_extension: { relation: { from: 'ax_01', to: 'ax_02' } },
  });
  const changedRelation = createCard('axiom', {
    one_sentence: 'A',
    source_refs: ['source:chapter-1'],
    protocol_extension: { relation: { from: 'ax_02', to: 'ax_01' } },
  });
  assert.notEqual(cardJudgmentFingerprint(card1), cardJudgmentFingerprint(changedReference));
  assert.notEqual(cardJudgmentFingerprint(card1), cardJudgmentFingerprint(changedRelation));
});

test('cardJudgmentFingerprint: canonicalizes nested object keys without changing array order', () => {
  const card1 = createCard('reasoning', {
    tradeoffs: { reversibility: 'high', cost: 'low' },
    evidence_required: ['source:a', 'source:b'],
  });
  const sameContent = createCard('reasoning', {
    evidence_required: ['source:a', 'source:b'],
    tradeoffs: { cost: 'low', reversibility: 'high' },
  });
  const changedOrder = createCard('reasoning', {
    tradeoffs: { cost: 'low', reversibility: 'high' },
    evidence_required: ['source:b', 'source:a'],
  });
  assert.equal(cardJudgmentFingerprint(card1), cardJudgmentFingerprint(sameContent));
  assert.notEqual(cardJudgmentFingerprint(card1), cardJudgmentFingerprint(changedOrder));
});

test('checkHumanLockGate: detects judgment content changed after lock', () => {
  const p = createProject('test');
  let card = createCard('axiom', { one_sentence: 'Original', full_statement: 'A complete testable explanation as originally designed.', why: 'Without this the agent would produce incorrect results.' });
  card = transitionCard(card, 'revised', { by: 'tester' });
  card = lockCard(card, {
    by: 'tester', statement: 'Locked.',
    checked: { applies_when: true, does_not_apply_when: true, failure_risk: true },
  });
  // Simulate post-lock edit: change a judgment field
  card.fields.one_sentence = 'Modified after lock';
  p.cards.push(card);

  const gate = checkHumanLockGate(p);
  // The fingerprint should differ
  assert.ok(gate.issues.some(i => i.reason.includes('judgment fields changed')),
    'Must detect judgment field modification after lock');
});
