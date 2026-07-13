/**
 * Versioning — Judgment-aware semver with refined bump rules (v0.3.3).
 *
 * PATCH: typo, description, Feynman restatement, evidence_refs, examples
 * MINOR: new axiom/misunderstanding/self_check, narrowed applies_when, new does_not_apply_when, new evals
 * MAJOR: removed axiom, changed core meaning, expanded applies_when, removed does_not_apply_when, scope change, access change
 */

function diffProjects(oldProject, newProject) {
  const oldCards = oldProject.cards || [];
  const newCards = newProject.cards || [];
  const oldById = new Map(oldCards.map(c => [c.id, c]));
  const newById = new Map(newCards.map(c => [c.id, c]));

  const added = []; const removed = []; const changed = [];
  for (const [id, nc] of newById) {
    if (!oldById.has(id)) { added.push(cardSummary(nc)); }
    else {
      const oc = oldById.get(id);
      const fieldChanges = diffFields(oc.fields || {}, nc.fields || {});
      if (Object.keys(fieldChanges).length > 0) {
        changed.push(cardSummary(nc, fieldChanges));
      } else if (oc.status !== nc.status) {
        changed.push({ ...cardSummary(nc), status_change: { from: oc.status, to: nc.status } });
      }
    }
  }
  for (const [id, oc] of oldById) {
    if (!newById.has(id)) removed.push(cardSummary(oc));
  }

  return { added, removed, changed, unchanged: oldCards.length - removed.length - changed.length,
    summary: { added_count: added.length, removed_count: removed.length, changed_count: changed.length } };
}

function cardSummary(card, changes) {
  return { id: card.id, type: card.type, one_sentence: card.fields?.one_sentence || card.fields?.question || '',
    changes: changes || null };
}

function stableStringify(obj) {
  if (typeof obj !== 'object' || obj === null) return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

function diffFields(oldFields, newFields) {
  const changes = {};
  for (const key of new Set([...Object.keys(oldFields), ...Object.keys(newFields)])) {
    const ov = stableStringify(oldFields[key] || null), nv = stableStringify(newFields[key] || null);
    if (ov !== nv) changes[key] = { before: oldFields[key] || null, after: newFields[key] || null };
  }
  return changes;
}

function recommendVersionBump(diff) {
  const { added, removed, changed } = diff;
  const removedAxioms = removed.filter(c => c.type === 'axiom');
  const removedMisunderstandings = removed.filter(c => c.type === 'misunderstanding');

  // MAJOR checks
  if (removedAxioms.length > 0 || removedMisunderstandings.length > 0) return 'major';
  for (const c of changed) {
    if (!c.changes) continue;
    // Core meaning change on axiom → major
    if (c.type === 'axiom' && ('one_sentence' in c.changes || 'full_statement' in c.changes)) return 'major';
    // Expanded scope → major
    if ('applies_when' in c.changes) {
      const bef = c.changes.applies_when.before || [], aft = c.changes.applies_when.after || [];
      if (aft.length > bef.length) return 'major';
    }
    // Removed boundary → major
    if ('does_not_apply_when' in c.changes) {
      const bef = c.changes.does_not_apply_when.before || [], aft = c.changes.does_not_apply_when.after || [];
      if (aft.length < bef.length) return 'major';
    }
  }

  // MINOR checks
  const addedAxioms = added.filter(c => c.type === 'axiom');
  const addedMisunderstandings = added.filter(c => c.type === 'misunderstanding');
  const addedSelfChecks = added.filter(c => c.type === 'self_check');
  if (addedAxioms.length > 0 || addedMisunderstandings.length > 0 || addedSelfChecks.length > 0) return 'minor';
  for (const c of changed) {
    if (!c.changes) continue;
    // Narrowed scope → minor
    if ('does_not_apply_when' in c.changes) {
      const bef = c.changes.does_not_apply_when.before || [], aft = c.changes.does_not_apply_when.after || [];
      if (aft.length > bef.length) return 'minor';
    }
    // Changed why/key_distinction → minor
    if (c.type === 'axiom' && 'why' in c.changes) return 'minor';
    if (c.type === 'misunderstanding' && 'key_distinction' in c.changes) return 'minor';
  }

  // PATCH: wording-only changes
  if (added.length > 0 || changed.length > 0) return 'patch';
  return 'none';
}

function generateChangelog(diff, oldVersion, newVersion, options = {}) {
  const lines = [];
  const bump = recommendVersionBump(diff);
  lines.push(`# ${options.domain || 'domain'} v${newVersion}`);
  lines.push('');
  lines.push(`**Previous:** v${oldVersion}  **Bump:** ${bump.toUpperCase()}`);
  lines.push('');

  for (const [label, items] of [['Added', diff.added], ['Removed', diff.removed], ['Changed', diff.changed]]) {
    if (items.length === 0) continue;
    lines.push(`## ${label}`); lines.push('');
    for (const c of items) {
      lines.push(`- **${c.type}** \`${c.id}\`: ${c.one_sentence}`);
      if (c.status_change) lines.push(`  - Status: ${c.status_change.from} → ${c.status_change.to}`);
      if (c.changes) for (const [f, v] of Object.entries(c.changes)) {
        lines.push(`  - ${f}: "${String(v.before || '').slice(0, 60)}" → "${String(v.after || '').slice(0, 60)}"`);
      }
    }
    lines.push('');
  }

  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    lines.push('No judgment changes detected.\n');
  }

  return lines.join('\n');
}

function bumpVersion(currentVersion, bumpType) {
  const [maj, min, pat] = currentVersion.split('.').map(Number);
  if (bumpType === 'major') return `${maj + 1}.0.0`;
  if (bumpType === 'minor') return `${maj}.${min + 1}.0`;
  if (bumpType === 'patch') return `${maj}.${min}.${pat + 1}`;
  return currentVersion;
}

function markBreakingChange(diff) {
  const recommended = recommendVersionBump(diff);
  const removedAxioms = diff.removed.filter(c => c.type === 'axiom');
  const scopeWidening = diff.changed.filter(c => c.changes && 'applies_when' in c.changes &&
    (c.changes.applies_when.after || []).length > (c.changes.applies_when.before || []).length);
  const coreMeaningChanges = diff.changed.filter(c => c.changes &&
    ('one_sentence' in c.changes || 'full_statement' in c.changes));

  return {
    breaking: recommended === 'major',
    reason: removedAxioms.length > 0 ? `${removedAxioms.length} axiom(s) removed — breaking change` :
      coreMeaningChanges.length > 0 ? `${coreMeaningChanges.length} core meaning change(s) — breaking change` :
      scopeWidening.length > 0 ? `${scopeWidening.length} scope widening(s) — may affect existing behavior` : null,
    recommended_bump: recommended,
  };
}

const lifecycle = require('./lifecycle');

module.exports = { diffProjects, recommendVersionBump, generateChangelog, bumpVersion, markBreakingChange, lifecycle };
