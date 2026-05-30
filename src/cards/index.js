/**
 * Judgment Card state machine and lifecycle.
 *
 * Responsibilities:
 *   - Card CRUD operations
 *   - State machine enforcement (Draft → Revised → Locked → Tested → Published → Deprecated)
 *   - Human Lock protocol
 *   - Feynman Restatement
 *   - Audit trail management
 */

const { cardJudgmentFingerprint } = require('../judgment-fields');

const VALID_STATES = ['draft', 'revised', 'locked', 'tested', 'published', 'deprecated'];
const CARD_TYPES = ['axiom', 'ontology', 'misunderstanding', 'boundary', 'self_check', 'risk', 'aesthetic', 'scenario', 'case'];

const TRANSITIONS = {
  draft: ['revised', 'deprecated'],
  revised: ['locked', 'draft', 'deprecated'],
  locked: ['tested', 'revised', 'deprecated'],
  tested: ['published', 'locked', 'deprecated'],
  published: ['deprecated'],
  deprecated: [],
};

function createCard(type, fields = {}, id = null) {
  if (!CARD_TYPES.includes(type)) throw new Error(`Invalid card type: ${type}`);
  const card = {
    id: id || `${type.slice(0, 2)}_${require('crypto').randomUUID()}`,
    type,
    status: 'draft',
    locked: false,
    fields,
    evidence_refs: [],
    test_refs: [],
    human_lock: null,
    feynman_restatement: null,
    audit_log: [
      { at: new Date().toISOString(), event: 'created', by: 'ai' }
    ],
  };
  return card;
}

function transitionCard(card, toState, transitionContext = {}) {
  if (!VALID_STATES.includes(toState)) throw new Error(`Invalid state: ${toState}`);
  if (!TRANSITIONS[card.status].includes(toState)) {
    throw new Error(`Invalid transition: ${card.status} → ${toState}`);
  }
  const newCard = { ...card, fields: { ...card.fields } };
  newCard.status = toState;
  newCard.locked = ['locked', 'tested', 'published'].includes(toState);
  newCard.audit_log = [...(card.audit_log || []), {
    at: new Date().toISOString(),
    event: toState,
    by: transitionContext.by || 'system',
    ...(transitionContext.reason && { reason: transitionContext.reason }),
  }];
  return newCard;
}

function lockCard(card, lockPayload) {
  if (!lockPayload.by) throw new Error('lockPayload.by is required');
  if (!lockPayload.statement) throw new Error('lockPayload.statement is required (expert confirmation in own words)');
  if (!lockPayload.checked?.applies_when) throw new Error('Must confirm applies_when reviewed');
  if (!lockPayload.checked?.does_not_apply_when) throw new Error('Must confirm does_not_apply_when reviewed');
  if (!lockPayload.checked?.failure_risk) throw new Error('Must confirm failure_risk reviewed');

  // Schema gate per KDNA SPEC
  if (card.type === 'axiom') {
    if (!card.fields?.full_statement || card.fields.full_statement.length < 20) {
      throw new Error(`Axiom ${card.id} cannot be locked: missing or too-short full_statement. SPEC requires a complete, testable explanation.`);
    }
    if (!card.fields?.why || card.fields.why.length < 20) {
      throw new Error(`Axiom ${card.id} cannot be locked: missing or too-short why. SPEC requires an explanation of failure mode.`);
    }
  }
  if (card.type === 'misunderstanding') {
    if (!card.fields?.key_distinction || card.fields.key_distinction.length < 20) {
      throw new Error(`Misunderstanding ${card.id} cannot be locked: missing or too-short key_distinction. SPEC requires a clear conceptual boundary.`);
    }
  }

  const lockedCard = { ...card, fields: { ...card.fields } };
  lockedCard.human_lock = {
    by: lockPayload.by,
    at: new Date().toISOString(),
    statement: lockPayload.statement,
    checked: lockPayload.checked,
    creator_id: lockPayload.creator_id || null,
    signature: lockPayload.signature || null,
    judgment_fingerprint: cardJudgmentFingerprint(lockedCard),
  };

  return transitionCard(lockedCard, 'locked', { by: lockPayload.by });
}

function unlockCard(card, reason, by) {
  if (!reason) throw new Error('Unlock requires a reason');
  const unlockedCard = { ...card, fields: { ...card.fields } };
  unlockedCard.human_lock = null;
  return transitionCard(unlockedCard, 'revised', {
    by,
    reason: `unlocked: ${reason}`,
  });
}

function getLockedCards(project) {
  return project.cards.filter(c => ['locked', 'tested', 'published'].includes(c.status));
}

function getPublishableCards(project) {
  return project.cards.filter(c => c.status === 'tested' || c.status === 'locked');
}

module.exports = {
  CARD_TYPES,
  VALID_STATES,
  TRANSITIONS,
  createCard,
  transitionCard,
  lockCard,
  unlockCard,
  getLockedCards,
  getPublishableCards,
  cardJudgmentFingerprint,
  // Feynman restatement (re-exported from feynman.js)
  createFeynmanRestatement: require('./feynman').createFeynmanRestatement,
  evaluateRestatementQuality: require('./feynman').evaluateRestatementQuality,
  attachRestatementToLock: require('./feynman').attachRestatementToLock,
  validateRestatementCard: require('./feynman').validateRestatementCard,
};
