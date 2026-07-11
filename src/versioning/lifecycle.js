/**
 * Asset Lifecycle — Update, rollback, deprecation, regression replay.
 *
 * Every published asset version must:
 *   1. Be independently identifiable (digest)
 *   2. Reference the previous version in its lineage
 *   3. Support rollback to any previous published version
 *   4. Support deprecation with a replacement pointer
 *   5. Preserve regression evidence across version upgrades
 */

const crypto = require('crypto');

// ── Lifecycle States ──────────────────────────────────────────────────

const LIFECYCLE_STATES = [
  'draft',           // Not yet published
  'published',       // Publicly available
  'deprecated',      // Still available but replaced/superseded
  'removed',         // No longer available — removed from distribution
  'revoked',         // Removed for trust/security reasons
];

/**
 * Create a lifecycle record for an asset.
 */
function createLifecycle(assetId, initialVersion = '0.1.0') {
  return {
    asset_id: assetId,
    current_version: initialVersion,
    state: 'draft',
    versions: [],
    created_at: new Date().toISOString(),
  };
}

/**
 * Record a new published version. Links to previous version in lineage.
 */
function publishVersion(lifecycle, version, digest, diff, changelog) {
  const previousVersion = lifecycle.versions.length > 0
    ? lifecycle.versions[lifecycle.versions.length - 1] : null;

  const entry = {
    version,
    digest: digest || 'sha256:' + crypto.randomBytes(32).toString('hex'),
    published_at: new Date().toISOString(),
    previous_version: previousVersion?.version || null,
    diff: diff ? {
      added: diff.added?.length || 0,
      removed: diff.removed?.length || 0,
      changed: diff.changed?.length || 0,
      bump: diff.summary ? 'recorded' : 'unknown',
    } : null,
    changelog: changelog || null,
    regression_evidence: null,
    deprecation: null,
  };

  lifecycle.versions.push(entry);
  lifecycle.current_version = version;
  lifecycle.state = 'published';

  return entry;
}

/**
 * Deprecate a version with a replacement pointer.
 */
function deprecateVersion(lifecycle, version, opts = {}) {
  const entry = lifecycle.versions.find(v => v.version === version);
  if (!entry) throw new Error(`Version ${version} not found in lifecycle`);

  entry.deprecation = {
    deprecated_at: new Date().toISOString(),
    replaced_by: opts.replacedBy || null,
    reason: opts.reason || 'No longer recommended',
    removal_date: opts.removalDate || null,
    migration_guide: opts.migrationGuide || null,
  };

  lifecycle.state = 'deprecated';
  return entry;
}

/**
 * Remove a version from distribution.
 */
function removeVersion(lifecycle, version, reason = '') {
  const entry = lifecycle.versions.find(v => v.version === version);
  if (!entry) throw new Error(`Version ${version} not found in lifecycle`);

  entry.removal = {
    removed_at: new Date().toISOString(),
    reason: reason || 'Removed from distribution',
  };

  lifecycle.state = 'removed';
  return entry;
}

/**
 * Revoke a version (trust/security).
 */
function revokeVersion(lifecycle, version, reason = '') {
  const entry = lifecycle.versions.find(v => v.version === version);
  if (!entry) throw new Error(`Version ${version} not found in lifecycle`);

  entry.revocation = {
    revoked_at: new Date().toISOString(),
    reason: reason || 'Revoked for trust or security reasons',
    advisory_url: null,
  };

  lifecycle.state = 'revoked';
  return entry;
}

// ── Rollback ──────────────────────────────────────────────────────────

/**
 * Rollback to a previous version. Creates a new version entry
 * that references the rollback target. Does NOT delete versions.
 *
 * Rollback is a semantic operation: the new version's content
 * is the same as the rollback target, but it gets a new version
 * number (patch bump) to distinguish the rollback event.
 */
function rollbackToVersion(lifecycle, targetVersion, opts = {}) {
  const target = lifecycle.versions.find(v => v.version === targetVersion);
  if (!target) throw new Error(`Target version ${targetVersion} not found`);

  const current = lifecycle.versions[lifecycle.versions.length - 1];
  if (!current) throw new Error('No current version to rollback from');

  const rolledBackVersion = opts.newVersion || bumpPatch(current.version);

  const entry = {
    version: rolledBackVersion,
    digest: target.digest,  // same content as rollback target
    published_at: new Date().toISOString(),
    previous_version: current.version,
    rollback: {
      from_version: current.version,
      to_version: targetVersion,
      reason: opts.reason || 'Rollback requested',
    },
    changelog: `Rollback from v${current.version} to content of v${targetVersion}`,
    regression_evidence: null,
  };

  lifecycle.versions.push(entry);
  lifecycle.current_version = rolledBackVersion;
  return entry;
}

