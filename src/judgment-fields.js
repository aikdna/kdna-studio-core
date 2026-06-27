/**
 * Shared judgment field definitions for Human Lock gate and fingerprinting.
 * Used by both cards/index.js and project/index.js to avoid circular deps.
 */

const JUDGMENT_CARD_TYPES = new Set(['axiom', 'boundary', 'risk', 'aesthetic']);

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
