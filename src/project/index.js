/**
 * Studio Project lifecycle.
 *
 * Responsibilities:
 *   - Create, load, save, validate Studio Project manifests
 *   - Manage project-level state transitions
 *   - Schema validation against studio.project.schema.json
 *   - Human Lock gate enforcement on export
 */

const crypto = require('crypto');
const projectSchema = require('../../schemas/studio.project.schema.json');
const { CARD_TYPES } = require('../cards');
const { JUDGMENT_CARD_TYPES, cardJudgmentFingerprint } = require('../judgment-fields');
const { validateJudgmentCore } = require('../judgment-core');

function createProject(name, type = 'domain', options = {}) {
  const project = {
    studio_version: '0.1.0',
    project_id: `studio_${require('crypto').randomUUID()}`,
    name,
    type,
    created: new Date().toISOString().slice(0, 10),
    updated: new Date().toISOString().slice(0, 10),
    author: options.author || { name: '', id: '' },
    status: 'drafting',
    source_mode: options.sourceMode || 'blank',
    creator_identity: options.creatorIdentity || null,
    lineage: options.lineage || null,
    imported_source_folder: options.sourcePath || null,
    ...(options.judgmentCore
      ? { judgment_core: JSON.parse(JSON.stringify(options.judgmentCore)) }
      : {}),
    cards: [],
    evidence: [],
    tests: [],
    stages: {
      evidence_room: { status: 'pending', evidence_count: 0 },
      interview_room: { status: 'pending', questions_asked: 0 },
      judgment_cards: { status: 'pending', locked: 0, total: 0 },
      test_lab: { status: 'pending', evals_passed: 0, evals_total: 0 },
      export: { status: 'pending' },
    },
  };
  return project;
}

function loadProject(json) {
  let project;
  try {
    project = typeof json === 'string' ? JSON.parse(json) : json;
  } catch (e) {
    throw new Error('loadProject: invalid JSON input — ' + e.message);
  }
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    throw new Error('loadProject: input is not a valid project object');
  }
  const result = validateProject(project);
  if (!result.valid) {
    throw new Error('loadProject: project validation failed:\n  - ' + result.issues.join('\n  - '));
  }
  return project;
}

function saveProject(project) {
  project.updated = new Date().toISOString().slice(0, 10);
  return JSON.stringify(project, null, 2);
}

