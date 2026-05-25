/**
 * Card Validator — Anti-vagueness, anti-SOP, anti-slogan, anti-straw-man checks.
 *
 * Ensures every card meets minimum quality before it can be locked.
 * These checks mirror the kdna-cli publish --check rules.
 */

const ANTI_PATTERNS = {
  axiom: {
    slogans: ['is key', 'is important', 'matters', 'is critical', 'is essential', 'should be', 'must be'],
    sops: ['first, you should', 'follow these steps', 'always remember to', 'the process is'],
  },
  misunderstanding: {
    straw_men: ['some people say', 'many believe', 'it is commonly thought'],
  },
  self_check: {
    generics: ['is this good', 'is this correct', 'is this helpful', 'is this clear', 'does this work', 'is it right'],
  },
};

function validateCard(card) {
  const issues = [];

  switch (card.type) {
    case 'axiom':
      validateAxiom(card, issues);
      break;
    case 'misunderstanding':
      validateMisunderstanding(card, issues);
      break;
    case 'self_check':
      validateSelfCheck(card, issues);
      break;
    case 'ontology':
      validateOntology(card, issues);
      break;
    case 'boundary':
      validateBoundary(card, issues);
      break;
  }

  return issues;
}

function validateAxiom(card, issues) {
  const oneLiner = (card.fields?.one_sentence || '').toLowerCase();
  const full = (card.fields?.full_statement || '').toLowerCase();

  // Anti-slogan: reject axioms that are just motivational slogans
  for (const slogan of ANTI_PATTERNS.axiom.slogans) {
    if (oneLiner.includes(slogan) && oneLiner.length < 40) {
      issues.push({
        type: 'slogan',
        severity: 'warning',
        message: `${card.id}: one_sentence may be a slogan — "${oneLiner.slice(0, 60)}"`,
        fix: 'Axioms must be specific, testable judgment principles. Replace vague slogans with concrete decision rules.',
      });
      break;
    }
  }

  // Anti-SOP: axioms should not encode step-by-step procedures
  for (const sop of ANTI_PATTERNS.axiom.sops) {
    if (oneLiner.includes(sop) || full.includes(sop)) {
      issues.push({
        type: 'sop',
        severity: 'warning',
        message: `${card.id}: axiom reads like a procedure, not a judgment principle`,
        fix: 'Axioms encode how to judge, not what steps to follow. Rephrase as a decision principle.',
      });
      break;
    }
  }

  // Anti-vagueness: one_sentence must be specific enough
  if (oneLiner.length < 15) {
    issues.push({ type: 'too_short', severity: 'blocking', message: `${card.id}: one_sentence too short (${oneLiner.length} chars)`, fix: 'Make it a complete, specific judgment statement.' });
  }

  // Check for dictionary-definition style (axiom should not start with "X is")
  if (/^\w+\s+is\s/.test(oneLiner) && oneLiner.length < 50) {
    issues.push({ type: 'definition_like', severity: 'warning', message: `${card.id}: one_sentence reads like a definition, not a judgment — rephrase as a principle` });
  }
}

function validateMisunderstanding(card, issues) {
  const wrong = (card.fields?.wrong || '').toLowerCase();
  const correct = (card.fields?.correct || '').toLowerCase();
  const distinction = card.fields?.key_distinction || '';

  // Anti-straw-man: the wrong belief should be something real people believe
  if (wrong.length < 15) {
    issues.push({ type: 'vague_wrong', severity: 'warning', message: `${card.id}: wrong belief too short — may describe a straw man no one believes` });
  }
  for (const straw of ANTI_PATTERNS.misunderstanding.straw_men) {
    if (wrong.includes(straw)) {
      issues.push({ type: 'straw_man', severity: 'warning', message: `${card.id}: wrong belief uses straw-man phrasing — describe what people actually get wrong` });
      break;
    }
  }

  if (!distinction || distinction.length < 20) {
    issues.push({ type: 'missing_distinction', severity: 'blocking', message: `${card.id}: key_distinction missing or too short (${distinction.length} chars)` });
  }
}

function validateSelfCheck(card, issues) {
  const question = card.fields?.question || '';

  const isQuestion = question.endsWith('?') || question.endsWith('？') || /[吗是否]$/.test(question);
  if (!isQuestion) {
    issues.push({ type: 'not_question', severity: 'blocking', message: `${card.id}: must be a yes/no answerable question` });
  }

  if (question.length < 15) {
    issues.push({ type: 'vague', severity: 'warning', message: `${card.id}: question too short — make it domain-specific` });
  }

  for (const gen of ANTI_PATTERNS.self_check.generics) {
    if (question.toLowerCase().includes(gen)) {
      issues.push({ type: 'generic', severity: 'warning', message: `${card.id}: question is generic — should reference domain-specific criteria` });
      break;
    }
  }
}

function validateOntology(card, issues) {
  const essence = card.fields?.essence || '';
  const boundary = card.fields?.boundary || '';
  const trigger = card.fields?.trigger_signal || '';

  if (essence.length < 15) {
    issues.push({ type: 'vague_essence', severity: 'warning', message: `${card.id}: essence too short — explain operational meaning` });
  }
  if (boundary.length < 10) {
    issues.push({ type: 'missing_boundary', severity: 'warning', message: `${card.id}: boundary missing — what is this concept NOT?` });
  }
  if (trigger.length < 10) {
    issues.push({ type: 'missing_trigger', severity: 'warning', message: `${card.id}: trigger_signal missing — how does the agent detect this concept?` });
  }
}

function validateBoundary(card, issues) {
  const scope = card.fields?.scope || '';
  const outOfScope = card.fields?.out_of_scope || '';

  if (scope.length < 10) {
    issues.push({ type: 'vague_scope', severity: 'warning', message: `${card.id}: scope too short` });
  }
  if (outOfScope.length < 10) {
    issues.push({ type: 'vague_out_of_scope', severity: 'blocking', message: `${card.id}: out_of_scope missing or too short` });
  }
}

function validateAllCards(project) {
  const allIssues = [];
  for (const card of (project.cards || [])) {
    const cardIssues = validateCard(card);
    allIssues.push({ card_id: card.id, issues: cardIssues });
  }
  return allIssues;
}

module.exports = { validateCard, validateAllCards, ANTI_PATTERNS };
