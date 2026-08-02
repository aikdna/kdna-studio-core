/**
 * Legacy authoring granularity diagnostics.
 *
 * This module is not used by the Creation Engine acceptance path. Its lexical
 * hints are advisory only: conjunctions and text length cannot decide whether
 * one asset must be split. A split needs evidence of independent scope,
 * authorization, lifecycle, or an unresolved semantic conflict.
 */

const GRANULARITY_LEVELS = ["narrow", "well_scoped", "broad", "mixed"];

const TOO_BROAD_SIGNALS = [
  "everything",
  "all aspects",
  "any decision",
  "comprehensive",
  "general purpose",
  "万能",
  "所有",
  "任何",
  "全部",
  "一切",
];

const TOO_NARROW_SIGNALS = [
  "exactly",
  "precisely this one",
  "never again",
  "one-time",
  "only this instance",
  "仅此一次",
  "只有这个",
  "特例",
];

const VAGUE_SIGNALS = [
  "depends",
  "it varies",
  "maybe",
  "sometimes",
  "it depends",
  "case by case",
  "看情况",
  "视情况而定",
];

/**
 * Diagnose the granularity of a judgment expressed in project cards.
 *
 * @param {object} project — Studio project with cards
 * @returns {{
 *   level: string,
 *   score: number,
 *   diagnostics: Array<{severity: string, message: string, suggestion: string}>,
 *   recommended_action: string
 * }}
 */
function diagnoseGranularity(project) {
  const cards = project.cards || [];
  const judgmentCards = cards.filter(
    (c) => c.status === "locked" || c.type === "axiom",
  );

  const diagnostics = [];
  let broadHits = 0;
  let narrowHits = 0;
  let vagueHits = 0;

  // Gather all judgment text
  const allText = judgmentCards
    .map((c) => {
      const f = c.fields || {};
      return [
        f.one_sentence,
        f.full_statement,
        f.why,
        f.applies_when,
        f.does_not_apply_when,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    })
    .join(" ");

  // Check too-broad signals
  for (const signal of TOO_BROAD_SIGNALS) {
    if (allText.includes(signal)) {
      broadHits++;
      diagnostics.push({
        severity: "warn",
        message: `Broad signal detected: "${signal}" — judgment may cover too many decision types`,
        suggestion:
          "Narrow the judgment to one specific decision type. What exact situation does this apply to?",
      });
    }
  }

  // Check too-narrow signals
  for (const signal of TOO_NARROW_SIGNALS) {
    if (allText.includes(signal)) {
      narrowHits++;
      diagnostics.push({
        severity: "warn",
        message: `Narrow signal detected: "${signal}" — judgment may not be reusable`,
        suggestion:
          "Generalize slightly: what pattern does this instance represent?",
      });
    }
  }

  // Check vague signals
  for (const signal of VAGUE_SIGNALS) {
    if (allText.includes(signal)) {
      vagueHits++;
      diagnostics.push({
        severity: "info",
        message: `Vague signal detected: "${signal}" — judgment may lack clear criteria`,
        suggestion:
          "Define specific conditions: when exactly does this judgment apply, and when does it not?",
      });
    }
  }

  // Determine level
  let level = "well_scoped";
  let score = 8;

  if (broadHits >= 3) {
    level = "broad";
    score = Math.max(1, 6 - broadHits);
  } else if (narrowHits >= 3) {
    level = "narrow";
    score = Math.max(1, 6 - narrowHits);
  } else if (broadHits > 0) {
    level = "broad";
    score = 6;
  } else if (narrowHits > 0) {
    level = "narrow";
    score = 6;
  } else if (vagueHits >= 3) {
    score = 4;
  }

  // Recommended action
  let recommendedAction = "Ready for Human Lock.";
  if (level === "broad") {
    recommendedAction =
      "WARNING: Consider narrowing the judgment scope before locking. Define what specific decision this helps with.";
  } else if (level === "narrow") {
    recommendedAction =
      "INFO: Judgment may be too specific. Ensure it generalizes to similar situations before locking.";
  }

  return {
    level,
    score,
    diagnostics,
    recommended_action: recommendedAction,
    passed: true,
  };
}

/**
 * Check if an opening question produces a well-scoped answer.
 *
 * The opening question is: "Which repeated judgment should become reusable?"
 *
 * @param {string} answer — user's answer to the opening question
 * @returns {{ scoped: boolean, issues: string[], suggestion: string }}
 */
function evaluateOpeningQuestion(answer) {
  const issues = [];
  const lower = (answer || "").toLowerCase();

  if (!answer || answer.trim().length < 10) {
    return {
      scoped: false,
      issues: ["Answer too short — needs at least one sentence."],
      suggestion:
        "Describe: who makes this judgment, about what, and what decision follows?",
    };
  }

  if (lower.includes("when") && lower.includes("should")) {
    // Good sign — conditional judgment
  } else {
    issues.push(
      'Consider framing as "When X happens, should Y?" rather than a general statement.',
    );
  }

  return {
    scoped: issues.length === 0,
    issues,
    suggestion:
      issues.length > 0
        ? 'Rephrase as: "When [situation], should [decision-maker] [action]?"'
        : "",
  };
}

module.exports = {
  GRANULARITY_LEVELS,
  diagnoseGranularity,
  evaluateOpeningQuestion,
};
