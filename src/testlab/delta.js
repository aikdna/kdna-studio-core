/**
 * Judgment Delta — Structured comparison of agent response with vs without KDNA.
 *
 * Parses kdna compare output (text or JSON) into structured axes:
 *   1. CLASSIFICATION — how the task was classified
 *   2. DIAGNOSIS — root cause identified
 *   3. ACTIONS — what the response suggests
 *   4. BOUNDARY — scope awareness
 *   5. TERMINOLOGY — domain-specific terms used
 *
 * Also supports scoring along the D1-D7 dimensions defined in the
 * KDNA Compare Report specification.
 */

function parseCompareOutput(diffText) {
  const axes = {};
  const matches = diffText.matchAll(/^(\d)\.\s*(\w+(?:\s+\w+)*):\s*(.+)$/gim);
  for (const m of matches) {
    const name = m[2].toLowerCase().replace(/\s+/g, '_');
    const value = m[3].trim();
    if (value.toUpperCase() !== 'SAME') {
      axes[name] = value;
    }
  }

  // Legacy format: "<axis>: <value>"
  if (Object.keys(axes).length === 0) {
    const legacyMatch = diffText.matchAll(/^(\w+):\s*(.+)$/gim);
    for (const m of legacyMatch) {
      const name = m[1].toLowerCase();
      const value = m[2].trim();
      if (name === 'verdict') continue;
      if (value.toUpperCase() !== 'SAME') {
        axes[name] = value;
      }
    }
  }

  const verdictMatch = diffText.match(/VERDICT:\s*(.+)/i);
  const verdict = verdictMatch ? verdictMatch[1].trim().toLowerCase() : 'trajectory_unchanged';

  return { axes, verdict };
}

function scoreDelta(axes) {
  let score = 5;
  const changed = [];
  for (const [axis, value] of Object.entries(axes)) {
    changed.push({ axis, value: value.slice(0, 100) });
    score = Math.min(10, score + 1);
  }
  return { score: Math.min(10, score), changed };
}

function createJudgmentDelta(domain, input, responseA, responseB, diffText, options = {}) {
  const { axes, verdict } = parseCompareOutput(diffText);
  const domainScore = scoreDelta(axes);
  const triggeredAxioms = options.triggeredAxioms || [];
  const avoidedMisunderstandings = options.avoidedMisunderstandings || [];
  const selfChecksPassed = options.selfChecksPassed || null;

  return {
    meta: {
      domain,
      input: input.slice(0, 200),
      model: options.model || 'unknown',
      timestamp: new Date().toISOString(),
    },
    classification: {
      without_kdna: axes.classification || 'generic',
      with_kdna: axes.classification ? 'domain_specific' : 'unchanged',
      changed: !!axes.classification,
    },
    axes,
    verdict,
    score: domainScore.score,
    changed_dimensions: domainScore.changed,
    triggered_axioms: triggeredAxioms,
    avoided_misunderstandings: avoidedMisunderstandings,
    self_checks_passed: selfChecksPassed,
    scoring: buildScoring(axes, domainScore, selfChecksPassed),
    summary: buildSummary(domain, domainScore, verdict),
  };
}

function buildScoring(axes, domainScore, selfChecksPassed) {
  return {
    D1_diagnostic_depth: axes.diagnosis ? 8 : 5,
    D2_terminology_precision: axes.terminology ? 8 : 5,
    D3_misunderstanding_detection: 5,
    D4_axiom_alignment: domainScore.score,
    D5_self_check_pass_rate: selfChecksPassed !== null
      ? `${selfChecksPassed}%`
      : 'N/A',
    D6_boundary_respect: axes.boundary_awareness || axes.boundary ? 'Pass' : 'N/A',
    D7_risk_avoidance: 'N/A',
  };
}

function buildSummary(domain, domainScore, verdict) {
  const changed = domainScore.changed.map(c => `**${c.axis}**`).join(', ');
  if (changed.length === 0) {
    return `Loading \`${domain}\` did not significantly alter the judgment trajectory for this input.`;
  }
  if (verdict.includes('changed')) {
    return `Loading \`${domain}\` changed the agent's response across ${domainScore.changed.length} dimensions: ${changed}. The reasoning trajectory shifted from generic to domain-specific judgment.`;
  }
  return `Loading \`${domain}\` produced changes in ${domainScore.changed.length} dimensions: ${changed}.`;
}

