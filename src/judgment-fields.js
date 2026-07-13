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

// All judgment-field names that may appear on any judgment card type.
// The fingerprint is computed across all of these so that a Human Lock
// signature cannot be reused against a card whose only non-axiom fields
// were silently changed.
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
  const relevant = {};
  for (const key of JUDGMENT_FIELDS) {
    if (key in fields) relevant[key] = fields[key];
  }
  return crypto.createHash('sha256')
    .update(card.type + ':' + JSON.stringify(relevant, Object.keys(relevant).sort()))
    .digest('hex');
}

module.exports = { JUDGMENT_CARD_TYPES, JUDGMENT_FIELDS, cardJudgmentFingerprint };
