/**
 * Enhanced Quality Gates — 4-grade readiness with integrated card validation.
 *
 * Grades:
 *   draft_grade       — Core+Patterns exist, ≥3 human-reviewed cards
 *   human_controlled  — All core axioms locked with boundaries, ≥50% have Feynman
 *   tested_grade      — ≥5 rated evals, ≥3 comparison tests
 *   publishable_grade — ≥10 evals, all axioms have Feynman, README 4 questions, no blocking
 *
 * v0.3.2: integrates validateAllCards, Feynman enforcement at publishable grade.
 */

const contradiction = require('./contradiction');
const { validateAllCards } = require('./validate-cards');
const { validateGovernance } = require('../governance');
const { computeI18nCoverage } = require('../i18n');

function computeReadiness(project) {
  const cards = project.cards || [];
  const tests = project.tests || [];
  const locked = cards.filter(c => c.locked);
  const lockedAxioms = locked.filter(c => c.type === 'axiom');
  const lockedSelfChecks = locked.filter(c => c.type === 'self_check');
  const lockedMisunderstandings = locked.filter(c => c.type === 'misunderstanding');
  const ratedTests = tests.filter(t => t.result);

  const blocking = [];
  const warnings = [];

  // ── Governance check (v0.6.1) ───────────────────────────────────
  const govResult = validateGovernance(project);

  // ── Source mode trust checks (v1.4.0) ───────────────────────────
  const sourceMode = project.source_mode || 'blank';
  if (sourceMode === 'source_folder') {
    blocking.push('source_folder: all imported cards must be re-locked — legacy trust is not inherited');
    blocking.push('source_folder: schema audit required; verify all required fields before Human Lock');
  }
  if (sourceMode === 'kdna_asset') {
    const hasRelevantLineage = project.lineage &&
      (project.lineage.parent_name || project.lineage.parent_asset_uid);
    if (!hasRelevantLineage) {
      blocking.push('kdna_asset: lineage missing — must record parent KDNA identity');
    }
    warnings.push('kdna_asset: cards imported from existing KDNA must be re-locked; parent trust is not inherited');
  }

  // ── I18N check (v1.2.0) ─────────────────────────────────────────
  // I18N gates are triggered by declared languages, not by scope prefix.
  // Projects declaring multi-language support SHOULD have corresponding locale files.
  const i18nCoverage = computeI18nCoverage(project);
  const declaredLanguages = (project.languages || []).filter(l => l !== project.default_language);
  const hasMultiLangIntent = declaredLanguages.length > 0 || (project.i18n_level && project.i18n_level !== 'L0');
  if (hasMultiLangIntent && i18nCoverage.level === 'L0') {
    warnings.push('I18N: project declares multi-language intent but has no locale files (L0). Add at least L1 (KDNA_CARD.json + README in locales/).');
  } else if (hasMultiLangIntent && i18nCoverage.level === 'L1') {
    warnings.push('I18N: L1 achieved (card + readme). Recommended: L2 overlay for publishable grade.');
  }
  for (const issue of govResult.issues) {
    (issue.severity === 'blocking' ? blocking : warnings).push(`Governance: ${issue.message}`);
  }

  // ── Card validation integration (v0.3.2) ─────────────────────────
  const cardResults = validateAllCards(project);
  for (const { card_id, issues } of cardResults) {
    for (const issue of issues) {
      if (issue.severity === 'blocking') blocking.push(`${card_id}: ${issue.message}`);
      else warnings.push(`${card_id}: ${issue.message}`);
    }
  }

  // ── Minimum Structure ──────────────────────────────────────────
  if (cards.length === 0) { blocking.push('Project has no cards'); return buildResult('draft_grade', blocking, warnings, project); }
  if (locked.length === 0) { blocking.push('No locked cards — nothing to compile'); return buildResult('draft_grade', blocking, warnings, project); }

  // ── Axiom Checks ──────────────────────────────────────────────
  for (const ax of lockedAxioms) {
    if (!ax.fields?.one_sentence || ax.fields.one_sentence.length < 10) blocking.push(`${ax.id}: one_sentence too short`);
    if (!ax.fields?.applies_when?.length) blocking.push(`${ax.id}: missing applies_when`);
    if (!ax.fields?.does_not_apply_when?.length) blocking.push(`${ax.id}: missing does_not_apply_when`);
    if (!ax.fields?.failure_risk) blocking.push(`${ax.id}: missing failure_risk`);
    if (!ax.human_lock) blocking.push(`${ax.id}: not locked`);
    if (!ax.feynman_restatement) warnings.push(`${ax.id}: missing Feynman restatement`);
  }

  // ── Misunderstanding Checks ────────────────────────────────────
  for (const ms of lockedMisunderstandings) {
    if (!ms.fields?.key_distinction || ms.fields.key_distinction.length < 20) blocking.push(`${ms.id}: key_distinction too short`);
  }

  // ── Self-check Checks ──────────────────────────────────────────
  for (const sc of lockedSelfChecks) {
    const q = sc.fields?.question || '';
    if (!q.endsWith('?')) blocking.push(`${sc.id}: self_check must end with ?`);
  }

  // ── Contradiction Check ────────────────────────────────────────
  for (const c of contradiction.detectContradictions(cards)) {
    (c.severity === 'blocking' ? blocking : warnings).push(c.message);
  }

  // ── Determine Grade ────────────────────────────────────────────
  const axiomsComplete = lockedAxioms.length >= 1 &&
    lockedAxioms.every(ax => ax.fields?.applies_when?.length && ax.fields?.does_not_apply_when?.length && ax.fields?.failure_risk && ax.human_lock);
  const feynmanRatio = lockedAxioms.length > 0 ? lockedAxioms.filter(ax => ax.feynman_restatement).length / lockedAxioms.length : 0;
  const allFeynman = lockedAxioms.every(ax => ax.feynman_restatement) && lockedMisunderstandings.every(ms => !ms.locked || ms.feynman_restatement);

  // Feynman quality threshold (v0.6.2)
  const feynmanQuality = lockedAxioms.every(ax => {
    if (!ax.feynman_restatement?.score) return false;
    return ax.feynman_restatement.score.total >= 4;
  });
  const misunderstandingFeynmanQuality = lockedMisunderstandings.length === 0 ||
    lockedMisunderstandings.every(ms => {
      if (!ms.feynman_restatement?.score) return false;
      return ms.feynman_restatement.score.total >= 3;
    });
  if (allFeynman && !feynmanQuality) {
    warnings.push('Feynman: axiom restatements should score ≥4/5 for publishable grade');
  }

  // Compare test results requirements (v0.6.4)
  const withKdnaBetter = ratedTests.filter(t => t.result === 'with_kdna_better').length;
  const withoutKdnaBetter = ratedTests.filter(t => t.result === 'without_kdna_better').length;
  if (ratedTests.length > 0 && withoutKdnaBetter > 0) {
    warnings.push(`${withoutKdnaBetter} test(s) favored response WITHOUT KDNA — domain may not improve judgment`);
  }
  if (ratedTests.length > 0 && withKdnaBetter < 3 && ratedTests.length >= 5) {
    warnings.push(`Only ${withKdnaBetter} tests favor KDNA — recommend ≥3 for confidence`);
  }

  let grade = 'draft_grade';
  if (locked.length >= 3 && axiomsComplete && feynmanRatio >= 0.5) grade = 'human_controlled';
  if (grade === 'human_controlled' && ratedTests.length >= 5 && lockedSelfChecks.length >= 3) grade = 'tested_grade';
  if (grade === 'tested_grade' && ratedTests.length >= 10 && lockedAxioms.length >= 3 && lockedSelfChecks.length >= 5 && blocking.length === 0 && allFeynman && feynmanQuality && misunderstandingFeynmanQuality) {
    grade = 'publishable_grade';
  }

  // Downgrade if governance issues exist
  if (grade === 'publishable_grade' && govResult && !govResult.valid) {
    grade = 'tested_grade';
    warnings.push('Governance checks not passed — publishable downgraded to tested');
  }

  return buildResult(grade, blocking, warnings, project, { feynmanRatio, allFeynman, governance: govResult, i18n: i18nCoverage });
}

