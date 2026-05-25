/**
 * Governance risk assessment — classify domain risk level and validate governance metadata.
 *
 * Risk levels:
 *   R0 — Low: inconvenience, not harm
 *   R1 — Medium: suboptimal outcomes
 *   R2 — High: significant harm possible
 *   R3 — Restricted: serious harm, not for public registry
 */

const HIGH_RISK_KEYWORDS = {
  medical: ['diagnosis', 'treatment', 'symptom', 'patient', 'clinical', 'therapy', 'medication', 'disease', 'prescription', 'surgery', 'medical'],
  legal: ['lawsuit', 'liability', 'plaintiff', 'defendant', 'jurisdiction', 'statute', 'legal advice', 'attorney', 'court', 'litigation'],
  financial: ['investment', 'portfolio', 'stock', 'bond', 'retirement', 'insurance', 'mortgage', 'loan', 'tax advice', 'credit score', 'financial advice'],
  safety: ['weapon', 'surveillance', 'monitoring', 'tracking', 'child safety', 'emergency response', 'public safety', 'self-harm', 'suicide'],
  decision: ['hiring', 'firing', 'termination', 'employment decision', 'performance review'],
};

function computeRiskLevel(project) {
  const cards = project.cards || [];

  // Check declared risk level first
  const declared = (project.governance && project.governance.risk_level) || null;
  if (declared === 'R3') return 'R3';

  // Short-circuit: check each card individually and stop at first high-risk match
  for (const card of cards) {
    const fields = card.fields || {};
    const cardText = [fields.one_sentence, fields.full_statement, fields.wrong, fields.correct, fields.question,
      fields.essence, fields.scope, fields.out_of_scope,
      ...(fields.applies_when || []), ...(fields.does_not_apply_when || [])]
      .filter(Boolean).join(' ').toLowerCase();

    for (const [category, keywords] of Object.entries(HIGH_RISK_KEYWORDS)) {
      for (const kw of keywords) {
        if (cardText.includes(kw)) {
          if (['medical', 'safety'].includes(category)) return 'R3';
          if (['legal', 'financial'].includes(category)) return 'R2';
          if (category === 'decision') return 'R1';
        }
      }
    }
  }

  // If no high-risk keywords found and R0-R2 declared, trust the declaration
  if (declared) return declared;

  return 'R1'; // Default: medium risk
}

function requiresExpertReview(riskLevel) {
  return riskLevel === 'R2' || riskLevel === 'R3';
}

function validateGovernance(project) {
  const issues = [];
  const gov = project.governance || {};

  // Required fields
  if (!gov.risk_level) {
    issues.push({ type: 'missing_risk_level', severity: 'blocking', message: 'Governance: risk_level must be declared (R0/R1/R2/R3)' });
  }
  if (!gov.intended_use || !gov.intended_use.length) {
    issues.push({ type: 'missing_intended_use', severity: 'blocking', message: 'Governance: intended_use must be declared' });
  }
  if (!gov.out_of_scope || !gov.out_of_scope.length) {
    issues.push({ type: 'missing_out_of_scope', severity: 'blocking', message: 'Governance: out_of_scope must be declared' });
  }
  if (!gov.known_limitations || !gov.known_limitations.length) {
    issues.push({ type: 'missing_limitations', severity: 'blocking', message: 'Governance: known_limitations must be declared' });
  }

  // Compute risk level once, reuse for both riskLevel and detectedLevel
  const computedLevel = computeRiskLevel(project);
  const riskLevel = gov.risk_level || computedLevel;

  // Risk level specific checks
  if (requiresExpertReview(riskLevel)) {
    if (!gov.reviewed_by) {
      issues.push({ type: 'requires_expert_review', severity: 'blocking', message: `Governance: risk_level ${riskLevel} requires expert_review. reviewed_by must be set.` });
    }
    if (!gov.risk_warnings || !gov.risk_warnings.length) {
      issues.push({ type: 'missing_risk_warnings', severity: 'blocking', message: `Governance: risk_level ${riskLevel} requires risk_warnings.` });
    }
  }

  // Check for high-risk keywords in content that might not match declared level
  const detectedLevel = computedLevel;
  if (gov.risk_level && ['R0', 'R1'].includes(gov.risk_level) && ['R2', 'R3'].includes(detectedLevel)) {
    issues.push({
      type: 'risk_mismatch',
      severity: 'blocking',
      message: `Governance: declared risk_level ${gov.risk_level} but content analysis suggests ${detectedLevel}. Review required.`,
    });
  }

  // Author responsibility required for R1+
  if (['R1', 'R2', 'R3'].includes(riskLevel) && !gov.author_statement) {
    issues.push({ type: 'missing_author_statement', severity: 'blocking', message: `Governance: risk_level ${riskLevel} requires author_statement.` });
  }

  return {
    valid: issues.filter(i => i.severity === 'blocking').length === 0,
    issues,
    risk_level: riskLevel,
    requires_expert_review: requiresExpertReview(riskLevel),
  };
}

function generateKdnaCard(project, compiledStats, provenance) {
  const gov = project.governance || {};
  const cards = project.cards || [];
  const lockedCards = cards.filter(c => c.locked);

  return {
    name: project.name,
    version: (project.release && project.release.version) || '0.1.0',
    risk_level: gov.risk_level || computeRiskLevel(project),
    intended_use: gov.intended_use || [],
    out_of_scope: gov.out_of_scope || [],
    known_limitations: gov.known_limitations || [],
    author_responsibility: gov.author_statement || '',
    risk_warnings: gov.risk_warnings || [],
    human_lock_summary: {
      locked_cards: lockedCards.length,
      locked_axioms: lockedCards.filter(c => c.type === 'axiom').length,
      locked_misunderstandings: lockedCards.filter(c => c.type === 'misunderstanding').length,
      locked_self_checks: lockedCards.filter(c => c.type === 'self_check').length,
      feynman_restatements: lockedCards.filter(c => c.feynman_restatement).length,
      locked_by: (project.author && project.author.id) || 'unknown',
    },
    quality_badge: (compiledStats && compiledStats.locked_cards > 0) ? 'tested' : 'untested',
    review_status: gov.review_status || 'community',
    requires_expert_review: requiresExpertReview(gov.risk_level || 'R1'),
    provenance: provenance || {},
    license: (project.release && project.release.license) || 'CC-BY-4.0',
  };
}

module.exports = { computeRiskLevel, requiresExpertReview, validateGovernance, generateKdnaCard, HIGH_RISK_KEYWORDS };
