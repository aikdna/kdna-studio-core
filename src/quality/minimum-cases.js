/**
 * Minimum case set gate — requires the asset author to provide at least
 * the minimum fixture count per category before behavior-evaluated export.
 *
 * Per roadmap §7.1:
 *   - 8 positive target cases
 *   - 4 explicit non-applicable cases
 *   - 4 adjacent/ambiguous cases
 *   - 2 high-risk failure cases
 *   - 2 regression cases derived from real failures
 *   - An independent holdout split not used for authoring or repair
 */

const CATEGORY_MINIMUMS = {
  positive_target: { min: 8, label: 'Positive target cases', description: 'Tasks clearly in the asset domain' },
  non_applicable: { min: 4, label: 'Non-applicable cases', description: 'Tasks clearly outside scope — asset should skip' },
  adjacent_ambiguous: { min: 4, label: 'Adjacent/ambiguous cases', description: 'Tasks near the boundary — tests boundary behavior' },
  high_risk_failure: { min: 2, label: 'High-risk failure cases', description: 'Tasks where wrong judgment would cause harm' },
  regression: { min: 2, label: 'Regression cases', description: 'Tasks from previously observed real failures' },
  holdout: { min: 1, label: 'Holdout split', description: 'Independent cases not used for authoring or repair' },
};

/**
 * Check if the project's test cases meet the minimum count per category.
 *
 * @param {object} project — Studio project with linked test cases
 * @returns {{ valid: boolean, summary: object, missing: string[], errors: string[] }}
 */
function checkMinimumCaseSet(project) {
  const testCases = project.testCases || project.evals || [];
  const counts = {};
  for (const cat of Object.keys(CATEGORY_MINIMUMS)) counts[cat] = 0;

  for (const tc of testCases) {
    const cat = tc.category || tc.expected_category || 'positive_target';
    if (counts[cat] !== undefined) counts[cat]++;
    else counts[cat] = 1;
  }

  const missing = [];
  const errors = [];
  const summary = {};

  for (const [cat, config] of Object.entries(CATEGORY_MINIMUMS)) {
    const count = counts[cat] || 0;
    summary[cat] = { current: count, required: config.min, met: count >= config.min };
    if (count < config.min) {
      missing.push(cat);
      errors.push(`${config.label}: ${count}/${config.min} (${config.description})`);
    }
  }

  return {
    valid: missing.length === 0,
    summary,
    missing,
    errors,
    total_fixtures: testCases.length,
    total_required: Object.values(CATEGORY_MINIMUMS).reduce((s, c) => s + c.min, 0),
  };
}

/**
 * Generate a human-readable checklist of what cases are still needed.
 *
 * @param {object} result — output from checkMinimumCaseSet()
 * @returns {string} markdown checklist
 */
function formatCaseChecklist(result) {
  let md = '# Minimum Case Set Checklist\n\n';
  md += `**Status:** ${result.valid ? '✓ Complete' : '✗ Incomplete'}\n`;
  md += `**Fixtures:** ${result.total_fixtures} / ${result.total_required} minimum\n\n`;

  for (const [cat, config] of Object.entries(CATEGORY_MINIMUMS)) {
    const status = result.summary[cat];
    const check = status.met ? '✓' : '✗';
    md += `- ${check} **${config.label}:** ${status.current} / ${config.min}\n`;
    md += `  - _${config.description}_\n`;
  }

  if (!result.valid) {
    md += '\n## Missing Cases\n\n';
    for (const err of result.errors) {
      md += `- ${err}\n`;
    }
  }

  return md;
}

module.exports = {
  CATEGORY_MINIMUMS,
  checkMinimumCaseSet,
  formatCaseChecklist,
};
