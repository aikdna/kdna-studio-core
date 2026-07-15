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

function stringList(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null && item !== '');
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

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
      ...stringList(fields.applies_when), ...stringList(fields.does_not_apply_when)]
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

function generateKdnaCard(project, compiledStats, provenance, gates) {
  const gov = project.governance || {};
  const cards = project.cards || [];
  const lockedCards = cards.filter(c => c.locked && c.human_lock?.by && c.human_lock?.statement);

  const card = {
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

  // ── RFC-0014 expanded card fields ────────────────────────────────
  if (gates) {
    const sag = gates.sag || {};
    const tc = gates.tc || {};
    const sagObj = sag.source_authority || null;
    const tcObj = tc.truth_charter || null;

    // 3.4 authority_status — based on SAG source types
    if (!sagObj) {
      card.authority_status = 'none';
    } else {
      const sources = Array.isArray(sagObj.sources) ? sagObj.sources : [];
      const currentHighest = sources.filter(s =>
        s && typeof s === 'object' && s.type === 'human_locked_charter'
      );
      const authorConfirm = sources.filter(s =>
        s && typeof s === 'object' && s.type === 'author_confirmation'
      );
      // PR-4b synthesis is detected via tc_status, not per-source flags
      const wasSynthesized = tcObj && tcObj.tc_status_before_lock === 'synthesized';
      const migrated = project.migration && project.migration.synthesized === true;

      if (currentHighest.length > 0) {
        card.authority_status = (wasSynthesized || migrated)
          ? 'synthesized_then_human_locked'
          : 'human_locked';
      } else if (authorConfirm.length > 0) {
        card.authority_status = 'author_confirmation_only';
      } else {
        card.authority_status = 'declared_only';
      }
    }

    // 3.5 truth_charter_status
    if (tcObj && typeof tcObj.tc_status === 'string') {
      const validStatuses = ['draft', 'synthesized', 'locked', 'deprecated'];
      card.truth_charter_status = validStatuses.includes(tcObj.tc_status)
        ? tcObj.tc_status
        : 'draft';
    }

    // 3.6 migration_status — only explicit provenance may declare who
    // authored or migrated an asset. Missing SAG/TC data is not evidence of
    // human authorship, and must remain neutral.
    const migrationOverride = (project.migration && project.migration.status) || null;
    if (migrationOverride) {
      card.migration_status = migrationOverride;
    } else if (tcObj && tcObj.tc_status === 'synthesized') {
      card.migration_status = 'synthesized';
    } else {
      card.migration_status = 'not_declared';
    }

    // 3.7 source_disclosure_level
    card.source_disclosure_level = gov.source_disclosure_level || 'summary';

    // 3.1 sag_summary
    if (sagObj) {
      const sources = Array.isArray(sagObj.sources) ? sagObj.sources : [];
      const currentHighestCount = sources.filter(s =>
        s && typeof s === 'object' && s.type === 'human_locked_charter'
      ).length;
      card.sag_summary = {
        sag_id: sagObj.id || `sag_${project.name}_${new Date().toISOString().slice(0, 10)}`,
        version_intent: sagObj.version_intent || card.version,
        source_count: sources.length,
        current_highest_count: currentHighestCount,
        has_conflict_policies: !!(sagObj.conflict_policies && Object.keys(sagObj.conflict_policies).length > 0),
        sensitivity: {
          pii: !!(sagObj.sensitivity && sagObj.sensitivity.sources_contain_pii),
          author_consent_on_file: !!(sagObj.sensitivity && sagObj.sensitivity.author_consent_on_file),
        },
      };
    }

    // 3.2 tc_summary
    if (tcObj) {
      card.tc_summary = {
        tc_id: tcObj.id || `tc_${project.name}_${card.version}_${new Date().toISOString().slice(0, 10)}`,
        highest_question: tcObj.highest_question || '',
        in_scope_count: Array.isArray(tcObj.in_scope) ? tcObj.in_scope.length : 0,
        out_of_scope_count: Array.isArray(tcObj.out_of_scope) ? tcObj.out_of_scope.length : 0,
        renamed_terms_count: Array.isArray(tcObj.renamed_terms) ? tcObj.renamed_terms.length : 0,
        highest_axiom_protected_chars: typeof tcObj.highest_axiom_protected === 'string'
          ? tcObj.highest_axiom_protected.length : 0,
      };
    }

    // 3.3 module_summary — from project-level module_manifest
    const manifest = project.module_manifest || null;
    if (manifest) {
      const modules = Array.isArray(manifest.modules) ? manifest.modules : [];
      card.module_summary = {
        module_count: modules.length,
        internal_module_count: modules.filter(m => m && m.type === 'internal_module').length,
        sub_domain_count: modules.filter(m => m && m.type === 'sub_domain').length,
        reference_count: modules.filter(m => m && m.type === 'reference').length,
        decomposition_rationale_present: typeof manifest.decomposition_rationale === 'string'
          && manifest.decomposition_rationale.trim().length >= 30,
      };
    }
  }

  return card;
}

module.exports = { computeRiskLevel, requiresExpertReview, validateGovernance, generateKdnaCard, HIGH_RISK_KEYWORDS };
