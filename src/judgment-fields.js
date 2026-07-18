/**
 * Shared judgment field definitions for Human Lock gate and fingerprinting.
 * Used by both cards/index.js and project/index.js to avoid circular deps.
 */

// All card types the Human Lock gate treats as substantive judgment
// content. Expanding this set was bug #23: prior version only covered
// 4 of 16 types (axiom / boundary / risk / aesthetic), so the other
// 12 could be exported un-locked.
//
// Anything in this set is held to the same lock + checked-fields
// requirements before export. Anything outside it (today: none — every
// CARD_TYPES entry is judgment-bearing) would be allowed through.
const JUDGMENT_CARD_TYPES = new Set([
  'axiom', 'boundary', 'risk', 'aesthetic',
  'ontology', 'misunderstanding', 'self_check', 'scenario', 'case',
  'stance', 'pattern', 'reasoning', 'framework',
  'term', 'banned_term', 'evolution_stage',
]);

// Historical list retained as a public export for consumers that use it to
// render review UIs. Human Lock fingerprinting intentionally does not use an
// allow-list: every value inside card.fields is authored judgment content.
//
// Bug: prior version was missing `name`, `description`, and `mitigation`,
// which are the primary required fields for `risk` and `aesthetic` cards.
// That let a card keep its old fingerprint after those fields were edited.
const JUDGMENT_FIELDS = new Set([
  'one_sentence', 'full_statement', 'why', 'essence', 'boundary',
  'wrong', 'correct', 'key_distinction', 'question', 'scope',
  'out_of_scope', 'applies_when', 'does_not_apply_when', 'failure_risk',
  'acceptable_exceptions', 'trigger_signal', 'when_to_use', 'steps',
  'name', 'description', 'mitigation',
  // Phase 3: explicit target and consequence fields
  'target_user', 'target_decision', 'decision_consequence',
  'evidence_prerequisite', 'insufficient_evidence_action',
]);

const crypto = require('crypto');

function cardJudgmentFingerprint(card) {
  const fields = card.fields || {};
  function canonicalJson(value) {
    if (value === undefined) return undefined;
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalJson(entry) ?? 'null').join(',')}]`;
    }
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return crypto.createHash('sha256')
    .update(card.type + ':' + canonicalJson(fields))
    .digest('hex');
}

module.exports = { JUDGMENT_CARD_TYPES, JUDGMENT_FIELDS, cardJudgmentFingerprint };