function validateProject(project) {
  const issues = [];

  function check(cond, msg) { if (!cond) issues.push(msg); }

  function checkType(val, expected, path) {
    if (expected === 'string' && typeof val !== 'string') issues.push(path + ': expected string, got ' + typeof val);
    else if (expected === 'number' && typeof val !== 'number') issues.push(path + ': expected number, got ' + typeof val);
    else if (expected === 'integer' && (!Number.isInteger(val) || typeof val !== 'number')) issues.push(path + ': expected integer, got ' + typeof val);
    else if (expected === 'boolean' && typeof val !== 'boolean') issues.push(path + ': expected boolean, got ' + typeof val);
    else if (expected === 'object' && (typeof val !== 'object' || val === null || Array.isArray(val))) issues.push(path + ': expected object, got ' + (Array.isArray(val) ? 'array' : typeof val));
    else if (expected === 'array' && !Array.isArray(val)) issues.push(path + ': expected array, got ' + typeof val);
  }

  // Required top-level fields
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    return { valid: false, issues: ['project must be a non-null object'] };
  }

  const required = projectSchema.required || [];
  for (const field of required) {
    if (!(field in project)) issues.push('Missing required field: ' + field);
  }

  // studio_version
  if (project.studio_version !== undefined) {
    checkType(project.studio_version, 'string', 'studio_version');
    if (typeof project.studio_version === 'string') {
      const verPattern = projectSchema.properties.studio_version.pattern;
      if (verPattern && !new RegExp(verPattern).test(project.studio_version)) {
        issues.push('studio_version: invalid version format, expected semver (e.g. 1.2.3)');
      }
    }
  }

  // name
  if (project.name !== undefined) {
    checkType(project.name, 'string', 'name');
    if (typeof project.name === 'string' && project.name.length < 1) {
      issues.push('name: must not be empty');
    }
  }

  // type
  if (project.type !== undefined) {
    checkType(project.type, 'string', 'type');
    if (typeof project.type === 'string' && !['domain', 'cluster'].includes(project.type)) {
      issues.push('type: must be "domain" or "cluster", got "' + project.type + '"');
    }
  }

  // status
  if (project.status !== undefined) {
    checkType(project.status, 'string', 'status');
    if (typeof project.status === 'string') {
      const validStatuses = ['drafting', 'cards_in_progress', 'ready_for_test', 'ready_for_release', 'released'];
      if (!validStatuses.includes(project.status)) {
        issues.push('status: must be one of ' + validStatuses.join(', ') + ', got "' + project.status + '"');
      }
    }
  }

  // project_id
  if (project.project_id !== undefined) {
    checkType(project.project_id, 'string', 'project_id');
  }

  // created / updated
  if (project.created !== undefined) checkType(project.created, 'string', 'created');
  if (project.updated !== undefined) checkType(project.updated, 'string', 'updated');

  // author
  if (project.author !== undefined) {
    checkType(project.author, 'object', 'author');
  }

  for (const issue of validateJudgmentCore(project.judgment_core)) {
    issues.push(issue);
  }

  // cards
  if (project.cards !== undefined) {
    checkType(project.cards, 'array', 'cards');
    if (Array.isArray(project.cards)) {
      for (let i = 0; i < project.cards.length; i++) {
        const card = project.cards[i];
        if (!card || typeof card !== 'object') {
          issues.push('cards[' + i + ']: must be an object');
          continue;
        }
        for (const req of ['id', 'type', 'status']) {
          if (!(req in card)) issues.push('cards[' + i + ']: missing required field "' + req + '"');
        }
        if (card.type !== undefined) {
          if (!CARD_TYPES.includes(card.type)) issues.push('cards[' + i + ']: invalid type "' + card.type + '"');
        }
        if (card.status !== undefined) {
          const validStates = ['draft', 'revised', 'locked', 'tested', 'published', 'deprecated'];
          if (!validStates.includes(card.status)) issues.push('cards[' + i + ']: invalid status "' + card.status + '"');
        }
      }
    }
  }

  // evidence
  if (project.evidence !== undefined) {
    checkType(project.evidence, 'array', 'evidence');
    if (Array.isArray(project.evidence)) {
      for (let i = 0; i < project.evidence.length; i++) {
        const ev = project.evidence[i];
        if (!ev || typeof ev !== 'object') {
          issues.push('evidence[' + i + ']: must be an object');
          continue;
        }
        for (const req of ['id', 'type', 'title']) {
          if (!(req in ev)) issues.push('evidence[' + i + ']: missing required field "' + req + '"');
        }
      }
    }
  }

  // tests
  if (project.tests !== undefined) {
    checkType(project.tests, 'array', 'tests');
    if (Array.isArray(project.tests)) {
      for (let i = 0; i < project.tests.length; i++) {
        const t = project.tests[i];
        if (!t || typeof t !== 'object') {
          issues.push('tests[' + i + ']: must be an object');
          continue;
        }
        for (const req of ['id', 'input']) {
          if (!(req in t)) issues.push('tests[' + i + ']: missing required field "' + req + '"');
        }
      }
    }
  }

  // stages
  if (project.stages !== undefined) {
    checkType(project.stages, 'object', 'stages');
  }

  return { valid: issues.length === 0, issues };
}

function upgradeProject(project, fromVersion, toVersion) {
  const migrations = {
    '0.1.0_to_0.2.0': function(p) {
      if (!p.release) p.release = { version: toVersion };
      return p;
    }
  };
  const key = fromVersion + '_to_' + toVersion;
  if (migrations[key]) {
    project = migrations[key](project);
  } else {
    throw new Error('upgradeProject: no migration path from ' + fromVersion + ' to ' + toVersion);
  }
  project.studio_version = toVersion;
  return project;
}

// ─── Human Lock Gate ────────────────────────────────────────────────────

/**
 * Detect judgment-class cards that require Human Lock but don't have it,
 * or have had their judgment fields changed since the last Human Lock.
 *
 * @returns {{ blocked: boolean, issues: Array<{cardId: string, type: string, reason: string}> }}
 */
