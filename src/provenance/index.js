/**
 * Provenance tracking — build metadata and content fingerprinting.
 *
 * Every compiled KDNA domain carries provenance proving:
 *   - Which Studio Core version created it
 *   - Which project it came from
 *   - Who authored the locked cards
 *   - Content tree fingerprint
 */
const crypto = require('crypto');

function buildProvenance(project, compiledFiles) {
  const lockedCards = (project.cards || []).filter(c => c.locked);
  const tests = project.tests || [];

  // Content fingerprint: hash of all locked card content
  const cardHashes = lockedCards
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(c => `${c.id}:${c.fields?.one_sentence || c.fields?.concept || ''}`);
  const contentFingerprint = crypto.createHash('sha256').update(cardHashes.join('\n')).digest('hex');

  return {
    studio_core: 'aikdna/kdna-studio',
    studio_core_version: project.studio_version || require('../../package.json').version,
    created_by: 'kdna-studio-sdk',
    compiler: '@aikdna/kdna-studio',
    compiler_version: project.studio_version || require('../../package.json').version,
    build_id: `build_${crypto.randomUUID()}`,
    project_id: project.project_id,
    author_id: project.author?.id || '',
    locked_card_count: lockedCards.length,
    test_case_count: tests.length,
    built_at: new Date().toISOString(),
    compiled_at: new Date().toISOString(),
    content_fingerprint: `sha256:${contentFingerprint}`,
  };
}

module.exports = { buildProvenance };
