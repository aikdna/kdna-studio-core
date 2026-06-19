const crypto = require('crypto');
const { compileDomain } = require('../compile');

const MIMETYPE_V1 = 'application/vnd.kdna.asset';

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function domainIdFromName(name = 'domain') {
  const base = String(name).includes('/') ? String(name).split('/').pop() : String(name);
  const normalized = base
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(normalized) ? normalized : `domain_${normalized || 'untitled'}`;
}

function canonicalAccess(value) {
  if (!value || value === 'open') return 'public';
  if (value === 'protected') return 'licensed';
  if (value === 'runtime') return 'remote';
  return value;
}

function semverValue(value, fallback = '0.1.0') {
  const raw = String(value || '').trim();
  if (/^[0-9]+\.[0-9]+\.[0-9]+([+-].+)?$/.test(raw)) return raw;
  const twoPart = raw.match(/^([0-9]+)\.([0-9]+)$/);
  if (twoPart) return `${twoPart[1]}.${twoPart[2]}.0`;
  return fallback;
}

function canonicalLineage(lineage) {
  if (!lineage || typeof lineage !== 'object') return { type: 'original' };
  const allowed = new Set([
    'original',
    'fork',
    'adaptation',
    'translation',
    'private_variant',
    'organization_variant',
    'course_variant',
  ]);
  if (allowed.has(lineage.type)) return lineage;
  return {
    ...lineage,
    type: 'adaptation',
    source_lineage_type: lineage.type || 'unknown',
  };
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : Buffer.from(value)).digest('hex');
}

function buildChecksums(files) {
  const entries = {
    'kdna.json': { algorithm: 'sha256', value: sha256Hex(files['kdna.json']) },
    'payload.kdnab': { algorithm: 'sha256', value: sha256Hex(files['payload.kdnab']) },
  };
  const combined = Object.keys(entries)
    .sort()
    .map((name) => `${name}:${entries[name].value}`)
    .join('\n');
  return {
    algorithm: 'sha256',
    manifest_digest: `sha256:${entries['kdna.json'].value}`,
    payload_digest: `sha256:${entries['payload.kdnab'].value}`,
    asset_digest: `sha256:${sha256Hex(combined)}`,
    entries,
  };
}

function parseJsonFile(files, name, fallback = null) {
  if (!files[name]) return fallback;
  return JSON.parse(files[name]);
}

function buildPayload(compiled) {
  const core = parseJsonFile(compiled.files, 'KDNA_Core.json', {});
  const patterns = parseJsonFile(compiled.files, 'KDNA_Patterns.json', {});
  const scenarios = parseJsonFile(compiled.files, 'KDNA_Scenarios.json', { scenes: [] });
  const cases = parseJsonFile(compiled.files, 'KDNA_Cases.json', { cases: [] });
  const reasoning = parseJsonFile(compiled.files, 'KDNA_Reasoning.json', { reasoning_chains: [] });
  const evolution = parseJsonFile(compiled.files, 'KDNA_Evolution.json', { changelog: [], version_notes: [] });

  const firstAxiom = Array.isArray(core.axioms) ? core.axioms[0] : null;
  return {
    profile: 'judgment-profile-v1',
    core: {
      highest_question:
        core.meta?.load_condition ||
        firstAxiom?.one_sentence ||
        `What judgment should be loaded for ${core.meta?.domain || 'this domain'}?`,
      axioms: Array.isArray(core.axioms) ? core.axioms : [],
      boundaries: Array.isArray(core.boundaries) ? core.boundaries : [],
      risk_model: {
        risks: Array.isArray(core.risks) ? core.risks : [],
      },
    },
    patterns: Array.isArray(patterns.misunderstandings) ? patterns.misunderstandings : [],
    scenarios: Array.isArray(scenarios.scenes) ? scenarios.scenes : [],
    cases: Array.isArray(cases.cases) ? cases.cases : [],
    reasoning: {
      self_checks: Array.isArray(patterns.self_check) ? patterns.self_check : [],
      failure_modes: Array.isArray(reasoning.reasoning_chains) ? reasoning.reasoning_chains : [],
    },
    evolution: {
      stages: Array.isArray(evolution.stages) ? evolution.stages : [],
      evolution_layers: Array.isArray(evolution.evolution_layers) ? evolution.evolution_layers : [],
      measurement: Array.isArray(evolution.measurement) ? evolution.measurement : [],
      changelog: Array.isArray(evolution.changelog) ? evolution.changelog : [],
      version_notes: Array.isArray(evolution.version_notes) ? evolution.version_notes : [],
    },
  };
}

