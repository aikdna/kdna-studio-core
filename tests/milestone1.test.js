const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createProject, validateProject } = require('../src/project');
const { createCard, lockCard, transitionCard } = require('../src/cards');
const {
  createFeynmanRestatement,
  attachRestatementToLock,
  validateRestatementCard,
  evaluateRestatementQuality,
} = require('../src/cards/feynman');
const { detectContradictions, summarizeContradictions } = require('../src/quality/contradiction');
const { computeReadiness } = require('../src/quality');
const { compileDomain } = require('../src/compile');
const { createEvidenceEntry, addEvidence, extractSpan, linkEvidenceToCard, getEvidenceForCard } = require('../src/evidence');
const { createTestCase, recordHumanRating, linkTestToCards, generateTestSummary, exportEvals } = require('../src/testlab');
const { buildProvenance } = require('../src/provenance');

function makeLockedCard(type, fields = {}, id = null) {
  const f = { ...fields };
  if (type === 'axiom') {
    if (!f.full_statement || f.full_statement.length < 20) f.full_statement = 'A complete testable explanation of this judgment principle with sufficient detail for the agent to apply it correctly in real scenarios.';
    if (!f.why || f.why.length < 20) f.why = 'Without this axiom the agent would make incorrect judgment calls resulting in poor outputs.';
  }
  let card = createCard(type, f, id);
  card = transitionCard(card, 'revised', { by: 'tester' });
  card = lockCard(card, {
    by: 'tester',
    statement: 'I confirm this judgment represents my understanding.',
    checked: { applies_when: true, does_not_apply_when: true, failure_risk: true },
  });
  return card;
}

// ─── Feynman Restatement ──────────────────────────────────────────────

describe('Feynman Restatement', () => {
  test('createFeynmanRestatement scores a good restatement', () => {
    let card = makeLockedCard('axiom', {
      one_sentence: 'Price objections are certainty deficits, not price problems.',
    });
    const text = 'When a customer says the price is too high, the agent should not immediately offer a discount. Instead, figure out which type of uncertainty is blocking them — value, risk, responsibility, or process. For example, if a client hesitates, ask what they are worried about rather than lowering the price.';
    const fr = createFeynmanRestatement(card, text);
    assert.ok(fr.text);
    assert.ok(fr.score);
    assert.equal(fr.score.quality, 'good');
    assert.equal(fr.score.not_just_repeat, true);
    assert.equal(fr.score.has_concrete_example, true);
    assert.equal(fr.score.clarifies_boundary, true);
  });

  test('createFeynmanRestatement detects just-repeating', () => {
    let card = makeLockedCard('axiom', {
      one_sentence: 'Clarity is the only thing a writer needs to worry about when creating content.',
    });
    const text = 'Clarity is the only thing a writer needs to worry about when creating content for readers.';
    const fr = createFeynmanRestatement(card, text);
    assert.equal(fr.score.not_just_repeat, false);
  });

  test('attachRestatementToLock links restatement to card', () => {
    let card = makeLockedCard('axiom', { one_sentence: 'Test.' });
    const fr = createFeynmanRestatement(card, 'A simple explanation with an example and a boundary: this only works when there is clear evidence, not when the situation is ambiguous.');
    attachRestatementToLock(card, fr);
    assert.ok(card.feynman_restatement);
    assert.equal(card.feynman_restatement.score.quality, 'good');
  });

  test('validateRestatementCard flags missing Feynman', () => {
    let card = makeLockedCard('axiom', { one_sentence: 'Test' });
    const issues = validateRestatementCard(card);
    assert.ok(issues.length > 0);
    assert.ok(issues.some(i => i.type === 'missing_feynman'));
  });
});

// ─── Contradiction Check ──────────────────────────────────────────────

describe('Contradiction Check', () => {
  test('detects missing does_not_apply_when on locked axiom', () => {
    let card = makeLockedCard('axiom', {
      one_sentence: 'Always trust the data.',
      full_statement: 'When making decisions, always defer to data.',
      applies_when: ['when data is available'],
      // missing does_not_apply_when
    });
    const issues = detectContradictions([card]);
    const boundary = issues.find(i => i.type === 'missing_boundary');
    assert.ok(boundary);
    assert.equal(boundary.severity, 'blocking');
  });

  test('detects over-generalized language', () => {
    let card = makeLockedCard('axiom', {
      one_sentence: 'Never accept user input without validation.',
      full_statement: 'All user input must always be validated before processing.',
      applies_when: ['when receiving input'],
    });
    const issues = detectContradictions([card]);
    const overGen = issues.find(i => i.type === 'overgeneralized');
    assert.ok(overGen);
  });

  test('detects not-a-question self-check', () => {
    let card = makeLockedCard('self_check', {
      question: 'The response should be helpful',
    });
    const issues = detectContradictions([card]);
    const notQ = issues.find(i => i.type === 'not_a_question');
    assert.ok(notQ);
  });

  test('detects generic self-check wording', () => {
    let card = makeLockedCard('self_check', {
      question: 'Is this response good enough?',
    });
    const issues = detectContradictions([card]);
    const generic = issues.find(i => i.type === 'generic_check');
    assert.ok(generic);
  });

  test('summarizeContradictions provides counts', () => {
    let card = makeLockedCard('axiom', {
      one_sentence: 'Always test.',
      full_statement: 'Test.',
      applies_when: ['when testing'],
    });
    const issues = detectContradictions([card]);
    const summary = summarizeContradictions(issues);
    assert.ok(summary.total > 0);
    assert.ok('blocking' in summary);
    assert.ok('warnings' in summary);
    assert.ok(summary.by_type);
  });
});

