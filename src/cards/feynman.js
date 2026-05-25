/**
 * Feynman Restatement — Verify understanding, not just agreement.
 *
 * The Feynman technique: explain a concept in simple terms a non-expert
 * would understand. This proves the expert truly owns the judgment,
 * rather than just nodding at an AI proposal.
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

function createFeynmanRestatement(card, text) {
  if (!text || typeof text !== 'string') throw new Error('Feynman restatement text is required');
  if (text.length < 20) throw new Error('Feynman restatement too short (minimum 20 chars)');

  const restatement = {
    text,
    evaluated_at: new Date().toISOString(),
    score: evaluateRestatementQuality(card, text),
  };

  return restatement;
}

function evaluateRestatementQuality(card, text) {
  const original = card.fields?.one_sentence || card.fields?.essence || card.fields?.wrong || '';
  const originalLower = original.toLowerCase();
  const textLower = text.toLowerCase();

  // 1. Not just a repeat — check word overlap ratio
  const originalWords = new Set(tokenize(originalLower));
  const textWords = tokenize(textLower);
  const overlapCount = textWords.filter(w => originalWords.has(w)).length;
  const overlapRatio = textWords.length > 0 ? overlapCount / textWords.length : 1;
  const not_just_repeat = overlapRatio < 0.5;

  // 2. Not too abstract — check for concrete words
  const concreteSignals = ['example', 'instance', 'case', 'scenario', 'when', 'if', 'customer', 'user', 'client', 'team', 'manager', 'project', 'code', 'product', 'meeting', 'email'];
  const hasConcrete = concreteSignals.some(w => textLower.includes(w));
  const not_too_abstract = hasConcrete;

  // 3. Has concrete example — check for story-like patterns
  const storyPatterns = ['when', 'if', 'because', 'so', 'then', 'example', 'imagine', 'suppose', 'consider'];
  const hasStory = storyPatterns.filter(w => textLower.includes(w)).length >= 2;
  const has_concrete_example = hasStory;

  // 4. Clarifies boundary — mentions what it's NOT
  const boundaryWords = ['not', "don't", 'does not', 'cannot', 'unless', 'except', 'only if', 'but not', 'however'];
  const clarifies_boundary = boundaryWords.some(w => textLower.includes(w));

  // 5. Ordinary person understands — Flesch-like readability check
  const sentences = text.split(/[.!?]+/).filter(s => s.trim());
  const avgWordsPerSentence = sentences.length > 0
    ? sentences.reduce((s, sent) => s + sent.trim().split(/\s+/).length, 0) / sentences.length
    : 99;
  const ordinary_person_understands = avgWordsPerSentence < 25;

  const scores = { not_just_repeat, not_too_abstract, has_concrete_example, clarifies_boundary, ordinary_person_understands };
  const totalScore = Object.values(scores).filter(Boolean).length;

  return {
    ...scores,
    total: totalScore,
    quality: totalScore >= 4 ? 'good' : totalScore >= 3 ? 'acceptable' : 'needs_improvement',
    detail: {
      overlap_ratio: Math.round(overlapRatio * 100) + '%',
      avg_words_per_sentence: Math.round(avgWordsPerSentence),
    },
  };
}

function attachRestatementToLock(card, restatement) {
  if (!card.human_lock) throw new Error('Card must be locked before attaching Feynman restatement');
  card.feynman_restatement = restatement;
  card.audit_log.push({
    at: new Date().toISOString(),
    event: 'feynman_restatement',
    by: card.human_lock.by,
  });
  return card;
}

function validateRestatementCard(card) {
  const issues = [];
  if (!card.feynman_restatement) {
    issues.push({ type: 'missing_feynman', severity: 'warning', message: `${card.id}: missing Feynman restatement (lock is stronger with it)` });
    return issues;
  }
  const fr = card.feynman_restatement;
  if (!fr.score?.not_just_repeat) issues.push({ type: 'repeat', severity: 'warning', message: `${card.id}: Feynman may just repeat the original text` });
  if (!fr.score?.not_too_abstract) issues.push({ type: 'abstract', severity: 'warning', message: `${card.id}: Feynman may be too abstract` });
  if (!fr.score?.clarifies_boundary) issues.push({ type: 'no_boundary', severity: 'warning', message: `${card.id}: Feynman does not explain when this does NOT apply` });
  if (!fr.score?.ordinary_person_understands) issues.push({ type: 'complex', severity: 'warning', message: `${card.id}: Feynman may be too complex for a non-expert` });
  return issues;
}

module.exports = { createFeynmanRestatement, evaluateRestatementQuality, attachRestatementToLock, validateRestatementCard };