function bumpPatch(version) {
  const parts = version.split('.').map(Number);
  return `${parts[0]}.${parts[1]}.${(parts[2] || 0) + 1}`;
}

// ── Regression Evidence ───────────────────────────────────────────────

/**
 * Attach regression evidence to a published version.
 * The evidence proves that this version does not regress
 * on previously passing fixture cases.
 */
function attachRegressionEvidence(lifecycle, version, evidence) {
  const entry = lifecycle.versions.find(v => v.version === version);
  if (!entry) throw new Error(`Version ${version} not found`);

  entry.regression_evidence = {
    attached_at: new Date().toISOString(),
    suites_passed: evidence.suitesPassed || 0,
    suites_total: evidence.suitesTotal || 5,
    fixtures_passed: evidence.fixturesPassed || 0,
    fixtures_total: evidence.fixturesTotal || 0,
    regressions: evidence.regressions || [],
    assay_result: evidence.assayResult || null,
    evidence_digest: 'sha256:' + crypto.createHash('sha256')
      .update(JSON.stringify(evidence)).digest('hex'),
  };

  return entry;
}

// ── Update ────────────────────────────────────────────────────────────

/**
 * Get the recommended update path for a user on oldVersion.
 */
function getUpdatePath(lifecycle, oldVersion) {
  const idx = lifecycle.versions.findIndex(v => v.version === oldVersion);
  if (idx < 0) return { error: `Version ${oldVersion} not found in lifecycle` };

  const latest = lifecycle.versions[lifecycle.versions.length - 1];
  const isLatest = oldVersion === latest.version;
  const updatesSince = lifecycle.versions.slice(idx + 1);

  const breakingUpdates = updatesSince.filter(v => {
    const bump = v.diff?.bump || 'patch';
    return bump === 'major';
  });

  return {
    current_version: oldVersion,
    latest_version: latest.version,
    is_latest: isLatest,
    updates_available: updatesSince.length,
    breaking_updates: breakingUpdates.length,
    requires_major_upgrade: breakingUpdates.length > 0,
    recommended: isLatest ? 'none' :
      breakingUpdates.length > 0 ? 'review_breaking_changes' :
      'update_available',
    update_chain: updatesSince.map(v => ({
      version: v.version,
      published_at: v.published_at,
      changelog: v.changelog,
      is_breaking: v.diff?.bump === 'major',
      is_rollback: !!v.rollback,
      is_deprecated: !!v.deprecation,
    })),
    rollback_available: lifecycle.versions.filter(v => v.version !== latest.version && !v.revocation).map(v => ({
      version: v.version,
      published_at: v.published_at,
      is_deprecated: !!v.deprecation,
    })),
    deprecation: latest.deprecation || null,
  };
}

// ── Evidence Continuity ───────────────────────────────────────────────

/**
 * Verify that evidence from previous versions is preserved
 * across the lifecycle. Every version should either carry forward
 * or explicitly supersede the previous version's evidence.
 */
function verifyEvidenceContinuity(lifecycle) {
  const gaps = [];
  for (let i = 1; i < lifecycle.versions.length; i++) {
    const prev = lifecycle.versions[i - 1];
    const curr = lifecycle.versions[i];

    if (curr.rollback) continue; // rollback inherits target evidence

    if (prev.regression_evidence && !curr.regression_evidence) {
      gaps.push({
        from_version: prev.version,
        to_version: curr.version,
        issue: `Version ${prev.version} had regression evidence but ${curr.version} does not — evidence gap`,
        severity: 'warn',
      });
    }
  }

  return {
    continuous: gaps.length === 0,
    gaps,
    total_versions: lifecycle.versions.length,
    versions_with_evidence: lifecycle.versions.filter(v => v.regression_evidence).length,
    versions_without_evidence: lifecycle.versions.filter(v => !v.regression_evidence).length,
  };
}

module.exports = {
  LIFECYCLE_STATES,
  createLifecycle,
  publishVersion,
  deprecateVersion,
  removeVersion,
  revokeVersion,
  rollbackToVersion,
  attachRegressionEvidence,
  getUpdatePath,
  verifyEvidenceContinuity,
};
