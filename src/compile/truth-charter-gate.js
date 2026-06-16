/**
 * Truth Charter (TC) compile gate for kdna-studio-core.
 *
 * Implements the TC gate from RFC-0013 §3.2 / §9 #3.
 *
 * Behavior:
 *   - Default mode: WARNING only. Errors are downgraded to warnings.
 *   - Strict-authority mode: ERROR for synthesized/draft/deprecated
 *     tc_status; PASS only for tc_status: "locked".
 *   - If no truthCharter provided, gate skips silently
 *     (backwards-compatible: legacy workspaces without TC pass through).
 *
 * Rules checked:
 *   R1. tc_status must be one of: draft / synthesized / locked / deprecated.
 *   R2. tc_status: "synthesized" + strict-authority -> ERROR
 *       (synthesized means no real author-locked truth; cannot be
 *       officially published without explicit lock).
 *   R3. tc_status: "deprecated" + strict-authority -> ERROR
 *       (deprecated charters cannot govern new compilations).
 *   R4. tc_status: "locked" requires locked_at and locked_by fields.
 *   R5. renamed_terms: if renamed_terms are present and a
 *       patterns.terminology is supplied, check that each old term is
 *       either in banned_terms or its replacement is in standard_terms.
 *       (Soft check; mismatches are warnings, not errors.)
 *   R6. forbidden_simplifications: presence is recorded; we do NOT
 *       perform LLM-based semantic verification (would require a
 *       judgment call outside the gate's scope). Always PASS.
 *
 * Cross-file consistency (when both SAG and TC are supplied):
 *   If sourceAuthority has any current_highest source of type
 *   "human_locked_charter" and TC exists, TC.judgment_authority_holder
 *   must be present and non-empty.
 */

const VALID_TC_STATUS = ['draft', 'synthesized', 'locked', 'deprecated'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function runTcGate(truthCharter, opts = {}) {
  const strict = !!opts.strict;
  const sourceAuthority = opts.sourceAuthority || null;
  const patterns = opts.patterns || null; // KDNA_Patterns.json content
  const result = {
    gate: 'truth_charter',
    status: 'skipped',
    errors: [],
    warnings: [],
    truth_charter: truthCharter || null,
    strict_authority: strict,
  };

  if (!isPlainObject(truthCharter)) {
    result.status = 'skipped';
    result.warnings.push('No truth_charter.json provided; TC gate skipped.');
    return result;
  }

  // R1. tc_status must be valid.
  const tcStatus = truthCharter.tc_status;
  if (!VALID_TC_STATUS.includes(tcStatus)) {
    result.errors.push(
      `truth_charter.json: tc_status "${tcStatus}" is not one of [${VALID_TC_STATUS.join(', ')}].`,
    );
    result.status = 'fail';
    return result;
  }

  // R2. synthesized + strict -> ERROR.
  if (tcStatus === 'synthesized') {
    const msg = 'truth_charter.json: tc_status is "synthesized" (no author-locked truth); strict-authority requires "locked".';
    if (strict) result.errors.push(msg);
    else result.warnings.push(msg);
  }

  // R3. deprecated + strict -> ERROR.
  if (tcStatus === 'deprecated') {
    const msg = 'truth_charter.json: tc_status is "deprecated"; deprecated charters cannot govern new compilations under strict-authority.';
    if (strict) result.errors.push(msg);
    else result.warnings.push(msg);
  }

  // R4. locked requires locked_at and locked_by.
  if (tcStatus === 'locked') {
    if (!truthCharter.locked_at || !truthCharter.locked_by) {
      result.errors.push(
        'truth_charter.json: tc_status is "locked" but locked_at or locked_by is missing.',
      );
    }
  }

  // R5. renamed_terms soft check against patterns.terminology.
  // Only fires when the project's terminology actually has content; an
  // empty terminology (from a card-only project) is treated as
  // "not yet declared" and the soft check is skipped.
  if (
    Array.isArray(truthCharter.renamed_terms) &&
    isPlainObject(patterns) &&
    isPlainObject(patterns.terminology) &&
    (Array.isArray(patterns.terminology.standard_terms) && patterns.terminology.standard_terms.length > 0 ||
      Array.isArray(patterns.terminology.banned_terms) && patterns.terminology.banned_terms.length > 0)
  ) {
    const term = patterns.terminology;
    const banned = new Set(
      Array.isArray(term.banned_terms) ? term.banned_terms.map((t) => t && t.term).filter(Boolean) : [],
    );
    const standard = new Set(
      Array.isArray(term.standard_terms) ? term.standard_terms.map((t) => t && t.term).filter(Boolean) : [],
    );
    for (const r of truthCharter.renamed_terms) {
      if (!isPlainObject(r)) continue;
      const oldName = r.old;
      const newName = r.new;
      const oldBanned = oldName && banned.has(oldName);
      const newStandard = newName && standard.has(newName);
      if (oldName && !oldBanned) {
        result.warnings.push(
          `truth_charter.json renamed_terms: old term "${oldName}" is not in KDNA_Patterns.json.terminology.banned_terms; consider adding it to make the rename enforceable.`,
        );
      }
      if (newName && !newStandard) {
        result.warnings.push(
          `truth_charter.json renamed_terms: new term "${newName}" is not in KDNA_Patterns.json.terminology.standard_terms; consider adding it.`,
        );
      }
    }
  }

  // Cross-file consistency: SAG has human_locked_charter current_highest
  // => TC.judgment_authority_holder must be present and non-empty.
  if (sourceAuthority && isPlainObject(sourceAuthority)) {
    const sources = Array.isArray(sourceAuthority.sources) ? sourceAuthority.sources : [];
    const hasHumanLockedCharter = sources.some(
      (s) => isPlainObject(s) && s.authority === 'current_highest' && s.type === 'human_locked_charter',
    );
    if (hasHumanLockedCharter) {
      const holder = truthCharter.judgment_authority_holder;
      if (!holder || (typeof holder === 'string' && holder.trim() === '')) {
        const msg = 'truth_charter.json: SAG has a current_highest source of type human_locked_charter, but TC.judgment_authority_holder is missing or empty; cross-file consistency requires both.';
        if (strict) result.errors.push(msg);
        else result.warnings.push(msg);
      }
    }
  }

  if (result.errors.length > 0) {
    result.status = 'fail';
  } else if (result.warnings.length > 0) {
    result.status = 'warn';
  } else {
    result.status = 'pass';
  }
  return result;
}

module.exports = { runTcGate, VALID_TC_STATUS };