function buildManifest(project, compiled, payloadBytes, options = {}) {
  const sourceManifest = parseJsonFile(compiled.files, 'kdna.json', {});
  const access = canonicalAccess(options.access || project.release?.access || sourceManifest.access);
  const domainId = sourceManifest.domain_id || domainIdFromName(project.name);
  const now = options.timestamp || sourceManifest.updated_at || sourceManifest.updated || new Date().toISOString();
  const creator = project.author || sourceManifest.creator || sourceManifest.author || { name: 'Unknown' };

  const manifest = {
    kdna_version: '1.0',
    asset_id: options.asset_id || `kdna:studio:${domainId}`,
    asset_uid: options.asset_uid || `urn:uuid:${sourceManifest.asset_uid || compiled.identity?.asset_uid}`,
    asset_type: 'domain',
    title: options.title || project.title || project.name,
    version: semverValue(sourceManifest.version || project.release?.version, '0.1.0'),
    judgment_version: semverValue(sourceManifest.judgment_version || project.release?.judgment_version || project.release?.version, '0.1.0'),
    created_at: options.created_at || sourceManifest.created_at || new Date(project.created || now).toISOString(),
    updated_at: options.updated_at || now,
    creator: {
      name: creator.name || creator.display_name || 'Unknown',
      id: creator.id || creator.creator_id || undefined,
    },
    compatibility: {
      min_loader_version: '1.0.0',
      profile: 'judgment-profile-v1',
    },
    payload: {
      path: 'payload.kdnab',
      encoding: 'json',
      encrypted: false,
      digest: `sha256:${sha256Hex(payloadBytes)}`,
    },
    access,
    summary: sourceManifest.description || project.release?.description || project.name,
    language: project.default_language || sourceManifest.default_language || 'en',
    languages: project.languages || sourceManifest.languages || ['en'],
    license: project.license || sourceManifest.license || { type: 'CC-BY-4.0' },
    keywords: sourceManifest.keywords || [],
    lineage: canonicalLineage(project.lineage || sourceManifest.lineage),
    load_contract: {
      default_profile: 'compact',
      profiles: {
        index: { requires_decryption: false, max_tokens_hint: 200 },
        compact: { requires_decryption: false, max_tokens_hint: 500 },
        scenario: { requires_decryption: false, selection: 'triggered_sections_only' },
        full: { requires_decryption: false, intended_for: ['audit', 'reference'] },
      },
    },
    authoring: {
      compiler: '@aikdna/kdna-studio-core',
      compiler_version: require('../../package.json').version,
      source_build_id: compiled.identity?.build_id || sourceManifest.build_id || null,
      studio_project_digest: sourceManifest.authoring?.studio_project_digest || null,
      human_lock_required: true,
      human_lock_count: sourceManifest.authoring?.human_lock_count || compiled.stats?.locked_cards || 0,
    },
  };

  if (access === 'licensed') {
    manifest.entitlement = options.entitlement || { profile: 'local_receipt', offline: true, revocable: true };
  }
  if (access === 'remote') {
    manifest.runtime = options.runtime || { endpoint: null };
  }
  return manifest;
}

function exportRuntimeAsset(project, options = {}) {
  const compiled = options.compiled || compileDomain(project, options.compile || {});
  const payload = buildPayload(compiled);
  const payloadBytes = json(payload);
  const manifest = buildManifest(project, compiled, payloadBytes, options);
  const files = {
    mimetype: MIMETYPE_V1,
    'kdna.json': json(manifest),
    'payload.kdnab': payloadBytes,
  };
  files['checksums.json'] = json(buildChecksums(files));
  return {
    files,
    manifest,
    payload,
    source: compiled,
  };
}

module.exports = {
  MIMETYPE_V1,
  exportRuntimeAsset,
  buildPayload,
  buildManifest,
  buildChecksums,
  canonicalAccess,
  canonicalLineage,
};
