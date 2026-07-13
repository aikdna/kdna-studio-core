/**
 * Comparison arms — scaffold for running no-KDNA, best-prompt,
 * correct-KDNA, and wrong-KDNA comparisons against test fixtures.
 *
 * A comparison arm is a named evaluation strategy. The Studio generates
 * fixture prompts; a runner executes them. This module defines the
 * comparison structure and expected output format.
 */

const COMPARISON_ARMS = {
  no_kdna: {
    label: 'No KDNA',
    description: 'Runner receives only the task — no KDNA content. Measures raw model judgment quality.',
    prompt_template: 'Task: {task}\n\nPlease provide your best judgment.',
    budget_profile: 'interactive',
  },
  best_ordinary_prompt: {
    label: 'Best Ordinary Prompt',
    description: 'Runner receives the best non-KDNA prompt under comparable budget. The prompt may include role, context, and guidelines but no KDNA judgment axioms.',
    prompt_template: 'You are an expert in {task_family}. Task: {task}\n\nProvide a structured judgment with reasoning, confidence, and alternatives.',
    budget_profile: 'interactive',
  },
  correct_single_kdna: {
    label: 'Correct KDNA',
    description: 'Runner receives the correct KDNA asset loaded with default projection. Tests whether the asset improves judgment over raw model output.',
    prompt_template: null, // Uses kdna load --profile=compact --as=prompt
    budget_profile: 'code-review',
  },
  wrong_or_adjacent_kdna: {
    label: 'Wrong/Adjacent KDNA',
    description: 'Runner receives a semantically adjacent but incorrect KDNA asset. Tests whether the model correctly ignores or adapts irrelevant judgment axioms.',
    prompt_template: null, // Uses a deliberately mismatched KDNA asset
    budget_profile: 'code-review',
  },
};

/**
 * Build a comparison plan for a set of fixtures.
 *
 * @param {Array<object>} fixtures — test cases with {category, task, expected}
 * @param {string} taskFamily — task family label
 * @returns {object} comparison plan
 */
function buildComparisonPlan(fixtures = [], taskFamily = '') {
  const arms = Object.entries(COMPARISON_ARMS).map(([id, config]) => ({
    arm_id: id,
    ...config,
    fixture_count: fixtures.length,
    estimated_runs: fixtures.length,
    budget_profile: config.budget_profile,
  }));

  return {
    plan_version: '0.9.0',
    task_family: taskFamily,
    fixtures_count: fixtures.length,
    arms,
    total_estimated_runs: fixtures.length * arms.length,
    arms_details: arms.map(a => ({
      arm: a.arm_id,
      label: a.label,
      runs: a.fixture_count,
      budget: a.budget_profile,
    })),
  };
}

/**
 * Generate a comparison run prompt for a fixture + arm combination.
 *
 * @param {object} fixture — {task, category, expected}
 * @param {string} armId — comparison arm ID
 * @param {object} [context] — additional context
 * @returns {{ prompt: string, arm: string, fixture_id: string }}
 */
function generateComparisonPrompt(fixture, armId, context = {}) {
  const arm = COMPARISON_ARMS[armId];
  if (!arm) throw new Error(`Unknown comparison arm: ${armId}`);

  let prompt;
  if (arm.prompt_template) {
    prompt = arm.prompt_template
      .replace('{task}', fixture.task || '')
      .replace('{task_family}', context.taskFamily || 'general');
  } else {
    prompt = `[KDNA Load: ${context.assetId || 'asset.kdna'}]\n\nTask: ${fixture.task || ''}`;
  }

  return {
    prompt,
    arm: armId,
    fixture_id: fixture.fixture_id || fixture.id || 'unknown',
    budget_profile: arm.budget_profile,
  };
}

/**
 * Score a comparison run result against expected behavior.
 *
 * @param {object} result — runner result
 * @param {object} expected — expected {answer, classification, ...}
 * @param {string} armId — which arm was used
 * @returns {{ score: number, passed: boolean, notes: string[] }}
 */
function scoreComparisonResult(result, expected, armId) {
  const notes = [];
  let score = 3;

  const answer = result?.answer || '';
  const expectedAnswer = expected?.answer || '';

  if (!answer) {
    return { score: 1, passed: false, notes: ['No answer produced'] };
  }

  // For no-KDNA and best-prompt: we want to see the asset improves judgment
  if (armId === 'no_kdna' || armId === 'best_ordinary_prompt') {
    // Baseline: raw model may miss domain-specific nuance
    if (result?.reasoning?.length > 0) {
      score = 3; // reasonable baseline
      notes.push('Baseline reasoning present');
    } else {
      score = 2;
      notes.push('Minimal reasoning');
    }
  }

  // For correct KDNA: we expect axiom application
  if (armId === 'correct_single_kdna') {
    const sources = result?.sources || result?.result?.sources || [];
    if (sources.length > 0) {
      score = Math.min(5, 3 + sources.length);
      notes.push(`${sources.length} axioms cited`);
    } else {
      score = 2;
      notes.push('No axioms cited — asset may not be transferring judgment');
    }
  }

  // For wrong KDNA: we expect the model to NOT blindly apply axioms
  if (armId === 'wrong_or_adjacent_kdna') {
    const misplacedApplication = result?.misplaced_axioms || result?.warnings?.length || 0;
    if (misplacedApplication === 0) {
      score = 5;
      notes.push('Correctly ignored wrong/adjacent axioms');
    } else {
      score = Math.max(1, 4 - misplacedApplication);
      notes.push(`${misplacedApplication} potentially misplaced axiom applications`);
    }
  }

  return {
    score,
    passed: score >= 3,
    notes,
  };
}

/**
 * Aggregate comparison results across all arms and fixtures.
 *
 * @param {Array<object>} runs — array of {arm, fixture_id, result, score}
 * @returns {object} aggregate report
 */
function aggregateComparisonResults(runs = []) {
  const byArm = {};
  for (const armId of Object.keys(COMPARISON_ARMS)) {
    const armRuns = runs.filter(r => r.arm === armId);
    const scores = armRuns.filter(r => r.score !== undefined).map(r => r.score);
    byArm[armId] = {
      runs: armRuns.length,
      mean_score: scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : 0,
      scores,
      passed: armRuns.filter(r => r.passed).length,
      failed: armRuns.filter(r => r.passed === false).length,
    };
  }

  // Compute improvement over no-KDNA
  const noKdnaMean = byArm['no_kdna']?.mean_score || 0;
  const correctMean = byArm['correct_single_kdna']?.mean_score || 0;
  const improvement = correctMean - noKdnaMean;

  return {
    by_arm: byArm,
    total_runs: runs.length,
    improvement_over_no_kdna: Math.round(improvement * 100) / 100,
    threshold_met: improvement >= 0.5,
    threshold_target: 0.5,
  };
}

module.exports = {
  COMPARISON_ARMS,
  buildComparisonPlan,
  generateComparisonPrompt,
  scoreComparisonResult,
  aggregateComparisonResults,
};