// ─── Evidence ──────────────────────────────────────────────────────────

describe('Evidence', () => {
  test('createEvidenceEntry generates ID and hash', () => {
    const ev = createEvidenceEntry('text', 'Test Evidence', 'This is some test content for judgment extraction.');
    assert.ok(ev.id.startsWith('ev_'));
    assert.ok(ev.content_hash.startsWith('sha256:'));
  });

  test('addEvidence adds to project and updates stage', () => {
    const project = createProject('test');
    const ev = createEvidenceEntry('text', 'Title', 'Content');
    addEvidence(project, ev);
    assert.equal(project.evidence.length, 1);
    assert.equal(project.stages.evidence_room.evidence_count, 1);
    assert.equal(project.stages.evidence_room.status, 'in_progress');
  });

  test('extractSpan creates annotation', () => {
    const ev = createEvidenceEntry('text', 'Test', 'The expert said that price objections are really about uncertainty, not actual price concerns.');
    const span = extractSpan(ev, 18, 90, 'possible_judgment');
    assert.ok(span.id.startsWith('span_'));
    assert.equal(span.candidate_pattern, 'possible_judgment');
    assert.equal(ev.spans.length, 1);
  });

  test('linkEvidenceToCard adds ref', () => {
    let card = createCard('axiom', {});
    const ev = createEvidenceEntry('text', 'T', 'content');
    extractSpan(ev, 0, 10);
    linkEvidenceToCard(ev, ev.spans[0].id, card);
    assert.ok(card.evidence_refs.length > 0);
  });
});

// ─── Test Lab ──────────────────────────────────────────────────────────

describe('Test Lab', () => {
  test('createTestCase generates test with ID', () => {
    const tc = createTestCase('Help me improve this blog post', {
      expectedWithout: 'Generic writing advice',
      expectedWith: 'Structural diagnosis with evidence density check',
    });
    assert.ok(tc.id.startsWith('test_'));
    assert.ok(tc.input);
    assert.equal(tc.result, null);
  });

  test('recordHumanRating sets result', () => {
    const tc = createTestCase('input');
    recordHumanRating(tc, 'with_kdna_better', 'tester', 'KDNA clearly improved the diagnosis.');
    assert.equal(tc.result, 'with_kdna_better');
    assert.equal(tc.rated_by, 'tester');
    assert.ok(tc.rated_at);
  });

  test('recordHumanRating rejects invalid result', () => {
    const tc = createTestCase('input');
    assert.throws(() => recordHumanRating(tc, 'invalid'), /Invalid result/);
  });

  test('linkTestToCards connects test to cards', () => {
    const tc = createTestCase('input');
    linkTestToCards(tc, ['card_1', 'card_2']);
    linkTestToCards(tc, ['card_2', 'card_3']); // deduplicated
    assert.equal(tc.linked_cards.length, 3);
  });

  test('generateTestSummary calculates stats', () => {
    const project = createProject('test');
    project.tests = [];
    for (let i = 0; i < 4; i++) {
      const tc = createTestCase(`input ${i}`);
      recordHumanRating(tc, i < 3 ? 'with_kdna_better' : 'no_difference', 'tester');
      project.tests.push(tc);
    }
    const summary = generateTestSummary(project);
    assert.equal(summary.total, 4);
    assert.equal(summary.with_kdna_better, 3);
    assert.equal(summary.no_difference, 1);
    assert.equal(summary.with_kdna_better_pct, 75);
    assert.equal(summary.passing, true);
  });

  test('exportEvals filters rated tests', () => {
    const project = createProject('test');
    project.tests = [];
    const rated = createTestCase('rated');
    recordHumanRating(rated, 'with_kdna_better', 'tester');
    project.tests.push(rated);
    project.tests.push(createTestCase('unrated'));
    const evals = exportEvals(project);
    assert.equal(evals.length, 1);
    assert.equal(evals[0].result, 'with_kdna_better');
  });
});

// ─── Full Workflow: create → evidence → cards → lock → Feynman → check → compile ──