function buildResult(grade, blocking, warnings, project, detail = {}) {
  const lockedCount = (project.cards || []).filter(c => c.locked).length;
  const ratedTests = (project.tests || []).filter(t => t.result).length;

  return {
    grade,
    publishable: grade === 'publishable_grade' && blocking.length === 0,
    blocking,
    warnings,
    score: Math.max(0, 100 - blocking.length * 15 - warnings.length * 3),
    governance: detail.governance || null,
    i18n: detail.i18n || null,
    stats: {
      total_cards: (project.cards || []).length,
      locked_cards: lockedCount,
      locked_axioms: (project.cards || []).filter(c => c.type === 'axiom' && c.locked).length,
      locked_self_checks: (project.cards || []).filter(c => c.type === 'self_check' && c.locked).length,
      total_tests: (project.tests || []).length,
      rated_tests: ratedTests,
      feynman_ratio: detail.feynmanRatio !== undefined ? Math.round(detail.feynmanRatio * 100) + '%' : 'N/A',
      i18n_level: detail.i18n?.level || 'L0',
    },
    next_step: grade === 'draft_grade' ? 'Lock at least 3 axioms with boundaries and 50% Feynman.' :
      grade === 'human_controlled' ? 'Add 5+ rated evals and 3+ self-checks.' :
      grade === 'tested_grade' ? 'Add 10+ evals, complete Feynman on all axioms/misunderstandings, resolve all blocking issues.' :
      'Ready for Studio compile/export. Validate the resulting .kdna with kdna validate, plan with kdna plan-load, then load only when loadable.',
  };
}

function getBlockingIssues(project) { return computeReadiness(project).blocking; }

module.exports = { computeReadiness, getBlockingIssues };
