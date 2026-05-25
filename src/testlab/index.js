/**
 * Test Lab — Validate that a KDNA domain actually changes agent judgment.
 *
 * Core operations:
 *   - Create test cases (input → expected_without_kdna → expected_with_kdna)
 *   - Run comparison through kdna-cli compare
 *   - Record human rating
 *   - Attach tests to cards
 *   - Export evals for KDNA domain
 */

function createTestCase(input, options = {}) {
  return {
    id: `test_${require('crypto').randomUUID()}`,
    input,
    expected_without_kdna: options.expectedWithout || '',
    expected_with_kdna: options.expectedWith || '',
    domain: options.domain || null,
    result: null, // 'with_kdna_better' | 'no_difference' | 'without_kdna_better'
    human_rating: null,
    rated_by: null,
    rated_at: null,
    notes: '',
    linked_cards: [],
    created_at: new Date().toISOString(),
  };
}

function recordHumanRating(testCase, result, ratedBy, notes = '') {
  const validResults = ['with_kdna_better', 'no_difference', 'without_kdna_better'];
  if (!validResults.includes(result)) throw new Error(`Invalid result: ${result}. Must be one of: ${validResults.join(', ')}`);
  testCase.result = result;
  testCase.human_rating = result;
  testCase.rated_by = ratedBy;
  testCase.rated_at = new Date().toISOString();
  testCase.notes = notes;
  return testCase;
}

function linkTestToCards(testCase, cardIds) {
  testCase.linked_cards = [...new Set([...testCase.linked_cards, ...cardIds])];
  return testCase;
}

function applyTestResultsToCards(project, testCase) {
  if (!testCase.result) return project;
  const cards = project.cards || [];
  for (const cardId of (testCase.linked_cards || [])) {
    const card = cards.find(c => c.id === cardId);
    if (!card) continue;
    if (card.status === 'locked' && testCase.result === 'with_kdna_better') {
      const { transitionCard } = require('../cards');
      try {
        transitionCard(card, 'tested', { by: testCase.rated_by || 'testlab', reason: `test ${testCase.id}: ${testCase.result}` });
      } catch { /* card may have been already tested */ }
    }
  }
  return project;
}

function generateTestSummary(project) {
  const tests = project.tests || [];
  const total = tests.length;
  const rated = tests.filter(t => t.result).length;
  const withKdnaBetter = tests.filter(t => t.result === 'with_kdna_better').length;
  const noDiff = tests.filter(t => t.result === 'no_difference').length;
  const withoutBetter = tests.filter(t => t.result === 'without_kdna_better').length;

  return {
    total,
    rated,
    unrated: total - rated,
    with_kdna_better: withKdnaBetter,
    with_kdna_better_pct: total > 0 ? Math.round((withKdnaBetter / rated) * 100) : 0,
    no_difference: noDiff,
    without_kdna_better: withoutBetter,
    passing: withKdnaBetter >= Math.ceil(rated * 0.6), // at least 60% of rated tests should favor KDNA
  };
}

function exportEvals(project) {
  const tests = (project.tests || []).filter(t => t.result);
  return tests.map(t => ({
    id: t.id,
    input: t.input,
    expected_without_kdna: t.expected_without_kdna || null,
    expected_with_kdna: t.expected_with_kdna || null,
    result: t.result,
    linked_cards: t.linked_cards,
    rated_by: t.rated_by,
    rated_at: t.rated_at,
    notes: t.notes,
  }));
}

function compareAdapter(domainName, input, options = {}) {
  // Returns the CLI command and args for kdna compare
  const args = ['compare', domainName, '--input', input];
  if (options.reportMd) args.push('--report-md');
  if (options.reportJson) args.push('--report-json');
  if (options.output) args.push('--output', options.output);
  return {
    command: 'kdna',
    args,
    description: 'Runs kdna compare to test judgment impact',
  };
}

module.exports = {
  createTestCase,
  recordHumanRating,
  linkTestToCards,
  generateTestSummary,
  exportEvals,
  compareAdapter,
};
