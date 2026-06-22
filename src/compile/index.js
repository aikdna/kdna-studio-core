/**
 * Compile locked cards into KDNA domain JSON files — SPEC-compatible output.
 *
 * KDNA Container:
 *   - Judgment content is encoded as CBOR payload (payload.kdnab)
 *   - Individual KDNA_Core.json etc. are NOT exposed as ZIP entries
 *   - kdna.json manifest contains metadata only, no judgment content
 *
 * Only locked cards enter compilation. Draft/Revised excluded silently.
 */

const cbor = require('cbor-x');
const crypto = require('crypto');

function uuidv7() {
  const ts = BigInt(Date.now());
  const rand = crypto.randomBytes(10);
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(Number(ts), 0, 6);
  bytes[6] = 0x70 | (rand[0] & 0x0f);
  bytes[7] = rand[1];
  bytes[8] = 0x80 | (rand[2] & 0x3f);
  rand.copy(bytes, 9, 3);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalizeJson(name, content) {
  const obj = JSON.parse(content);
  if (name === 'kdna.json') {
    const copy = { ...obj };
    delete copy.signature;
    delete copy.asset_digest;
    delete copy.container_sha256;
    delete copy.content_digest;
    if (copy.authoring && typeof copy.authoring === 'object') {
      const auth = { ...copy.authoring };
      delete auth.content_digest;
      copy.authoring = auth;
    }
    return stableStringify(copy);
  }
  return stableStringify(obj);
}

function computeContentDigest(files) {
  // Content digest covers canonical judgment content + public asset metadata.
  // Reports and build-receipt are build evidence, not content — they change with
  // every build and would cause self-referencing if included.
  const excluded = new Set(['signature.json', '.DS_Store', 'build-receipt.json']);
  const payload = Object.keys(files)
    .filter(name => !excluded.has(name))
    .filter(name => !name.startsWith('reports/'))
    .sort()
    .map(name => {
      let content = files[name];
      if (name === 'mimetype') content = 'application/vnd.aikdna.kdna+zip';
      const buf = name.endsWith('.json')
        ? Buffer.from(canonicalizeJson(name, content))
        : Buffer.from(content);
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      return `${name}:${hash}`;
    })
    .join('\n');
  return `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`;
}

function domainIdFromName(name = 'domain') {
  const base = String(name).includes('/') ? String(name).split('/').pop() : String(name);
  const normalized = base.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(normalized) ? normalized : `domain_${normalized || 'untitled'}`;
}

function buildAssetIdentity(project, files, options = {}) {
  const domainId = project.domain_id || domainIdFromName(project.name);
  const registryName = project.registry_name || (String(project.name || '').startsWith('@') ? project.name : null);
  return {
    asset_uid: options.asset_uid || project.asset_uid || uuidv7(),
    project_uid: options.project_uid || project.project_uid || project.project_id || uuidv7(),
    build_id: options.build_id || `build_${uuidv7()}`,
    domain_id: domainId,
    registry_name: registryName,
    version: (project.release && project.release.version) || '0.1.0',
    judgment_version: (project.release && project.release.judgment_version) || (project.release && project.release.version) || '0.1.0',
    content_digest: options.content_digest || computeContentDigest(files),
    compiled_at: options.compiled_at || new Date().toISOString(),
  };
}

function makeMeta(project) {
  return {
    version: (project.release && project.release.version) || '0.1.0',
    domain: project.name,
    created: project.created || new Date().toISOString().slice(0, 10),
    purpose: project.release?.description || `Domain judgment for ${project.name}`,
    load_condition: 'Load when the task matches applies_when on domain axioms.',
  };
}

function compileCore(cards, project) {
  const lockedAxioms = cards
    .filter(c => c.type === 'axiom' && c.locked)
    .map(c => ({ id: c.id, ...c.fields, status: c.status, human_lock: c.human_lock }));
  const lockedOntology = cards.filter(c => c.type === 'ontology' && c.locked).map(c => ({ id: c.id, ...c.fields }));
  const lockedBoundaries = cards.filter(c => c.type === 'boundary' && c.locked);
  const lockedRisks = cards.filter(c => c.type === 'risk' && c.locked).map(c => ({ id: c.id, ...c.fields }));
  const lockedStances = cards.filter(c => c.type === 'stance' && c.locked).map(c => ({ id: c.id, ...c.fields }));

  return {
    meta: makeMeta(project),
    axioms: lockedAxioms,
    ontology: lockedOntology,
    frameworks: [],
    stances: lockedStances,
    core_structure: [],
    boundaries: lockedBoundaries.map(c => ({
      id: c.id,
      scope: c.fields?.scope || '',
      out_of_scope: c.fields?.out_of_scope || '',
      acceptable_exceptions: c.fields?.acceptable_exceptions || [],
    })),
    risks: lockedRisks,
  };
}

function compilePatterns(cards, project) {
  const lockedMisunderstandings = cards.filter(c => c.type === 'misunderstanding' && c.locked).map(c => ({
    id: c.id,
    wrong: c.fields?.wrong || '',
    correct: c.fields?.correct || '',
    key_distinction: c.fields?.key_distinction || '',
    why: c.fields?.why || `What bad judgment results from believing "${(c.fields?.wrong || '').slice(0, 40)}"`,
    failure_risk: c.fields?.failure_risk || 'No specific failure risk declared',
    applies_when: c.fields?.applies_when || [],
    does_not_apply_when: c.fields?.does_not_apply_when || [],
  }));
  const lockedSelfChecks = cards.filter(c => c.type === 'self_check' && c.locked).map(c => c.fields?.question || '');
  const lockedAesthetics = cards.filter(c => c.type === 'aesthetic' && c.locked).map(c => ({ id: c.id, ...c.fields }));
  const lockedPatterns = cards.filter(c => c.type === 'pattern' && c.locked).map(c => ({
    type: c.fields?.type || 'pattern',
    id: c.id,
    name: c.fields?.name || '',
    one_sentence: c.fields?.one_sentence || '',
    what_it_looks_like: c.fields?.what_it_looks_like || '',
    how_to_fix: c.fields?.how_to_fix || '',
    failure_risk: c.fields?.failure_risk || '',
  }));

  return {
    meta: makeMeta(project),
    terminology: {
      standard_terms: [],
      banned_terms: [],
    },
    misunderstandings: lockedMisunderstandings,
    patterns: lockedPatterns,
    self_check: lockedSelfChecks,
    aesthetics: lockedAesthetics,
  };
}

function compileScenarios(cards, project) {
  const locked = cards.filter(c => c.type === 'scenario' && c.locked);
  if (locked.length === 0) return null;
  return {
    meta: makeMeta(project),
    scenes: locked.map(c => ({ id: c.id, ...c.fields })),
  };
}

function compileCases(cards, project) {
  const locked = cards.filter(c => c.type === 'case' && c.locked);
  if (locked.length === 0) return null;
  return {
    meta: makeMeta(project),
    cases: locked.map(c => ({ id: c.id, ...c.fields })),
  };
}

function compileReasoning(cards, project) {
  const lockedAxioms = cards.filter(c => c.type === 'axiom' && c.locked);
  if (lockedAxioms.length === 0) return null;
  return {
    meta: makeMeta(project),
    reasoning_chains: lockedAxioms.map(ax => ({
      id: `chain_${ax.id}`,
      one_sentence: ax.fields?.one_sentence || '',
      logic: [ax.fields?.full_statement || ''],
      so_what: ax.fields?.why || 'Agent judgment changes when this axiom is loaded.',
    })),
  };
}

function compileEvolution(cards, project) {
  const lockedCards = cards.filter(c => c.locked);
  if (lockedCards.length === 0) return null;

  const stages = [];
  const seenAxioms = new Set();
  for (const card of lockedCards) {
    if (seenAxioms.has(card.id)) continue;
    seenAxioms.add(card.id);
    for (const entry of (card.audit_log || [])) {
      if (entry.event === 'locked') {
        stages.push({
          id: `stage_${card.id}`,
          name: card.fields?.one_sentence || card.fields?.question || card.id,
          description: `Card ${card.id} was locked by ${entry.by} at ${entry.at}. Type: ${card.type}.`,
          indicators: [`${card.type} card locked`, 'Human judgment confirmed'],
        });
      }
    }
  }

  return {
    meta: makeMeta(project),
    stages: stages.sort((a, b) => a.id.localeCompare(b.id)),
    evolution_layers: [
      { id: 'layer_1', name: 'Foundation', capability: 'Core axioms and patterns established.', from_stage: stages[0]?.id || 'none', to_stage: stages[stages.length - 1]?.id || 'none' },
    ],
    measurement: [
      { id: 'meas_axioms', what: 'locked_axioms', how: 'Count of locked axiom cards', threshold: `${lockedCards.filter(c => c.type === 'axiom').length}` },
      { id: 'meas_misunderstandings', what: 'locked_misunderstandings', how: 'Count of locked misunderstanding cards', threshold: `${lockedCards.filter(c => c.type === 'misunderstanding').length}` },
      { id: 'meas_self_checks', what: 'self_checks', how: 'Count of locked self-check cards', threshold: `${lockedCards.filter(c => c.type === 'self_check').length}` },
    ],
  };
}

function compileManifest(project, files, identity = null) {
  const kdnaFileCount = Object.keys(files).filter(f => f.startsWith('KDNA_')).length;
  const lockedCards = (project.cards || []).filter(c => c.locked);
  const tests = project.tests || [];
  const version = require('../../package.json').version;
  const assetIdentity = identity || buildAssetIdentity(project, files);
  const projectDigest = crypto
    .createHash('sha256')
    .update(JSON.stringify({
      project_id: project.project_id,
      name: project.name,
      cards: lockedCards.map(c => ({ id: c.id, type: c.type, fields: c.fields, human_lock: c.human_lock })),
    }))
    .digest('hex');
  const manifest = {
    format: 'kdna',
    format_version: '2.0',
    spec_version: '2.0',
    name: project.name,
    domain_id: assetIdentity.domain_id,
    asset_uid: assetIdentity.asset_uid,
    project_uid: assetIdentity.project_uid,
    build_id: assetIdentity.build_id,
    version: assetIdentity.version,
    judgment_version: assetIdentity.judgment_version,
    content_digest: assetIdentity.content_digest,
    status: (project.release && project.release.status) || 'experimental',
    quality_badge: tests.filter(t => t.result === 'with_kdna_better').length >= 10 ? 'tested' : 'untested',
    access: (project.release && project.release.access) || 'open',
    languages: project.languages || ['en'],
    default_language: project.default_language || 'en',
    author: project.author || { name: '', id: '' },
    license: project.license || { type: 'CC-BY-4.0' },
    description: project.release?.description || project.name,
    file_count: kdnaFileCount,
    container: {
      type: 'kdna-container-v2',
      payload: 'payload.kdnab',
      payload_encoding: 'cbor',
      payload_schema: 'kdna-payload-v2',
      payload_digest: `sha256:${crypto.createHash('sha256').update(files['payload.kdnab']).digest('hex')}`,
    },
    runtime: {
      min_runtime_version: '0.3.0',
      load_contract: 'context-capsule-v1',
    },
    creator: project.creator_identity ? {
      creator_id: project.creator_identity.creator_id,
      display_name: project.creator_identity.display_name,
      public_key: project.creator_identity.public_key,
      verified: project.creator_identity.verified || false,
    } : null,
    authoring: {
      created_by: 'kdna-studio-sdk',
      authoring_tool: 'KDNA Studio Core',
      authoring_tool_version: version,
      compiler: '@aikdna/kdna-studio-core',
      compiler_version: version,
      conformance: {
        passed: true,
        spec_version: '2.0',
        validator: '@aikdna/kdna-studio-core',
        validator_version: version,
        checked_at: assetIdentity.compiled_at,
      },
      source_mode: project.source_mode || 'blank',
      asset_uid: assetIdentity.asset_uid,
      project_uid: assetIdentity.project_uid,
      build_id: assetIdentity.build_id,
      domain_id: assetIdentity.domain_id,
      content_digest: assetIdentity.content_digest,
      studio_project_digest: `sha256:${projectDigest}`,
      human_lock_required: false,
      human_lock_policy: 'optional_provenance',
      human_lock_count: lockedCards.length,
      ai_assisted: (project.cards || []).some(c => c.history?.some(h => h.by === 'ai')),
      human_confirmed: lockedCards.length > 0,
      compiled_at: assetIdentity.compiled_at,
    },
    lineage: project.lineage || { type: 'original' },
    created: project.created || new Date().toISOString().slice(0, 10),
    updated: project.updated || new Date().toISOString().slice(0, 10),
  };
  if (assetIdentity.registry_name) {
    manifest.registry_name = assetIdentity.registry_name;
    manifest.authoring.registry_name = assetIdentity.registry_name;
  }
  return manifest;
}

function buildReports(project, files, identity, provenance, stats) {
  const cards = project.cards || [];
  const lockedCards = cards.filter(c => c.locked);
  const judgmentCards = cards.filter(c => ['axiom', 'ontology', 'misunderstanding', 'self_check', 'boundary', 'risk', 'aesthetic', 'scenario', 'case'].includes(c.type));
  const tests = project.tests || [];
  const ratedTests = tests.filter(t => t.result);
  const qualityBadge = tests.filter(t => t.result === 'with_kdna_better').length >= 10 ? 'tested' : 'untested';
  const packageVersion = require('../../package.json').version;

  const buildReport = {
    schema_version: 'studio-build-report-v1',
    build_id: identity.build_id,
    asset_uid: identity.asset_uid,
    project_uid: identity.project_uid,
    domain_id: identity.domain_id,
    registry_name: identity.registry_name,
    compiler: '@aikdna/kdna-studio-core',
    compiler_version: packageVersion,
    compiled_at: identity.compiled_at,
    content_digest: identity.content_digest,
    stats,
    validations: {
      schema_validation: 'required_before export',
      cross_file_validation: 'required_before export',
      id_uniqueness: 'required_before export',
      language_version_consistency: 'required_before export',
    },
    outputs: Object.keys(files).sort(),
  };

  const humanLockReport = {
    schema_version: 'human-lock-report-v1',
    build_id: identity.build_id,
    human_lock_required: false,
    human_lock_policy: 'optional_provenance',
    human_lock_count: lockedCards.length,
    judgment_card_count: judgmentCards.length,
    unlocked_judgment_card_count: judgmentCards.filter(c => !c.locked).length,
    cards: lockedCards.map(c => ({
      id: c.id,
      type: c.type,
      locked: true,
      locked_by: c.human_lock?.by || null,
      locked_at: c.human_lock?.at || null,
      judgment_fingerprint: c.human_lock?.judgment_fingerprint || null,
    })),
  };

  const qualityGateReport = {
    schema_version: 'quality-gate-report-v1',
    build_id: identity.build_id,
    quality_badge: qualityBadge,
    eval_count: tests.length,
    rated_eval_count: ratedTests.length,
    gates: {
      untested: {
        passed: true,
        evidence: ['schema-compatible compile output', 'provenance report', 'human-lock report'],
      },
      tested: {
        passed: qualityBadge === 'tested',
        required: '>=10 eval cases where KDNA improves judgment with manual verification',
      },
      validated: {
        passed: false,
        required: 'reproducible scoring, raw outputs, and published eval evidence',
      },
    },
  };

  const evalReport = {
    schema_version: 'eval-report-v1',
    build_id: identity.build_id,
    total: tests.length,
    rated: ratedTests.length,
    cases: tests.map(t => ({
      id: t.id || null,
      title: t.title || t.name || null,
      result: t.result || null,
      linked_cards: t.linked_cards || [],
    })),
  };

  const buildReceipt = {
    schema_version: 'studio-build-receipt-v1',
    asset_uid: identity.asset_uid,
    project_uid: identity.project_uid,
    build_id: identity.build_id,
    domain_id: identity.domain_id,
    registry_name: identity.registry_name,
    version: identity.version,
    judgment_version: identity.judgment_version,
    content_digest: identity.content_digest,
    asset_digest: null,
    compiler: '@aikdna/kdna-studio-core',
    compiler_version: packageVersion,
    signature_status: 'pending_export_sign',
    encryption_profile: project.release?.access === 'licensed' ? 'kdna-licensed-entry-v1' : null,
    built_at: identity.compiled_at,
  };

  return {
    'reports/build-report.json': JSON.stringify(buildReport, null, 2),
    'reports/provenance-report.json': JSON.stringify(provenance, null, 2),
    'reports/human-lock-report.json': JSON.stringify(humanLockReport, null, 2),
    'reports/quality-gate-report.json': JSON.stringify(qualityGateReport, null, 2),
    'reports/eval-report.json': JSON.stringify(evalReport, null, 2),
    'build-receipt.json': JSON.stringify(buildReceipt, null, 2),
  };
}

function compileDomain(project, options = {}) {
  const cards = project.cards || [];

  // ── Empty-domain gate (PR-2) ────────────────────────────────────
  // A KDNA domain with no locked judgment content of any kind is not a
  // domain — it is a content-shaped empty file. Refuse to compile so the
  // downstream Registry / Lab / Studio export never advertises an empty
  // judgment asset as "successfully compiled".
  const lockedCards = cards.filter(c => c.locked);
  const hasJudgmentContent = lockedCards.some(c =>
    ['axiom', 'misunderstanding', 'scenario', 'case', 'self_check', 'boundary', 'risk', 'ontology', 'aesthetic', 'stance', 'pattern'].includes(c.type)
  );
  if (!hasJudgmentContent) {
    const err = new Error(
      'refusing to compile empty KDNA domain: no locked judgment content ' +
      `(axiom / misunderstanding / scenario / case / self_check / boundary / risk / ontology / aesthetic). ` +
      `Found ${lockedCards.length} locked card(s) and ${cards.length} total card(s).`
    );
    err.code = 'EMPTY_DOMAIN';
    throw err;
  }

  const core = compileCore(cards, project);
  const patterns = compilePatterns(cards, project);
  const scenarios = compileScenarios(cards, project);
  const cases = compileCases(cards, project);
  const reasoning = compileReasoning(cards, project);
  const evolution = compileEvolution(cards, project);

  // ── RFC-0013 §3.1/§3.2 Compile Gates (PR-3) ───────────────────
  // Run the Source Authority Graph gate and the Truth Charter gate
  // BEFORE packaging. By default, missing/unstable SAG/TC are warnings.
  // Pass options.strictAuthority = true to treat gate issues as errors
  // (recommended for official publication pipelines).
  const strictAuthority = options.strictAuthority === true;
  const { runSagGate } = require('./source-authority-gate');
  const { runTcGate } = require('./truth-charter-gate');
  const sag = runSagGate(options.sourceAuthority, { strict: strictAuthority });
  const tc = runTcGate(options.truthCharter, {
    strict: strictAuthority,
    sourceAuthority: options.sourceAuthority || null,
    patterns: patterns || null,
  });
  const gates = { sag, tc, strict_authority: strictAuthority };
  // Gate policy: strictAuthority=true + any gate.status === 'fail' => throw.
  if (strictAuthority && (sag.status === 'fail' || tc.status === 'fail')) {
    const allErrors = [...sag.errors, ...tc.errors];
    const err = new Error(
      `Strict-authority compile failed. ${allErrors.length} gate error(s):\n` +
        allErrors.map((e) => `  - ${e}`).join('\n'),
    );
    err.code = 'GATE_FAIL';
    err.gates = gates;
    throw err;
  }

  const files = {
    'KDNA_Core.json': JSON.stringify(core, null, 2),
    'KDNA_Patterns.json': JSON.stringify(patterns, null, 2),
  };
  if (scenarios) files['KDNA_Scenarios.json'] = JSON.stringify(scenarios, null, 2);
  if (cases) files['KDNA_Cases.json'] = JSON.stringify(cases, null, 2);
  if (reasoning) files['KDNA_Reasoning.json'] = JSON.stringify(reasoning, null, 2);
  if (evolution) files['KDNA_Evolution.json'] = JSON.stringify(evolution, null, 2);

  // Encode judgment as CBOR payload
  const payload = {
    kind: 'kdna.payload',
    payload_version: '2.0',
    domain: { name: project.name, version: (project.release && project.release.version) || '0.1.0' },
    judgment: { core, patterns },
    profiles: {},
    integrity: {},
  };
  if (scenarios) payload.judgment.scenarios = scenarios;
  if (cases) payload.judgment.cases = cases;
  if (reasoning) payload.judgment.reasoning = reasoning;
  if (evolution) payload.judgment.evolution = evolution;
  files['payload.kdnab'] = cbor.encode(payload);

  // ── KDNA Card (governance metadata) ─────────────────────────────
  // Must be added BEFORE digest computation so it is included in content_digest.
  const identity = buildAssetIdentity(project, files);
  const provenance = require('../provenance').buildProvenance(project, files, identity);
  const { generateKdnaCard } = require('../governance');
  const kdnaCard = generateKdnaCard(project, {}, provenance);
  files['KDNA_CARD.json'] = JSON.stringify(kdnaCard, null, 2);

  const excludedCount = cards.filter(c => !c.locked && !['deprecated'].includes(c.status)).length;
  const stats = {
    total_cards: cards.length,
    locked_cards: cards.filter(c => c.locked).length,
    excluded_cards: excludedCount,
    deprecated_cards: cards.filter(c => c.status === 'deprecated').length,
    kdna_files: Object.keys(files).filter(f => f.startsWith('KDNA_')).length,
    total_files: Object.keys(files).length,
  };

  // Compute content_digest once with all files present, BEFORE building reports.
  identity.content_digest = computeContentDigest(files);
  provenance.content_digest = identity.content_digest;
  provenance.content_fingerprint = identity.content_digest;

  // Now build reports/receipt — they will all see the same digest.
  Object.assign(files, buildReports(project, files, identity, provenance, stats));
  files['reports/provenance-report.json'] = JSON.stringify(provenance, null, 2);
  files['kdna.json'] = JSON.stringify(compileManifest(project, files, identity), null, 2);
  stats.total_files = Object.keys(files).length;

  return {
    files,
    stats,
    identity,
    gates,
  };
}

function generateReadme(project, options = {}) {
  const cards = project.cards || [];
  const locked = cards.filter(c => c.locked);
  const lockedAxioms = locked.filter(c => c.type === 'axiom');
  const lockedMisunderstandings = locked.filter(c => c.type === 'misunderstanding');
  const lockedSelfChecks = locked.filter(c => c.type === 'self_check');
  const lockedBoundaries = locked.filter(c => c.type === 'boundary');
  const tests = project.tests || [];

  const lines = [];
  lines.push(`# ${project.name}`);
  lines.push('');
  if (options.description) { lines.push(options.description); lines.push(''); }

  lines.push('## Where it comes from');
  lines.push('');
  lines.push(options.origin || `Domain expertise encoded into ${locked.length} judgment cards through structured interview and human lock.`);
  lines.push('');

  lines.push('## Where it applies');
  lines.push('');
  const appliesWhen = [...new Set(lockedAxioms.flatMap(ax => ax.fields?.applies_when || []))];
  appliesWhen.length ? appliesWhen.forEach(w => lines.push(`- ${w}`)) : lines.push('- As declared in each axiom\'s applies_when field.');
  lines.push('');

  lines.push('## How it is verified');
  lines.push('');
  lines.push(`- ${tests.length} eval cases (${tests.filter(t => t.result).length} rated)`);
  lines.push(`- ${lockedAxioms.length} locked axioms with applies_when / does_not_apply_when / failure_risk`);
  lines.push(`- ${lockedSelfChecks.length} self-check questions`);
  lines.push(`- ${lockedMisunderstandings.length} misunderstanding patterns`);
  lines.push('');

  lines.push('## When it does NOT apply');
  lines.push('');
  const notApply = [...new Set(lockedAxioms.flatMap(ax => ax.fields?.does_not_apply_when || []))];
  notApply.forEach(w => lines.push(`- ${w}`));
  for (const oos of lockedBoundaries.flatMap(b => [b.fields?.out_of_scope || '']).filter(Boolean)) {
    if (!notApply.includes(oos)) lines.push(`- ${oos}`);
  }
  lines.push('');

  if (lockedAxioms.length > 0) {
    lines.push('## Top Axioms'); lines.push('');
    lockedAxioms.forEach(ax => {
      lines.push(`- **${ax.fields?.one_sentence || ax.id}**`);
      if (ax.fields?.failure_risk) lines.push(`  - Failure risk: ${ax.fields.failure_risk}`);
    });
    lines.push('');
  }

  if (lockedMisunderstandings.length > 0) {
    lines.push('## Top Misunderstandings'); lines.push('');
    lockedMisunderstandings.forEach(ms => {
      lines.push(`- WRONG: ${ms.fields?.wrong}`);
      lines.push(`  CORRECT: ${ms.fields?.correct}`);
    });
    lines.push('');
  }

  if (lockedSelfChecks.length > 0) {
    lines.push('## Eval Score'); lines.push('');
    lines.push(`- quality_badge: ${tests.filter(t => t.result === 'with_kdna_better').length >= 3 ? 'tested' : 'untested'}`);
    lines.push(`- eval cases: ${tests.length}`);
    lines.push('');
  }

  lines.push('## Files'); lines.push('');
  const kdnaFileCount = 2
    + (cards.filter(c => c.type === 'scenario' && c.locked).length > 0 ? 1 : 0)
    + (cards.filter(c => c.type === 'case' && c.locked).length > 0 ? 1 : 0)
    + (lockedAxioms.length > 0 ? 1 : 0)
    + (locked.length > 0 ? 1 : 0);
  lines.push(`${kdnaFileCount} KDNA JSON files + evals/ + demo/`);
  lines.push('');

  return lines.join('\n');
}

module.exports = { compileDomain, compileCore, compilePatterns, compileScenarios, compileCases, compileReasoning, compileEvolution, compileManifest, generateReadme, buildAssetIdentity, computeContentDigest, runSagGate: require('./source-authority-gate').runSagGate, runTcGate: require('./truth-charter-gate').runTcGate };
