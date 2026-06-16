/**
 * Source Authority Graph (SAG) compile gate for kdna-studio-core.
 *
 * Implements the SAG gate from RFC-0013 §3.1 / §9 #3.
 *
 * Behavior:
 *   - Default mode: all rules are reported as WARNINGS (soft).
 *   - Strict-authority mode: hard-rule violations become ERRORS.
 *   - If no sourceAuthority provided, gate skips silently
 *     (backwards-compatible: legacy workspaces without SAG pass through).
 *
 * Rules checked:
 *   R1. precedence_order entries must all reference an existing source id.
 *   R2. At least one source must have authority: "current_highest"
 *       (when SAG is present; soft warning in default mode).
 *   R3. authority/status consistency:
 *         - authority: "deprecated" requires status: "deprecated"
 *         - authority: "current_highest" requires status: "active"
 *         - deprecated sources must not appear in precedence_order.
 *   R4. In precedence_order (highest precedence first), the first
 *       current_highest must not be preceded by any lower-authority
 *       source.
 *   R5. sources_contain_pii=true without author_consent_on_file is
 *       a soft warning (we are not the consent authority).
 *
 * Output contract:
 *   {
 *     gate: 'source_authority',
 *     status: 'skipped' | 'pass' | 'warn' | 'fail',
 *     errors: [string, ...],   // strict-only; empty in default mode
 *     warnings: [string, ...], // always populated for any rule
 *     source_authority: object | null,
 *     strict_authority: boolean
 *   }
 */

const AUTHORITY_RANK = {
  current_highest: 4,
  thought_mine: 3,
  historical_baseline: 2,
  exemplar_case: 1,
  deprecated: 0,
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function runSagGate(sourceAuthority, opts = {}) {
  const strict = !!opts.strict;
  const result = {
    gate: 'source_authority',
    status: 'skipped',
    errors: [],
    warnings: [],
    source_authority: sourceAuthority || null,
    strict_authority: strict,
  };

  if (!isPlainObject(sourceAuthority)) {
    result.status = 'skipped';
    result.warnings.push('No source_authority.json provided; SAG gate skipped.');
    return result;
  }

  // R1. precedence_order references must be valid source ids.
  const sources = Array.isArray(sourceAuthority.sources) ? sourceAuthority.sources : [];
  const sourceIds = new Set();
  for (const s of sources) {
    if (isPlainObject(s) && typeof s.id === 'string') {
      sourceIds.add(s.id);
    }
  }
  const order = Array.isArray(sourceAuthority.precedence_order) ? sourceAuthority.precedence_order : [];
  const missing = order.filter((id) => !sourceIds.has(id));
  if (missing.length > 0) {
    const msg = `source_authority.json: precedence_order references unknown source id(s): ${missing.join(', ')}.`;
    if (strict) result.errors.push(msg);
    else result.warnings.push(msg);
  }

  // R2. At least one current_highest source.
  const highest = sources.filter(
    (s) => isPlainObject(s) && s.authority === 'current_highest',
  );
  if (highest.length === 0) {
    const msg = 'source_authority.json: no source has authority "current_highest"; at least one current_highest source is required to establish current authority.';
    if (strict) result.errors.push(msg);
    else result.warnings.push(msg);
  }

  // R3. authority/status consistency.
  for (const s of sources) {
    if (!isPlainObject(s)) continue;
    if (s.authority === 'deprecated' && s.status !== 'deprecated') {
      const msg = `source_authority.json: source "${s.id}" has authority "deprecated" but status is "${s.status}"; status MUST be "deprecated" when authority is "deprecated".`;
      if (strict) result.errors.push(msg);
      else result.warnings.push(msg);
    }
    if (s.authority === 'current_highest' && s.status !== 'active') {
      const msg = `source_authority.json: source "${s.id}" has authority "current_highest" but status is "${s.status}"; status MUST be "active" for current_highest sources.`;
      if (strict) result.errors.push(msg);
      else result.warnings.push(msg);
    }
    if (s.authority === 'deprecated' && order.includes(s.id)) {
      const msg = `source_authority.json: deprecated source "${s.id}" appears in precedence_order; deprecated sources cannot be authoritative precursors.`;
      if (strict) result.errors.push(msg);
      else result.warnings.push(msg);
    }
  }

  // R4. In precedence_order, the first current_highest must not be
  // preceded by any lower-authority source.
  if (order.length > 0 && highest.length > 0) {
    const firstHighestIdx = Math.min(
      ...order
        .map((id, i) => ({ id, i, isHighest: highest.some((h) => h.id === id) }))
        .filter((e) => e.isHighest)
        .map((e) => e.i),
    );
    if (Number.isFinite(firstHighestIdx)) {
      for (let i = 0; i < firstHighestIdx; i++) {
        const id = order[i];
        const src = sources.find((s) => isPlainObject(s) && s.id === id);
        if (!src) continue;
        if (
          AUTHORITY_RANK[src.authority] !== undefined &&
          AUTHORITY_RANK[src.authority] < AUTHORITY_RANK.current_highest
        ) {
          const msg = `source_authority.json: lower-authority source "${src.id}" (${src.authority}) appears before current_highest in precedence_order; current_highest must override.`;
          if (strict) result.errors.push(msg);
          else result.warnings.push(msg);
        }
      }
    }
  }

  // R5. PII without consent is a soft warning only.
  const sensitivity = sourceAuthority.sensitivity || {};
  if (sensitivity.sources_contain_pii === true && sensitivity.author_consent_on_file !== true) {
    result.warnings.push(
      'source_authority.json: sensitivity.sources_contain_pii is true but author_consent_on_file is not true; recording author consent is recommended before publishing.',
    );
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

module.exports = { runSagGate, AUTHORITY_RANK };