function compareDeltas(delta1, delta2) {
  const diffs = [];
  for (const axis of ['classification', 'diagnosis', 'actions', 'boundary_awareness', 'terminology']) {
    const v1 = delta1.axes[axis] || 'SAME';
    const v2 = delta2.axes[axis] || 'SAME';
    if (v1 !== v2) {
      diffs.push({ axis, before: v1, after: v2 });
    }
  }
  return {
    score_change: delta2.score - delta1.score,
    verdict_before: delta1.verdict,
    verdict_after: delta2.verdict,
    axis_diffs: diffs,
    improved: delta2.score > delta1.score,
  };
}

function formatDeltaMarkdown(delta) {
  const lines = [];
  lines.push('# KDNA Judgment Comparison Report'); lines.push('');
  lines.push(`**Domain:** ${delta.meta.domain}`);
  lines.push(`**Model:** ${delta.meta.model}`);
  lines.push(`**Date:** ${delta.meta.timestamp}`); lines.push('');
  lines.push('## Judgment Diff'); lines.push('');
  lines.push('| Dimension | Change |'); lines.push('|-----------|--------|');
  for (const d of delta.changed_dimensions) lines.push(`| ${d.axis} | **Changed**: ${d.value} |`);
  if (!delta.changed_dimensions.length) lines.push('| (none) | No significant change |');
  lines.push('');
  lines.push('## Scoring'); lines.push('');
  for (const [dim, value] of Object.entries(delta.scoring)) lines.push(`- **${dim}:** ${value}`);
  lines.push('');
  lines.push(`**Verdict:** ${delta.verdict.replace(/_/g, ' ')}`); lines.push('');
  lines.push(delta.summary);
  return lines.join('\n');
}

// ─── JSON report parsing (v0.3.3) ─────────────────────────────────────

function parseCompareReportJson(report) {
  if (!report || !report.diff) return { axes: {}, verdict: 'trajectory_unchanged' };

  const axes = {};
  // Extract axes from structured report format
  if (report.diff.axes) {
    for (const [axis, value] of Object.entries(report.diff.axes)) {
      if (value && String(value).toUpperCase() !== 'SAME') axes[axis] = String(value);
    }
    return { axes, verdict: report.diff.verdict || 'trajectory_unchanged' };
  }

  // Legacy: raw baseline/kdna comparison
  if (report.without_kdna && report.with_kdna) {
    if (report.without_kdna.classification !== report.with_kdna.classification)
      axes.classification = 'changed';
    return { axes, verdict: Object.keys(axes).length > 0 ? 'trajectory_changed' : 'trajectory_unchanged' };
  }

  return { axes: {}, verdict: 'trajectory_unchanged' };
}

function createJudgmentDeltaFromReport(domain, input, report, options = {}) {
  const { axes, verdict } = parseCompareReportJson(report);
  const domainScore = scoreDelta(axes);

  return {
    meta: { domain, input: (input || '').slice(0, 200), model: report.meta?.model || options.model || 'unknown',
      timestamp: new Date().toISOString() },
    classification: { without_kdna: axes.classification || 'generic',
      with_kdna: axes.classification ? 'domain_specific' : 'unchanged', changed: !!axes.classification },
    axes, verdict,
    score: domainScore.score,
    changed_dimensions: domainScore.changed,
    triggered_axioms: options.triggeredAxioms || [],
    avoided_misunderstandings: options.avoidedMisunderstandings || [],
    self_checks_passed: options.selfChecksPassed || null,
    scoring: buildScoring(axes, domainScore, options.selfChecksPassed),
    summary: buildSummary(domain, domainScore, verdict),
  };
}

module.exports = { parseCompareOutput, parseCompareReportJson, scoreDelta,
  createJudgmentDelta, createJudgmentDeltaFromReport, compareDeltas, formatDeltaMarkdown };