function checkHumanLockGate(project) {
  const issues = [];
  const cards = project.cards || [];

  for (const card of cards) {
    if (!JUDGMENT_CARD_TYPES.has(card.type)) continue;

    const cardId = card.id || 'unknown';

    // Rule 1: Judgment-class cards must be locked before export
    if (card.status !== 'locked' && card.status !== 'tested' && card.status !== 'published') {
      issues.push({
        cardId,
        type: card.type,
        reason: `judgment-class card "${cardId}" (${card.type}) is not approved for Studio export. Review/provenance approval is required by this Studio workflow.`
      });
      continue;
    }

    // Rule 2: Locked cards must have a Human Lock record
    if (!card.human_lock || !card.human_lock.by || !card.human_lock.statement) {
      issues.push({
        cardId,
        type: card.type,
        reason: `locked card "${cardId}" (${card.type}) has no valid Human Lock record (missing by/statement).`
      });
      continue;
    }

    // Rule 3: Lock must confirm judgment-class fields were reviewed
    const checked = card.human_lock.checked || {};
    if (!checked.applies_when) {
      issues.push({
        cardId,
        type: card.type,
        reason: `card "${cardId}" Human Lock does not confirm applies_when was reviewed.`
      });
    }
    if (!checked.does_not_apply_when) {
      issues.push({
        cardId,
        type: card.type,
        reason: `card "${cardId}" Human Lock does not confirm does_not_apply_when was reviewed.`
      });
    }
    if (!checked.failure_risk) {
      issues.push({
        cardId,
        type: card.type,
        reason: `card "${cardId}" Human Lock does not confirm failure_risk was reviewed.`
      });
    }

    // Rule 4: Judgment fields must not have changed since lock
    if (card.human_lock.judgment_fingerprint) {
      const currentFingerprint = cardJudgmentFingerprint(card);
      if (currentFingerprint !== card.human_lock.judgment_fingerprint) {
        issues.push({
          cardId,
          type: card.type,
          reason: `card "${cardId}" judgment fields changed after Human Lock — re-lock required.`
        });
      }
    }
  }

  // Rule 4: At least one locked judgment-class card must exist for a domain project
  const lockedJudgmentCards = cards.filter(c =>
    JUDGMENT_CARD_TYPES.has(c.type) &&
    ['locked', 'tested', 'published'].includes(c.status)
  );
  if (lockedJudgmentCards.length === 0 && cards.some(c => JUDGMENT_CARD_TYPES.has(c.type))) {
    issues.push({
      cardId: '(project)',
      type: 'project',
      reason: 'No judgment-class cards are approved. At least one axiom, boundary, or risk card must be reviewed before Studio export.'
    });
  }

  return {
    blocked: issues.length > 0,
    issues,
    lockedJudgmentCards: lockedJudgmentCards.length,
  };
}

/**
 * Export a Studio project record. Human Lock is optional provenance; callers
 * may request a reviewed-only export with `requireHumanLock: true`.
 *
 * @throws {Error} if Human Lock gate blocks export
 * @returns {string} JSON string of the project
 */
function exportProject(project, options = {}) {
  const gate = checkHumanLockGate(project);

  if (gate.blocked && options.requireHumanLock && !options.force) {
    const lines = ['Human Lock Gate blocked export:', ''];
    for (const issue of gate.issues) {
      lines.push(`  ✗ ${issue.cardId}: ${issue.reason}`);
    }
    lines.push('');
    lines.push(`  Locked judgment cards: ${gate.lockedJudgmentCards}`);
    lines.push('  To override (emergency only): pass { force: true }');
    throw new Error(lines.join('\n'));
  }

  if (gate.blocked && options.requireHumanLock && options.force) {
    // Emergency override: recorded but not blocked
    project._human_lock_override = {
      overridden_at: new Date().toISOString(),
      reason: options.forceReason || 'Emergency override (no reason provided)',
      blocked_issues: gate.issues.map(i => ({ cardId: i.cardId, reason: i.reason })),
    };
  }

  project.updated = new Date().toISOString().slice(0, 10);

  // Update release metadata
  if (!project.release) project.release = {};
  project.release.exported_at = new Date().toISOString();
  project.release.locked_judgment_cards = gate.lockedJudgmentCards;
  project.release.human_lock_gate_passed = !gate.blocked || Boolean(options.requireHumanLock && options.force);

  return JSON.stringify(project, null, 2);
}

module.exports = {
  createProject, loadProject, saveProject, validateProject, upgradeProject,
  exportProject, checkHumanLockGate, JUDGMENT_CARD_TYPES
};
