/**
 * Tests for the Source Authority Graph (SAG) and Truth Charter (TC)
 * compile gates in kdna-studio-core (RFC-0013 §3.1/§3.2/§9 #3).
 *
 * Run: node --test tests/compile-gates.test.js
 *
 * Test plan (per PR-3 spec):
 *   1. legacy workspace without SAG/TC: default mode passes
 *   2. legacy workspace without SAG/TC: strict-authority passes (no
 *      objects => skip)
 *   3. SAG present but no current_highest: strict-authority errors
 *   4. current_highest is a deprecated source: strict-authority errors
 *   5. TC status: synthesized: strict-authority errors
 *   6. TC status: locked: strict-authority passes
 *   7. TC renamed_terms inconsistent with terminology: warning only
 *   8. SAG precedence_order references unknown id: errors
 *   9. Default mode: same problems as #3-#8 are warnings, not errors
 *  10. Output is structured and JSON-serializable
 *
 * Plus: cross-file consistency (SAG has human_locked_charter highest
 *       + TC present but judgment_authority_holder missing).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProject } = require('../src/project');
const { createCard, transitionCard, lockCard } = require('../src/cards');
const { compileDomain } = require('../src/compile');

function makeMinimalProject(name = 'test') {
  const project = createProject(name);
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
  project.cards = [card];
  return project;
}

function makeSag(overrides = {}) {
  return {
    sag_id: 'sag_test_1',
    domain_id: '@test/test',
    version_intent: '0.1.0',
    sources: [
      {
        id: 's_baseline',
        type: 'published_work',
        authority: 'historical_baseline',
        status: 'active',
        can_override: false,
        scope: 'full',
      },
      {
        id: 's_charter',
        type: 'human_locked_charter',
        authority: 'current_highest',
        status: 'active',
        can_override: true,
        scope: 'axioms_and_ontology',
      },
    ],
    precedence_order: ['s_charter', 's_baseline'],
    ...overrides,
  };
}

function makeTc(overrides = {}) {
  return {
    tc_id: 'tc_test_1',
    domain_id: '@test/test',
    tc_status: 'locked',
    locked_at: '2026-06-14T00:00:00Z',
    locked_by: 'tester',
    highest_question: 'How do we test?',
    core_insight: 'We test by writing assertions.',
    in_scope: ['assertions'],
    out_of_scope: ['manual click-testing'],
    highest_axiom_protected: 'We test by writing assertions.',
    forbidden_simplifications: ['assertions are not real tests'],
    renamed_terms: [],
    anti_drift_rules: ['never run tests manually'],
    judgment_authority_holder: 'tester',
    ...overrides,
  };
}

test('1. legacy workspace without SAG/TC: default mode passes (gate skipped)', () => {
  const project = makeMinimalProject();
  const result = compileDomain(project);
  assert.ok(result.files);
  assert.ok(result.gates);
  assert.equal(result.gates.sag.status, 'skipped');
  assert.equal(result.gates.tc.status, 'skipped');
  assert.equal(result.gates.strict_authority, false);
});

test('2. legacy workspace without SAG/TC: strict-authority passes (no objects to fail on)', () => {
  const project = makeMinimalProject();
  const result = compileDomain(project, { strictAuthority: true });
  assert.equal(result.gates.sag.status, 'skipped');
  assert.equal(result.gates.tc.status, 'skipped');
  assert.equal(result.gates.strict_authority, true);
});

test('3. SAG present but no current_highest: strict-authority throws', () => {
  const project = makeMinimalProject();
  const sag = makeSag();
  // remove the current_highest source
  sag.sources = sag.sources.filter((s) => s.authority !== 'current_highest');
  assert.throws(
    () => compileDomain(project, { sourceAuthority: sag, strictAuthority: true }),
    /no source has authority "current_highest"/,
  );
});

test('4. current_highest is a deprecated source: strict-authority throws', () => {
  const project = makeMinimalProject();
  const sag = makeSag({
    sources: [
      {
        id: 's_charter',
        type: 'human_locked_charter',
        authority: 'current_highest',
        status: 'deprecated', // bad: current_highest cannot be deprecated
        can_override: true,
        scope: 'axioms_and_ontology',
      },
    ],
    precedence_order: ['s_charter'],
  });
  assert.throws(
    () => compileDomain(project, { sourceAuthority: sag, strictAuthority: true }),
    /status is "deprecated"|authority "deprecated"/,
  );
});

test('5. TC status: synthesized: strict-authority throws', () => {
  const project = makeMinimalProject();
  const tc = makeTc({ tc_status: 'synthesized' });
  delete tc.locked_at;
  delete tc.locked_by;
  assert.throws(
    () => compileDomain(project, { truthCharter: tc, strictAuthority: true }),
    /tc_status is "synthesized"/,
  );
});

test('6. TC status: locked: strict-authority passes', () => {
  const project = makeMinimalProject();
  const tc = makeTc({ tc_status: 'locked' });
  const result = compileDomain(project, { truthCharter: tc, strictAuthority: true });
  assert.equal(result.gates.tc.status, 'pass');
});

test('7. TC renamed_terms inconsistent with terminology: warning, not error', () => {
  const project = makeMinimalProject();
  const tc = makeTc({
    renamed_terms: [
      { old: 'old_term_xyz', new: 'new_term_xyz', effective_from: '1.0.0' },
    ],
  });
  // No patterns provided, so rename-soft-check has nothing to compare to;
  // the gate should still pass (status: pass, no warnings) when there
  // is no patterns object.
  const result = compileDomain(project, { truthCharter: tc });
  assert.equal(result.gates.tc.status, 'pass');
});

test('7b. TC renamed_terms inconsistent with provided patterns: warning, not error', () => {
  const project = makeMinimalProject();
  const tc = makeTc({
    renamed_terms: [
      { old: 'old_term_xyz', new: 'new_term_xyz', effective_from: '1.0.0' },
    ],
  });
  // patterns.terminology exists but does not include the renamed terms
  const patterns = {
    terminology: {
      standard_terms: [{ term: 'other_term', definition: 'x' }],
      banned_terms: [{ term: 'another_term', why: 'r', replace_with: 'other_term' }],
    },
  };
  // Inject patterns by calling compileDomain and then re-running the
  // gate with patterns. (compileDomain reads patterns from cards, not
  // from an options field, so test the gate directly here.)
  const { runTcGate } = require('../src/compile');
  const result = runTcGate(tc, { strict: false, patterns });
  // Soft-check should produce warnings.
  assert.ok(result.warnings.length >= 1, 'expected at least one warning');
  // But no errors.
  assert.equal(result.errors.length, 0);
  assert.equal(result.status, 'warn');
});

test('8. SAG precedence_order references unknown source id: errors', () => {
  const project = makeMinimalProject();
  const sag = makeSag();
  sag.precedence_order = ['s_charter', 's_nonexistent'];
  assert.throws(
    () => compileDomain(project, { sourceAuthority: sag, strictAuthority: true }),
    /unknown source id/,
  );
});

test('9. default mode: same problems (#3, #5, #8) are warnings, not errors', () => {
  const project = makeMinimalProject();
  // #3: no current_highest
  const sagNoHighest = makeSag();
  sagNoHighest.sources = sagNoHighest.sources.filter((s) => s.authority !== 'current_highest');
  // #5: synthesized TC
  const tcSynth = makeTc({ tc_status: 'synthesized' });
  delete tcSynth.locked_at;
  delete tcSynth.locked_by;
  // #8: unknown id in precedence_order
  const sagUnknown = makeSag();
  sagUnknown.precedence_order = ['s_charter', 's_unknown_id'];

  // Each one in isolation: default mode should NOT throw.
  const r1 = compileDomain(project, { sourceAuthority: sagNoHighest });
  assert.equal(r1.gates.sag.status, 'warn');
  assert.equal(r1.gates.sag.errors.length, 0);
  assert.ok(r1.gates.sag.warnings.length >= 1);

  const r2 = compileDomain(project, { truthCharter: tcSynth });
  assert.equal(r2.gates.tc.status, 'warn');
  assert.equal(r2.gates.tc.errors.length, 0);
  assert.ok(r2.gates.tc.warnings.length >= 1);

  const r3 = compileDomain(project, { sourceAuthority: sagUnknown });
  // Default mode: rule violations are warnings, not errors.
  // status is "warn" (not "fail"); no errors; at least one warning.
  assert.equal(r3.gates.sag.errors.length, 0);
  assert.equal(r3.gates.sag.status, 'warn');
  assert.ok(r3.gates.sag.warnings.length >= 1);
});

test('10. output is structured and JSON-serializable', () => {
  const project = makeMinimalProject();
  const sag = makeSag();
  const tc = makeTc();
  const result = compileDomain(project, { sourceAuthority: sag, truthCharter: tc });
  // Top-level shape
  assert.equal(typeof result, 'object');
  assert.equal(typeof result.gates, 'object');
  assert.equal(typeof result.gates.sag, 'object');
  assert.equal(typeof result.gates.tc, 'object');
  // Each gate has the documented fields
  for (const g of [result.gates.sag, result.gates.tc]) {
    assert.equal(typeof g.gate, 'string');
    assert.equal(typeof g.status, 'string');
    assert.ok(Array.isArray(g.errors));
    assert.ok(Array.isArray(g.warnings));
    assert.equal(typeof g.strict_authority, 'boolean');
  }
  // Full JSON round-trip
  const json = JSON.stringify(result.gates);
  const parsed = JSON.parse(json);
  assert.equal(parsed.sag.gate, 'source_authority');
  assert.equal(parsed.tc.gate, 'truth_charter');
});

test('11. cross-file consistency: SAG human_locked_charter + TC missing judgment_authority_holder', () => {
  const project = makeMinimalProject();
  const sag = makeSag(); // has human_locked_charter current_highest
  const tc = makeTc({ judgment_authority_holder: '' });
  assert.throws(
    () => compileDomain(project, { sourceAuthority: sag, truthCharter: tc, strictAuthority: true }),
    /judgment_authority_holder is missing or empty/,
  );
});

test('12. lower-authority source before current_highest in precedence_order: errors', () => {
  const project = makeMinimalProject();
  // precedence_order is highest-precedence-first, so a lower-authority
  // source placed BEFORE a current_highest source means the lower
  // source effectively overrides the higher one. That is a contract
  // violation.
  const sag = {
    sag_id: 'sag_xyz',
    domain_id: '@test/test',
    version_intent: '0.1.0',
    sources: [
      { id: 's_a', type: 'published_work', authority: 'thought_mine', status: 'active', can_override: false, scope: 'full' },
      { id: 's_b', type: 'human_locked_charter', authority: 'current_highest', status: 'active', can_override: true, scope: 'full' },
    ],
    precedence_order: ['s_a', 's_b'],
  };
  assert.throws(
    () => compileDomain(project, { sourceAuthority: sag, strictAuthority: true }),
    /lower-authority source .* (appears before|appears after) current_highest/,
  );
});
