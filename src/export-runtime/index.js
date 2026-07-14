const crypto = require('crypto');
const cbor = require('cbor-x');
const { compileDomain } = require('../compile');
const {
  assertJudgmentCorePreserved,
  copyDeclaredJudgmentCore,
  pickJudgmentCore,
} = require('../judgment-core');

const MIMETYPE = 'application/vnd.kdna.asset';

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isLowerSlugChar(char) {
  const code = char.charCodeAt(0);
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || char === '_';
}

function isLowerAsciiLetter(char) {
  const code = char.charCodeAt(0);
  return code >= 97 && code <= 122;
}

function normalizeDomainIdBase(base) {
  let normalized = '';
  let previousUnderscore = false;
  for (const char of String(base).toLowerCase()) {
    if (isLowerSlugChar(char)) {
      normalized += char;
      previousUnderscore = char === '_';
    } else if (normalized && !previousUnderscore) {
      normalized += '_';
      previousUnderscore = true;
    }
  }
  return normalized.endsWith('_') ? normalized.slice(0, -1) : normalized;
}

function domainIdFromName(name = 'domain') {
  const base = String(name).includes('/') ? String(name).split('/').pop() : String(name);
  const normalized = normalizeDomainIdBase(base);
  return isLowerAsciiLetter(normalized[0] || '') ? normalized : `domain_${normalized || 'untitled'}`;
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

function nonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function canonicalRuntimeCreator(project, sourceManifest) {
  // Runtime creator metadata is optional provenance. Studio projects keep an
  // empty author object as an editing convenience, but that placeholder is
  // not an identity and must not mask a real imported creator or leak into a
  // published manifest. A declared Runtime creator always has a real name;
  // otherwise omit the entire record rather than inventing "Unknown".
  const candidates = [
    project?.author,
    sourceManifest?.creator,
    sourceManifest?.author,
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const name = nonEmptyString(candidate.name) || nonEmptyString(candidate.display_name);
    if (!name) continue;
    const id = nonEmptyString(candidate.id) || nonEmptyString(candidate.creator_id);
    return id ? { name, id } : { name };
  }

  return null;
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
  const entrySetDigest = `sha256:${sha256Hex(combined)}`;
  return {
    digest_profile: 'kdna-runtime-entry-set-v1',
    covered_entries: ['kdna.json', 'payload.kdnab'],
    algorithm: 'sha256',
    manifest_digest: `sha256:${entries['kdna.json'].value}`,
    payload_digest: `sha256:${entries['payload.kdnab'].value}`,
    entry_set_digest: entrySetDigest,
    // Deprecated v1 compatibility alias. This is not the final .kdna file hash.
    asset_digest: entrySetDigest,
    entries,
  };
}

function parseJsonFile(files, name, fallback = null) {
  // Bug (#30): prior version assumed `files` was a non-null object.
  // A caller that passed a partially-constructed `compiled` (e.g. a
  // stub in a test, or a `compileDomain` call that returned a
  // missing `files` map) would hit "Cannot read properties of
  // undefined" instead of the intended fallback.
  if (!files || typeof files !== 'object') return fallback;
  if (!files[name]) return fallback;
  return JSON.parse(files[name]);
}

function buildPayload(compiled) {
  // Source-KDNA_* meta fields (version / domain / created / purpose /
  // load_condition) are compile-time metadata. They live on the
  // kdna.json manifest at export time and are not part of the runtime
  // payload contract, which has its own top-level `meta` (built from
  // project.release). Documenting that explicitly here so a future
  // reader of #29 does not re-add an undocumented `core.meta` passthrough.
  const core = parseJsonFile(compiled.files, 'KDNA_Core.json', {});
  const patterns = parseJsonFile(compiled.files, 'KDNA_Patterns.json', {});
  const scenarios = parseJsonFile(compiled.files, 'KDNA_Scenarios.json', { scenes: [] });
  const cases = parseJsonFile(compiled.files, 'KDNA_Cases.json', { cases: [] });
  const reasoning = parseJsonFile(compiled.files, 'KDNA_Reasoning.json', { reasoning_chains: [] });
  const evolution = parseJsonFile(compiled.files, 'KDNA_Evolution.json', { changelog: [], version_notes: [] });

  const firstAxiom = Array.isArray(core.axioms) ? core.axioms[0] : null;
  // PC-3 (2026-06-27): the legacy default load_condition
  // ("Load when the task matches applies_when on domain axioms.")
  // is the project-bootstrap placeholder, not a real question. Treat
  // it as "unset" so the published asset surfaces either the author's
  // real load_condition (if they overrode the default), the first
  // axiom's one_sentence as a derived question, or an explicit
  // "(unset)" marker.
  const LEGACY_DEFAULT_LOAD_CONDITION =
    'Load when the task matches applies_when on domain axioms.';
  const authorSet =
    core.meta?.load_condition &&
    core.meta.load_condition !== LEGACY_DEFAULT_LOAD_CONDITION
      ? core.meta.load_condition
      : null;

  // Bug (2026-06-28 audit follow-up): prior buildPayload omitted every
  // type that compile added after the original 6-type launch — aesthetics,
  // frameworks, term / banned_term, ontology — and additionally mis-mapped
  // `reasoning.failure_modes` to `reasoning.reasoning_chains`, which put
  // the wrong object shape into a field whose schema is `misunderstanding`.
  // Cards of those types round-tripped out of the asset as if they had
  // never existed. The fix threads every compile output into the
  // judgment-profile-v1 payload it should have carried all along.
  return {
    profile: 'judgment-profile-v1',
    core: {
      highest_question:
        authorSet || firstAxiom?.one_sentence || '(unset — author should set load_condition in project meta)',
      ...pickJudgmentCore(core),
      axioms: Array.isArray(core.axioms) ? core.axioms : [],
      ontology: Array.isArray(core.ontology) ? core.ontology : [],
      // Bug (#27): prior version produced core_structure as an empty
      // hard-coded array at compile time and never read it into the
      // payload. Forward the source's core_structure if it has any
      // entries; fall back to [] so legacy callers that authored no
      // core_structure keep the prior behaviour.
      core_structure: Array.isArray(core.core_structure) ? core.core_structure : [],
      frameworks: Array.isArray(core.frameworks) ? core.frameworks : [],
      boundaries: Array.isArray(core.boundaries) ? core.boundaries : [],
      stances: Array.isArray(core.stances) ? core.stances : [],
      risk_model: {
        risks: Array.isArray(core.risks) ? core.risks : [],
      },
      aesthetics: Array.isArray(core.aesthetics) ? core.aesthetics
        : (Array.isArray(patterns.aesthetics) ? patterns.aesthetics : []),
    },
    patterns: [
      ...(Array.isArray(patterns.misunderstandings) ? patterns.misunderstandings : []),
      ...(Array.isArray(patterns.patterns) ? patterns.patterns : []),
      ...(Array.isArray(patterns.terminology?.standard_terms) ? patterns.terminology.standard_terms.map((t) => ({ ...t, type: 'term' })) : []),
      ...(Array.isArray(patterns.terminology?.banned_terms) ? patterns.terminology.banned_terms.map((t) => ({ ...t, type: 'banned_term' })) : []),
    ],
    scenarios: Array.isArray(scenarios.scenes) ? scenarios.scenes : [],
    cases: Array.isArray(cases.cases) ? cases.cases : [],
    reasoning: {
      // Field name is singular (`self_check`) to match the source KDNA_Patterns
      // and the payload-profile-v1 schema. (Earlier revision of buildPayload
      // emitted `self_checks` here, which the canonical schema rejects.)
      self_check: Array.isArray(patterns.self_check) ? patterns.self_check : [],
      // failure_modes is the structured `misunderstanding` summary, not
      // the reasoning chain. Build it from the locked misunderstanding
      // cards the same way the legacy CLI did. (Prior versions of this
      // file read `reasoning.failure_modes` from compile's KDNA_Reasoning,
      // which never produced that field — so failure_modes was always
      // an empty array and any test/consumer that expected real entries
      // got nothing.)
      //
      // Bug (#145 follow-up): the prior map only copied id / mode /
      // correct / key_distinction / why. The three field names that
      // v1 round-trip actually cares about — failure_risk,
      // applies_when, does_not_apply_when — were dropped here even
      // though `compilePatterns` writes them on the producer side
      // (compile/index.js). The fix forwards all three so a
      // misunderstanding card round-trips end-to-end with every
      // judgment field intact.
      failure_modes: Array.isArray(patterns.misunderstandings)
        ? patterns.misunderstandings.map((m) => ({
            id: m.id,
            mode: m.wrong,
            correct: m.correct,
            key_distinction: m.key_distinction,
            why: m.why,
            failure_risk: m.failure_risk,
            applies_when: m.applies_when,
            does_not_apply_when: m.does_not_apply_when,
          }))
        : [],
      reasoning_chains: Array.isArray(reasoning.reasoning_chains) ? reasoning.reasoning_chains : [],
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
  const packageVersion = require('../../package.json').version;
  const access = canonicalAccess(options.access || project.release?.access || sourceManifest.access);
  const domainId = sourceManifest.domain_id || domainIdFromName(project.name);
  const now = options.timestamp || sourceManifest.updated_at || sourceManifest.updated || new Date().toISOString();
  const creator = canonicalRuntimeCreator(project, sourceManifest);

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
    compatibility: {
      min_loader_version: '1.0.0',
      profile: 'judgment-profile-v1',
    },
    payload: {
      path: 'payload.kdnab',
      encoding: 'cbor',
      encrypted: !!options.encryptedPayload,
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
      // Must stay in sync with the spec (specs/load-profiles.md) and with
      // the studio-cli buildV1Manifest in bin/kdna-studio.js. Two builders
      // previously diverged: the studio-core path emitted incomplete
      // profile entries (scenario had no max_tokens_hint, full had no
      // selection), which broke loaders that read the contract.
      default_profile: 'compact',
      profiles: {
        index: {
          requires_decryption: false,
          max_tokens_hint: 500,
          selection: 'manifest metadata',
          intended_for: ['discovery'],
        },
        compact: {
          requires_decryption: Boolean(options.encryptedPayload),
          max_tokens_hint: 2000,
          selection: 'core judgment summary',
          intended_for: ['agent prompt'],
        },
        scenario: {
          requires_decryption: false,
          max_tokens_hint: 3000,
          selection: 'scenario cards',
          intended_for: ['situational loading'],
        },
        full: {
          requires_decryption: Boolean(options.encryptedPayload),
          max_tokens_hint: 12000,
          selection: 'full manifest and payload',
          intended_for: ['audit', 'migration'],
        },
      },
    },
    authoring: {
      compiler: '@aikdna/kdna-studio-core',
      compiler_version: packageVersion,
      conformance: {
        passed: true,
        kdna_version: '1.0',
        validator: '@aikdna/kdna-studio-core/export-runtime',
        validator_version: packageVersion,
        checked_at: now,
      },
      source_build_id: compiled.identity?.build_id || sourceManifest.build_id || null,
      studio_project_digest: sourceManifest.authoring?.studio_project_digest || null,
      human_lock_required: false,
      human_lock_policy: 'optional_provenance',
      human_lock_count: sourceManifest.authoring?.human_lock_count ?? compiled.stats?.human_lock_count ?? 0,
      human_confirmed: (sourceManifest.authoring?.human_lock_count ?? compiled.stats?.human_lock_count ?? 0) > 0,
    },
  };

  if (creator) {
    manifest.creator = creator;
  }

  if (access === 'licensed') {
    manifest.entitlement = options.entitlement || { profile: 'local_receipt', offline: true, revocable: true };
  }
  if (options.encryptionMeta) {
    manifest.encryption = options.encryptionMeta;
  }
  if (access === 'remote') {
    manifest.runtime = options.runtime || { endpoint: null };
  }
  return manifest;
}

function exportRuntimeAsset(project, options = {}) {
  // Bug #15 / #28: prior version never threaded the project's source
  // content through to compileDomain, so compileEvolution received
  // `sourceEvolution = null` and emit evolution.changelog /
  // version_notes as []. Likewise compileReasoning had no
  // sourceReasoning and compilePatterns had no sourcePatterns. The
  // v1.7.2 release added the source-* handling inside the compile
  // functions, but the runtime export path was the one that actually has
  // access to the source — it has to forward it.
  const compileOptions = {
    ...(options.compile || {}),
    source: options.source || project.source || {
      // When the caller does not provide a source explicitly, fall
      // back to project.source_manifest, which `cmdCreate --from-kdna`
      // populates from the original kdna.json. This restores the
      // legacy `from-kdna` round-trip without requiring every caller
      // to plumb the source through.
      patterns: project.source_patterns || null,
      reasoning: project.source_reasoning || null,
      evolution: project.source_evolution || null,
    },
  };
  const compiled = options.compiled || compileDomain(project, compileOptions);
  const payload = buildPayload(compiled);
  const declaredJudgmentCore = copyDeclaredJudgmentCore(project.judgment_core);
  const compiledCore = parseJsonFile(compiled.files, 'KDNA_Core.json', {});
  assertJudgmentCorePreserved(
    declaredJudgmentCore,
    pickJudgmentCore(compiledCore),
    'compiled_core',
  );
  assertJudgmentCorePreserved(
    declaredJudgmentCore,
    pickJudgmentCore(payload.core),
    'runtime_payload',
  );
  let payloadBytes = cbor.encode(payload);
  let encryptionMeta = null;

  // B2: Password-protected export — encrypt payload before manifest/checksums
  if (options.password) {
    const core = require('@aikdna/kdna-core');
    // AAD must match the fields in the final manifest (kdna.json).
    // buildManifest sets: asset_id = options.asset_id || 'kdna:studio:...'
    // version  = semverValue(sourceManifest.version || project.release?.version, ...)
    // encryptedEntryAad picks the first non-empty of (name, asset_id, ''),
    // and the decrypt-side manifest has no `name` field. So: set name=asset_id
    // and version to the exact values the manifest will carry.
    const sourceManifest = parseJsonFile(compiled.files, 'kdna.json', {});
    const domainId = sourceManifest.domain_id || domainIdFromName(project.name);
    const finalAssetId = options.asset_id || `kdna:studio:${domainId}`;
    const finalVersion = semverValue(sourceManifest.version || project.release?.version, '0.1.0');
    const envelope = core.encryptProtectedEntry(payloadBytes, {
      entryName: 'payload.kdnab',
      manifest: {
        name: finalAssetId,
        asset_id: finalAssetId,
        version: finalVersion,
      },
      password: options.password,
    });
    payloadBytes = cbor.encode(envelope);
    encryptionMeta = {
      profile: core.PASSWORD_PROTECTED_PROFILE,
      encrypted_entries: ['payload.kdnab'],
    };
    // Password-protected assets are implicitly licensed access.
    // Force override: a password-protected asset cannot be public.
    options.access = 'licensed';
    options.entitlement = options.entitlement || { profile: 'password', revocable: false, offline: true };
  }

  const manifest = buildManifest(project, compiled, payloadBytes, {
    ...options,
    encryptedPayload: !!encryptionMeta,
    encryptionMeta,
  });
  const files = {
    mimetype: MIMETYPE,
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
  MIMETYPE,
  exportRuntimeAsset,
  buildPayload,
  buildManifest,
  buildChecksums,
  canonicalAccess,
  canonicalLineage,
};
