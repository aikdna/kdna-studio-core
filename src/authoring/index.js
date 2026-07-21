const { createCard, lockCard, transitionCard } = require('../cards');
const { exportRuntimeAsset } = require('../export-runtime');
const {
  createProject,
  loadProject,
  saveProject,
  validateProject,
} = require('../project');
const { cardJudgmentFingerprint } = require('../judgment-fields');

const SOURCE_TYPES = Object.freeze(['human', 'organization', 'ai', 'agent', 'mixed']);

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function stringList(value, label) {
  const list = Array.isArray(value) ? value : [value];
  const normalized = list
    .filter((item) => item !== undefined && item !== null)
    .map((item) => String(item).trim())
    .filter(Boolean);
  if (normalized.length === 0) throw new Error(`${label} requires at least one non-empty value`);
  return normalized;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function assertProject(project) {
  const result = validateProject(project);
  if (!result.valid) {
    throw new Error(`invalid Studio project:\n  - ${result.issues.join('\n  - ')}`);
  }
}

function ensureAuthoringStages(project) {
  project.stages = project.stages || {};
  project.stages.source = project.stages.source || { status: 'pending', judgment_count: 0 };
  project.stages.review = project.stages.review || { status: 'pending', reviewed_count: 0 };
  project.stages.confirm = project.stages.confirm || { status: 'pending', confirmed_count: 0 };
  project.stages.export = project.stages.export || { status: 'pending' };
}

function createAuthoringProject(name, options = {}) {
  const project = createProject(nonEmpty(name, 'name'), 'domain', {
    sourceMode: 'declared',
    creatorIdentity: options.creatorIdentity || null,
    judgmentCore: options.judgmentCore,
  });
  ensureAuthoringStages(project);
  project.release = {
    ...(project.release || {}),
    version: options.version || '0.1.0',
    judgment_version: options.judgmentVersion || options.version || '0.1.0',
    access: options.access || 'public',
    description: options.description || name,
  };
  project.lineage = options.lineage || { type: 'original' };
  return project;
}

function addSourceJudgment(project, input = {}) {
  assertProject(project);
  ensureAuthoringStages(project);
  const sourceType = nonEmpty(input.sourceType, 'sourceType');
  if (!SOURCE_TYPES.includes(sourceType)) {
    throw new Error(`sourceType must be one of: ${SOURCE_TYPES.join(', ')}`);
  }

  const statement = nonEmpty(input.statement, 'statement');
  if (statement.length < 20) throw new Error('statement must contain at least 20 characters');
  const rationale = nonEmpty(input.rationale, 'rationale');
  if (rationale.length < 20) throw new Error('rationale must contain at least 20 characters');

  const source = {
    type: sourceType,
    label: nonEmpty(input.sourceLabel, 'sourceLabel'),
    ...(input.sourceReference ? { reference: nonEmpty(input.sourceReference, 'sourceReference') } : {}),
  };
  const represents = input.represents
    ? {
        type: nonEmpty(input.represents.type, 'represents.type'),
        id: nonEmpty(input.represents.id, 'represents.id'),
        ...(input.represents.name ? { name: nonEmpty(input.represents.name, 'represents.name') } : {}),
        status: 'unconfirmed',
      }
    : null;

  const card = createCard('axiom', {
    one_sentence: statement,
    full_statement: statement,
    why: rationale,
    applies_when: stringList(input.appliesWhen, 'appliesWhen'),
    does_not_apply_when: stringList(input.doesNotApplyWhen, 'doesNotApplyWhen'),
    failure_risk: nonEmpty(input.failureRisk, 'failureRisk'),
    source_provenance: source,
    ...(represents ? { representation: represents } : {}),
  }, input.id || null);
  card.audit_log = [{
    at: new Date().toISOString(),
    event: 'source_declared',
    by: `source:${sourceType}`,
  }];
  project.cards.push(card);
  project.stages.source.status = 'complete';
  project.stages.source.judgment_count = project.cards.filter((item) => item.status !== 'deprecated').length;
  project.status = 'cards_in_progress';
  return card;
}

function findCard(project, cardId) {
  assertProject(project);
  const card = project.cards.find((item) => item.id === cardId);
  if (!card) throw new Error(`judgment not found: ${cardId}`);
  return card;
}

function replaceCard(project, card) {
  const index = project.cards.findIndex((item) => item.id === card.id);
  if (index < 0) throw new Error(`judgment not found: ${card.id}`);
  project.cards[index] = card;
  return card;
}

function reviewJudgment(project, cardId, review = {}) {
  ensureAuthoringStages(project);
  const card = findCard(project, cardId);
  if (card.status !== 'draft') throw new Error(`judgment ${cardId} is not awaiting review`);
  const reviewedBy = nonEmpty(review.by, 'review.by');
  const reviewStatement = nonEmpty(review.statement, 'review.statement');
  const reviewed = transitionCard(card, 'revised', { by: reviewedBy, reason: reviewStatement });
  reviewed.review = {
    by: reviewedBy,
    at: new Date().toISOString(),
    statement: reviewStatement,
    source_checked: true,
    scope_checked: true,
    boundary_checked: true,
  };
  replaceCard(project, reviewed);
  project.stages.review.status = 'complete';
  project.stages.review.reviewed_count = project.cards.filter((item) => item.review).length;
  return reviewed;
}

function confirmJudgment(project, cardId, confirmation = {}) {
  ensureAuthoringStages(project);
  const card = findCard(project, cardId);
  if (card.status !== 'revised' || !card.review) {
    throw new Error(`judgment ${cardId} must be reviewed before confirmation`);
  }
  const confirmedBy = nonEmpty(confirmation.by, 'confirmation.by');
  const confirmationStatement = nonEmpty(confirmation.statement, 'confirmation.statement');
  const representation = card.fields?.representation || null;
  let subjectId = null;
  if (representation) {
    subjectId = nonEmpty(confirmation.subjectId, 'confirmation.subjectId');
    if (subjectId !== representation.id) {
      throw new Error(
        `confirmation subject ${subjectId} does not match represented subject ${representation.id}`,
      );
    }
  }

  let confirmed = lockCard(card, {
    by: confirmedBy,
    statement: confirmationStatement,
    checked: {
      applies_when: true,
      does_not_apply_when: true,
      failure_risk: true,
    },
  });
  confirmed.confirmation = {
    by: confirmedBy,
    at: new Date().toISOString(),
    statement: confirmationStatement,
    ...(subjectId ? { subject_id: subjectId } : {}),
  };
  if (representation) {
    confirmed.fields = {
      ...confirmed.fields,
      representation: { ...representation, status: 'confirmed' },
    };
    confirmed.human_lock = {
      ...confirmed.human_lock,
      judgment_fingerprint: cardJudgmentFingerprint(confirmed),
    };
  }
  replaceCard(project, confirmed);
  project.stages.confirm.status = 'complete';
  project.stages.confirm.confirmed_count = project.cards.filter((item) => item.confirmation).length;
  project.status = 'ready_for_release';
  return confirmed;
}

function listJudgments(project) {
  assertProject(project);
  return project.cards.map((card) => ({
    id: card.id,
    status: card.status,
    statement: card.fields?.one_sentence || card.fields?.full_statement || null,
    source: clone(card.fields?.source_provenance || null),
    representation: clone(card.fields?.representation || null),
    reviewed: Boolean(card.review),
    confirmed: Boolean(card.confirmation),
  }));
}

function assertConfirmedForExport(project) {
  assertProject(project);
  const active = project.cards.filter((card) => card.status !== 'deprecated');
  if (active.length === 0) throw new Error('cannot export a Studio project with no judgments');
  const problems = [];
  for (const card of active) {
    if (!card.fields?.source_provenance) problems.push(`${card.id}: source provenance is missing`);
    if (!card.review) problems.push(`${card.id}: review is missing`);
    if (!card.confirmation || !['locked', 'tested', 'published'].includes(card.status)) {
      problems.push(`${card.id}: confirmation is missing`);
    }
    const representation = card.fields?.representation;
    if (representation && representation.status !== 'confirmed') {
      problems.push(`${card.id}: represented subject ${representation.id} is not confirmed`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Studio export requires reviewed and confirmed judgments:\n  - ${problems.join('\n  - ')}`);
  }
}

function exportConfirmedRuntimeAsset(project, options = {}) {
  assertConfirmedForExport(project);
  return exportRuntimeAsset(project, options);
}

module.exports = {
  SOURCE_TYPES,
  createProject: createAuthoringProject,
  parseProject: loadProject,
  serializeProject: saveProject,
  validateProject,
  addSourceJudgment,
  reviewJudgment,
  confirmJudgment,
  listJudgments,
  assertConfirmedForExport,
  exportRuntimeAsset: exportConfirmedRuntimeAsset,
};
