const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createProject } = require('../src/project');
const { createCard, lockCard, transitionCard } = require('../src/cards');
const { parseCompareOutput, createJudgmentDelta, compareDeltas, formatDeltaMarkdown, scoreDelta } = require('../src/testlab/delta');
const { diffProjects, recommendVersionBump, generateChangelog, bumpVersion, markBreakingChange } = require('../src/versioning');

function makeLockedCard(type, fields, id) {
  const f = { ...fields };
  if (type === 'axiom') {
    if (!f.full_statement || f.full_statement.length < 20) f.full_statement = 'A complete testable explanation of this judgment principle with sufficient detail for the agent.';
    if (!f.why || f.why.length < 20) f.why = 'Without this axiom the agent would make incorrect judgment calls producing wrong outputs.';
  }
  let card = createCard(type, f, id);
  card = transitionCard(card, 'revised', { by: 'tester' });
  card = lockCard(card, { by: 'tester', statement: 'ok', checked: { applies_when: true, does_not_apply_when: true, failure_risk: true } });
  return card;
}

// ─── Judgment Delta ──────────────────────────────────────────────────

describe('Judgment Delta', () => {
  const DIFF_TEXT = `1. CLASSIFICATION: language_polishing → structural_diagnosis
2. DIAGNOSIS: The root cause was identified as a missing argument rather than poor wording.
3. ACTIONS: Suggested deletion more than rewriting — structural fix, not surface polish.
4. BOUNDARY AWARENESS: SAME
5. TERMINOLOGY: Used domain-specific terms like judgment_pressure and cognitive_hook.
VERDICT: trajectory_changed`;

  test('parseCompareOutput extracts axes', () => {
    const result = parseCompareOutput(DIFF_TEXT);
    assert.equal(result.verdict, 'trajectory_changed');
    assert.ok(result.axes.classification);
    assert.ok(result.axes.diagnosis);
    assert.ok(result.axes.actions);
    assert.ok(!result.axes.boundary_awareness); // SAME → omitted
  });

  test('scoreDelta counts changed axes', () => {
    const axes = { classification: 'changed', diagnosis: 'changed', terminology: 'changed' };
    const result = scoreDelta(axes);
    assert.equal(result.score, 8); // 5 + 3
    assert.equal(result.changed.length, 3);
  });

  test('createJudgmentDelta builds full report', () => {
    const delta = createJudgmentDelta('@aikdna/writing', 'Help me improve this post',
      'Generic response...', 'Domain-specific response...', DIFF_TEXT,
      { model: 'claude-sonnet-4-5', triggeredAxioms: ['ax_001'], selfChecksPassed: 5 }
    );
    assert.equal(delta.meta.domain, '@aikdna/writing');
    assert.equal(delta.verdict, 'trajectory_changed');
    assert.ok(delta.score >= 8);
    assert.ok(delta.summary.includes('dimensions'));
    assert.ok(delta.scoring.D1_diagnostic_depth >= 5);
  });

  test('createJudgmentDelta handles no-change verdict', () => {
    const noChangeText = '1. CLASSIFICATION: SAME\n2. DIAGNOSIS: SAME\nVERDICT: trajectory_unchanged';
    const delta = createJudgmentDelta('test', 'input', 'a', 'b', noChangeText);
    assert.equal(delta.verdict, 'trajectory_unchanged');
    assert.equal(delta.score, 5);
    assert.ok(delta.summary.includes('did not significantly alter'));
  });

  test('compareDeltas shows improvement', () => {
    const d1 = createJudgmentDelta('test', 'input', 'a', 'b', DIFF_TEXT);
    const betterText = DIFF_TEXT.replace('SAME', 'Improved boundary awareness with explicit scope limits');
    const d2 = createJudgmentDelta('test', 'input', 'a', 'b', betterText);
    const cmp = compareDeltas(d1, d2);
    assert.ok(cmp.improved);
  });

  test('formatDeltaMarkdown produces readable report', () => {
    const delta = createJudgmentDelta('@aikdna/writing', 'test input', 'a', 'b', DIFF_TEXT);
    const md = formatDeltaMarkdown(delta);
    assert.ok(md.includes('# KDNA Judgment Comparison Report'));
    assert.ok(md.includes('## Judgment Diff'));
    assert.ok(md.includes('## Scoring'));
    assert.ok(md.includes('Verdict'));
  });

  test('parseCompareOutput handles legacy format', () => {
    const legacyText = 'classification: changed\nterminology: domain_specific\nVERDICT: trajectory_changed';
    const result = parseCompareOutput(legacyText);
    assert.equal(result.verdict, 'trajectory_changed');
    assert.ok(result.axes.classification);
  });
});

