/**
 * Contradiction Check — Surface conflicts, gaps, and weak judgment.
 *
 * Detects:
 *   - Axiom contradictions (two axioms that cannot both be true)
 *   - Missing boundaries (axiom lacks does_not_apply_when)
 *   - Weak self-checks (not a yes/no question, too vague)
 *   - Over-generalized axioms (too broad to be testable)
 *   - Straw-man misunderstandings (describes something no one believes)
 *   - Missing counterexamples (misunderstanding lacks a real example)
 */

function tokenize(text) {
  if (!text) return [];
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
      return [...segmenter.segment(text)].filter(s => s.isWordLike && s.segment.length > 3).map(s => s.segment);
    }
  } catch { /* fallback */ }
  return text.split(/\s+/).filter(w => w.length > 3);
}

function detectContradictions(cards) {
  const issues = [];
  const axioms = cards.filter(c => c.type === 'axiom' && c.locked);

  // Check for missing boundaries on locked axioms
  for (const ax of axioms) {
    if (!ax.fields?.does_not_apply_when || ax.fields.does_not_apply_when.length === 0) {
      issues.push({
        type: 'missing_boundary',
        card_id: ax.id,
        severity: 'blocking',
        message: `${ax.id}: locked axiom lacks does_not_apply_when`,
        fix: 'Define at least one situation where this axiom should NOT be applied.',
      });
    }
    if (!ax.fields?.applies_when || ax.fields.applies_when.length === 0) {
      issues.push({
        type: 'missing_applicability',
        card_id: ax.id,
        severity: 'blocking',
        message: `${ax.id}: locked axiom lacks applies_when`,
        fix: 'Define at least one situation where this axiom applies.',
      });
    }
    if (ax.fields?.full_statement && ax.fields.full_statement.length < 30) {
      issues.push({
        type: 'too_short',
        card_id: ax.id,
        severity: 'warning',
        message: `${ax.id}: full_statement is very short — may be too vague`,
      });
    }

    // Check for over-generalization: axioms that use absolute language without boundaries
    const oneLiner = (ax.fields?.one_sentence || '').toLowerCase();
    if (/\b(always|never|every|all|none|must)\b/.test(oneLiner) && (!ax.fields.does_not_apply_when || ax.fields.does_not_apply_when.length === 0)) {
      issues.push({
        type: 'overgeneralized',
        card_id: ax.id,
        severity: 'warning',
        message: `${ax.id}: uses absolute language ("${oneLiner.match(/always|never|every|all|none|must/)[0]}") but has no does_not_apply_when`,
        fix: 'Add does_not_apply_when to prevent this axiom from being applied universally.',
      });
    }
  }

  // Check misunderstandings
  const misunderstandings = cards.filter(c => c.type === 'misunderstanding' && c.locked);
  for (const ms of misunderstandings) {
    const wrong = ms.fields?.wrong || '';
    const correct = ms.fields?.correct || '';

    // Check for straw-man: the "wrong" belief describes something no real person would believe
    if (wrong.length < 15) {
      issues.push({
        type: 'vague_misunderstanding',
        card_id: ms.id,
        severity: 'warning',
        message: `${ms.id}: wrong belief description is very short — may not describe a real mistake`,
      });
    }

    // Check the wrong and correct are actually different (not just negation)
    const wrongWords = new Set(tokenize(wrong.toLowerCase()));
    const correctWords = tokenize(correct.toLowerCase());
    const sharedWords = correctWords.filter(w => wrongWords.has(w)).length;
    if (correctWords.length > 0 && sharedWords / correctWords.length > 0.7) {
      issues.push({
        type: 'weak_distinction',
        card_id: ms.id,
        severity: 'warning',
        message: `${ms.id}: wrong and correct share ${Math.round(sharedWords / correctWords.length * 100)}% of words — distinction may be too weak`,
      });
    }

    // Key distinction check
    if (!ms.fields?.key_distinction || ms.fields.key_distinction.length < 20) {
      issues.push({
        type: 'missing_distinction',
        card_id: ms.id,
        severity: 'blocking',
        message: `${ms.id}: key_distinction missing or too short`,
        fix: 'Explain the conceptual boundary between the wrong belief and the correct one.',
      });
    }
  }

  // Check self-checks
  const selfChecks = cards.filter(c => c.type === 'self_check' && c.locked);
  for (const sc of selfChecks) {
    const question = sc.fields?.question || '';
    if (!question.trim().endsWith('?')) {
      issues.push({
        type: 'not_a_question',
        card_id: sc.id,
        severity: 'blocking',
        message: `${sc.id}: self_check must be phrased as a question ending with ?`,
      });
    }
    if (question.length < 15) {
      issues.push({
        type: 'vague_check',
        card_id: sc.id,
        severity: 'warning',
        message: `${sc.id}: self_check question is very short — may be too vague to verify`,
      });
    }
    // Check for generic self-checks
    const genericPatterns = ['is this good', 'is this correct', 'is this helpful', 'is this clear', 'is this response', 'is the response', 'good enough', 'is it good'];
    if (genericPatterns.some(p => question.toLowerCase().includes(p))) {
      issues.push({
        type: 'generic_check',
        card_id: sc.id,
        severity: 'warning',
        message: `${sc.id}: self_check is too generic — should be domain-specific`,
        fix: 'Rephrase with domain-specific criteria, e.g. "Did the agent diagnose the type of uncertainty before suggesting action?"',
      });
    }
  }

  // Check boundaries
  const boundaries = cards.filter(c => c.type === 'boundary' && c.locked);
  for (const bd of boundaries) {
    if (bd.fields?.out_of_scope && bd.fields.out_of_scope.length < 10) {
      issues.push({
        type: 'vague_boundary',
        card_id: bd.id,
        severity: 'warning',
        message: `${bd.id}: out_of_scope is very short — boundary may be unclear`,
      });
    }
    if (!bd.fields?.acceptable_exceptions || bd.fields.acceptable_exceptions.length === 0) {
      issues.push({
        type: 'no_exceptions',
        card_id: bd.id,
        severity: 'warning',
        message: `${bd.id}: no acceptable_exceptions declared — every boundary has justified exceptions`,
      });
    }
  }

  return issues;
}

function summarizeContradictions(issues) {
  const blocking = issues.filter(i => i.severity === 'blocking');
  const warnings = issues.filter(i => i.severity === 'warning');
  return {
    total: issues.length,
    blocking: blocking.length,
    warnings: warnings.length,
    clean: issues.length === 0,
    by_type: issues.reduce((acc, i) => {
      acc[i.type] = (acc[i.type] || 0) + 1;
      return acc;
    }, {}),
  };
}

module.exports = { detectContradictions, summarizeContradictions };