describe('Full Authoring Workflow', () => {
  test('end-to-end: evidence → card → lock → Feynman → contradiction → compile', () => {
    const project = createProject('leadership_decisions', 'domain', {
      author: { name: 'Expert', id: 'expert_001' },
    });

    // Stage 1: Add evidence
    const ev1 = createEvidenceEntry('text', 'Expert Interview', 'In 15 years of leadership coaching, I have noticed that most "execution failures" are actually decisions that were never properly made in the first place.', 'manual');
    addEvidence(project, ev1);

    // Stage 2: Create judgment cards
    const ax1 = createCard('axiom', {
      one_sentence: 'Execution failure is often decision failure in disguise.',
      full_statement: 'When a team fails to execute, first check whether a real decision (with named owner, deadline, and criteria) was ever made. Most "execution problems" are decision voids.',
      why: 'Without this axiom, managers address symptoms (motivation, training, process) while missing the root cause.',
      applies_when: ['Team reports being stuck', 'Deadline was missed', 'Project not progressing'],
      does_not_apply_when: ['Clear decision exists with owner', 'External blocker (vendor, regulation)'],
      failure_risk: 'May cause managers to over-scrutinize decision quality when the real issue is resource availability.',
    }, 'ax_001');
    project.cards.push(ax1);

    const ms1 = createCard('misunderstanding', {
      wrong: 'If the team is not executing, they lack motivation or skills.',
      correct: 'If the team is not executing, first check whether a real decision was ever made — with owner, deadline, and criteria.',
      key_distinction: 'Motivation gaps produce gradual decline. Decision voids produce sudden stalls. The pattern is different.',
    }, 'ms_001');
    project.cards.push(ms1);

    const sc1 = createCard('self_check', {
      question: 'Before suggesting that the team lacks motivation, did I verify that a concrete decision with owner+deadline+criteria exists?',
    }, 'sc_001');
    project.cards.push(sc1);

    // Stage 3: Lock cards
    const locked = [];
    for (let card of [ax1, ms1, sc1]) {
      card = transitionCard(card, 'revised', { by: 'expert_001' });
      card = lockCard(card, {
        by: 'expert_001',
        statement: 'This judgment represents my 15 years of leadership coaching experience.',
        checked: { applies_when: true, does_not_apply_when: true, failure_risk: true },
      });
      locked.push(card);
    }
    project.cards = locked;

    // Stage 4: Feynman restatements
    for (const card of locked) {
      const fr = createFeynmanRestatement(card,
        card.type === 'axiom'
          ? 'When a team is stuck and not making progress, do not immediately assume they lack skills or motivation. First check if a clear decision was actually made — meaning someone was named as responsible, a deadline was set, and criteria for success were defined. If not, you have a decision void, not an execution problem.'
          : card.type === 'misunderstanding'
            ? 'The difference between motivation failure and decision failure is like the difference between a car running out of gas (gradual) versus a car that was never given a destination (immediate stall). One fades, the other stops dead.'
            : 'Before concluding the team is the problem, do this quick check: was there a specific person who knew they were responsible? Was there a date? Were there concrete criteria for done? If any of these is missing, fix the decision first, then check execution.'
      );
      attachRestatementToLock(card, fr);
    }

    // Stage 5: Contradiction check
    const issues = detectContradictions(project.cards);
    const summary = summarizeContradictions(issues);

    // Stage 6: Compile
    const result = compileDomain(project);

    // Stage 7: Quality
    const readiness = computeReadiness(project);

    // Stage 8: Provenance
    const provenance = buildProvenance(project, result.files);

    // Assertions
    assert.equal(project.cards.length, 3);
    assert.equal(project.evidence.length, 1);
    // Verify Feynman quality (all cards should have at least 'acceptable')
    for (const card of project.cards) {
      assert.ok(card.feynman_restatement);
      const quality = card.feynman_restatement.score.quality;
      assert.ok(quality === 'good' || quality === 'acceptable', `Expected good or acceptable, got ${quality} for ${card.id}`);
    }

    // Verify contradiction check found no blocking issues
    assert.equal(summary.blocking, 0, 'No blocking issues expected');

    // Verify compile includes all 3 cards
    assert.equal(result.stats.locked_cards, 3);
    assert.equal(result.stats.excluded_cards, 0);

    // Verify output structure
    const core = JSON.parse(result.files['KDNA_Core.json']);
    assert.equal(core.axioms.length, 1);
    assert.equal(core.axioms[0].id, 'ax_001');

    const patterns = JSON.parse(result.files['KDNA_Patterns.json']);
    assert.equal(patterns.misunderstandings.length, 1);
    assert.equal(patterns.self_check.length, 1);

    // Verify provenance
    assert.ok(provenance.build_id);
    assert.ok(provenance.content_fingerprint);
    assert.equal(provenance.locked_card_count, 3);
  });
});