// ─── Versioning ──────────────────────────────────────────────────────

describe('Versioning', () => {
  test('diffProjects detects added cards', () => {
    const oldProject = createProject('test');
    const newProject = createProject('test');
    newProject.cards = [makeLockedCard('axiom', { one_sentence: 'New axiom.' }, 'ax_001')];
    const diff = diffProjects(oldProject, newProject);
    assert.equal(diff.added.length, 1);
    assert.equal(diff.removed.length, 0);
  });

  test('diffProjects detects removed cards', () => {
    const oldProject = createProject('test');
    oldProject.cards = [makeLockedCard('axiom', { one_sentence: 'Old.' }, 'ax_001')];
    const newProject = createProject('test');
    const diff = diffProjects(oldProject, newProject);
    assert.equal(diff.removed.length, 1);
  });

  test('diffProjects detects changed fields', () => {
    const oldProject = createProject('test');
    oldProject.cards = [makeLockedCard('axiom', { one_sentence: 'Old text.', full_statement: 'Old full.' }, 'ax_001')];
    const newProject = createProject('test');
    newProject.cards = [makeLockedCard('axiom', { one_sentence: 'New text.', full_statement: 'New full.' }, 'ax_001')];
    const diff = diffProjects(oldProject, newProject);
    assert.equal(diff.changed.length, 1);
    assert.ok(diff.changed[0].changes.one_sentence);
  });

  test('recommendVersionBump: MAJOR for removed axiom', () => {
    const diff = { added: [], removed: [{ type: 'axiom' }], changed: [], summary: { added_count: 0, removed_count: 1, changed_count: 0 } };
    assert.equal(recommendVersionBump(diff), 'major');
  });

  test('recommendVersionBump: MINOR for added axiom', () => {
    const diff = { added: [{ type: 'axiom' }], removed: [], changed: [], summary: { added_count: 1, removed_count: 0, changed_count: 0 } };
    assert.equal(recommendVersionBump(diff), 'minor');
  });

  test('recommendVersionBump: MINOR for changed fields', () => {
    const diff = { added: [], removed: [], changed: [{ type: 'axiom', changes: { one_sentence: { before: 'old', after: 'new' } } }], summary: { added_count: 0, removed_count: 0, changed_count: 1 } };
    assert.equal(recommendVersionBump(diff), 'major'); // axiom core meaning change → major
  });

  test('bumpVersion increments correctly', () => {
    assert.equal(bumpVersion('0.1.0', 'patch'), '0.1.1');
    assert.equal(bumpVersion('0.1.0', 'minor'), '0.2.0');
    assert.equal(bumpVersion('0.1.0', 'major'), '1.0.0');
    assert.equal(bumpVersion('2.3.5', 'none'), '2.3.5');
  });

  test('generateChangelog produces markdown', () => {
    const oldProject = createProject('test');
    const newProject = createProject('test');
    newProject.cards = [makeLockedCard('axiom', { one_sentence: 'New axiom for agent judgment.' }, 'ax_001')];
    const diff = diffProjects(oldProject, newProject);
    const changelog = generateChangelog(diff, '0.1.0', '0.2.0', { domain: 'test' });
    assert.ok(changelog.includes('# test 0.2.0'));
    assert.ok(changelog.includes('MINOR'));
    assert.ok(changelog.includes('ax_001'));
  });

  test('markBreakingChange detects axiom removal', () => {
    const diff = { added: [], removed: [{ type: 'axiom' }], changed: [], summary: { added_count: 0, removed_count: 1, changed_count: 0 } };
    const result = markBreakingChange(diff);
    assert.equal(result.breaking, true);
    assert.ok(result.reason.includes('breaking change'));
  });
});
