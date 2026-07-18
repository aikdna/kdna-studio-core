const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cbor = require('cbor-x');

const { createProject } = require('../src/project');
const { createCard, lockCard, transitionCard } = require('../src/cards');
const { exportRuntimeAsset, buildManifest } = require('../src/export-runtime');
const kdnaCore = require('@aikdna/kdna-core');

function makeLockedCard(type, fields, id) {
  let card = createCard(type, fields, id);
  card = transitionCard(card, 'revised', { by: 'expert' });
  return lockCard(card, {
    by: 'expert',
    statement: 'I confirm this judgment.',
    checked: { applies_when: true, does_not_apply_when: true, failure_risk: true },
  });
}

function createRuntimeProject(access = 'public') {
  const project = createProject('studio_runtime_export', 'domain', {
    author: { name: 'Studio Expert', id: 'studio_expert' },
  });
  project.release = {
    version: '0.1.0',
    judgment_version: '0.1.0',
    description: 'Studio runtime export fixture.',
    access,
  };
  project.cards.push(makeLockedCard('axiom', {
    one_sentence: 'Runtime assets must load through KDNA Core.',
    full_statement: 'Studio export must produce a canonical runtime asset that KDNA Core can validate and plan before any product loads judgment content.',
    why: 'If Studio emits app-private or source-tree-only files, Chat and CLI will reimplement protocol behavior.',
    applies_when: ['Exporting a runtime .kdna asset'],
    does_not_apply_when: ['Editing an internal Studio project'],
    failure_risk: 'Consumers may silently load the wrong shape.',
  }, 'ax_runtime_001'));
  project.cards.push(makeLockedCard('self_check', {
    question: 'Did the runtime export pass KDNA Core validate and LoadPlan?',
  }, 'sc_runtime_001'));
  return project;
}

function writeFiles(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

test('runtime export emits only canonical runtime entries', () => {
  const project = createRuntimeProject();
  const exported = exportRuntimeAsset(project, {
    asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000321',
    timestamp: '2026-06-19T00:00:00.000Z',
  });

  assert.deepEqual(Object.keys(exported.files).sort(), [
    'checksums.json',
    'kdna.json',
    'mimetype',
    'payload.kdnab',
  ]);
  assert.equal(exported.files.mimetype, 'application/vnd.kdna.asset');
  assert.equal(exported.manifest.access, 'public');
  assert.equal(exported.manifest.payload.path, 'payload.kdnab');
  assert.equal(exported.manifest.payload.encoding, 'cbor');
  assert.equal(exported.manifest.payload.encrypted, false);
  assert.equal(exported.manifest.authoring.conformance.passed, true);
  assert.equal(exported.manifest.format_version, '0.1.0');
  assert.equal(exported.manifest.authoring.conformance.format_version, '0.1.0');
  assert.equal(
    exported.manifest.authoring.conformance.validator,
    '@aikdna/kdna-studio-core/export-runtime',
  );
  assert.ok(!('KDNA_Core.json' in exported.files));
  assert.ok(!('KDNA_Patterns.json' in exported.files));
  assert.equal(cbor.decode(exported.files['payload.kdnab']).profile, 'kdna.payload.judgment');
  assert.equal(cbor.decode(exported.files['payload.kdnab']).profile_version, '0.1.0');
  const checksums = JSON.parse(exported.files['checksums.json']);
  assert.equal(checksums.digest_profile, 'kdna.digest-basis.runtime-entry-set');
  assert.equal(checksums.digest_profile_version, '0.1.0');
  assert.deepEqual(checksums.covered_entries, ['kdna.json', 'payload.kdnab']);
  assert.match(checksums.entry_set_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(checksums, 'asset_digest'), false);
});

test('runtime export keeps authored evolution and excludes Studio lock audit projections', () => {
  const project = createRuntimeProject();
  project.cards.push(makeLockedCard('evolution_stage', {
    name: 'Source Reviewed',
    level: 2,
    description: 'The authored judgment reached its reviewed stage.',
    indicators: ['content reviewed'],
  }, 'stage_source_reviewed'));

  const exported = exportRuntimeAsset(project, {
    asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000322',
    timestamp: '2026-07-18T00:00:00.000Z',
  });
  const payload = cbor.decode(exported.files['payload.kdnab']);

  assert.deepEqual(
    payload.evolution.stages.map((stage) => stage.id),
    ['stage_source_reviewed'],
  );
  assert.equal(payload.evolution.stages[0].source_authored, true);
  assert.deepEqual(payload.evolution.evolution_layers, []);
  assert.deepEqual(payload.evolution.measurement, []);
  assert.equal(
    payload.evolution.stages.some((stage) => stage.id === 'stage_ax_runtime_001'),
    false,
    'authoring lock events must not become Runtime judgment evolution',
  );
});

test('runtime export preserves declared core relations and extended reasoning semantics', () => {
  const project = createRuntimeProject();
  project.source_core_structure = [{
    id: 'relation_runtime_001',
    from: 'ax_runtime_001',
    to: 'sc_runtime_001',
    relation: 'verified_by',
    via: { mode: 'explicit_self_check' },
  }];
  project.cards.push(makeLockedCard('reasoning', {
    axiom: 'ax_runtime_001',
    one_sentence: 'Validate before loading.',
    chain: ['inspect', 'validate', 'load'],
    principle: 'Validation precedes execution.',
    concrete_action: 'Reject invalid assets.',
    tradeoffs: ['Additional startup work'],
    conflict_resolution: { rule: 'Prefer declared protocol constraints.' },
    when_not_to_use: ['Already rejected input'],
    evidence_required: ['validation_receipt'],
    uncertainty_handling: { unknown: 'fail_closed' },
  }, 'reasoning_runtime_001'));

  const exported = exportRuntimeAsset(project, {
    asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000323',
    timestamp: '2026-07-18T00:00:00.000Z',
  });
  const payload = cbor.decode(exported.files['payload.kdnab']);

  assert.deepEqual(payload.core.core_structure, project.source_core_structure);
  const chain = payload.reasoning.reasoning_chains.find((entry) => entry.id === 'reasoning_runtime_001');
  assert.deepEqual(chain.tradeoffs, ['Additional startup work']);
  assert.deepEqual(chain.conflict_resolution, { rule: 'Prefer declared protocol constraints.' });
  assert.deepEqual(chain.when_not_to_use, ['Already rejected input']);
  assert.deepEqual(chain.evidence_required, ['validation_receipt']);
  assert.deepEqual(chain.uncertainty_handling, { unknown: 'fail_closed' });
});

test('runtime export normalizes every accepted timestamp source to an ISO date-time', () => {
  const project = createRuntimeProject();
  project.created = '2026-07-01';
  const exported = exportRuntimeAsset(project, {
    asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000332',
    timestamp: '2026-07-16',
    created_at: '2026-07-02',
    updated_at: '2026-07-16T08:30:00+08:00',
  });

  assert.equal(exported.manifest.created_at, '2026-07-02T00:00:00.000Z');
  assert.equal(exported.manifest.updated_at, '2026-07-16T00:30:00.000Z');
  assert.equal(exported.manifest.authoring.conformance.checked_at, '2026-07-16T00:00:00.000Z');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-studio-dates-'));
  try {
    writeFiles(dir, exported.files);
    const validation = kdnaCore.validate(dir);
    assert.equal(validation.overall_valid, true, validation.problems.join('\n'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime export rejects malformed explicit timestamp inputs instead of emitting a Core-invalid asset', () => {
  const cases = [
    ['timestamp', '2026-02-31T00:00:00Z'],
    ['timestamp', '2026-07-16T00:00:00'],
    ['created_at', 'not-a-date'],
    ['created_at', ''],
    ['updated_at', '2026-13-01'],
    ['updated_at', 1720000000000],
  ];

  for (const [field, value] of cases) {
    const options = {
      asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000333',
      timestamp: '2026-07-16T00:00:00.000Z',
      [field]: value,
    };
    assert.throws(
      () => exportRuntimeAsset(createRuntimeProject(), options),
      new RegExp(field === 'timestamp' ? 'timestamp' : field),
      `${field}=${String(value)}`,
    );
  }
});

test('runtime export preserves a declared project creator name and id', () => {
  const project = createRuntimeProject();
  const exported = exportRuntimeAsset(project, {
    asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000326',
    timestamp: '2026-07-14T00:00:00.000Z',
  });

  assert.deepEqual(exported.manifest.creator, {
    name: 'Studio Expert',
    id: 'studio_expert',
  });
});

test('runtime export omits creator when no real creator identity is declared', () => {
  const project = createRuntimeProject();
  project.author = { name: '', id: '' };
  const exported = exportRuntimeAsset(project, {
    asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000327',
    timestamp: '2026-07-14T00:00:00.000Z',
  });

  assert.equal(Object.hasOwn(exported.manifest, 'creator'), false);
  assert.equal(exported.files['kdna.json'].includes('Unknown'), false);
});

test('runtime export uses real imported creator provenance when project author is blank', () => {
  const project = createRuntimeProject();
  project.author = { name: '  ', id: 'blank_author_must_not_win' };
  project.creator_identity = {
    creator_id: 'kdna:creator:agent:studio-import',
    display_name: 'Studio Import Agent',
  };
  const exported = exportRuntimeAsset(project, {
    asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000328',
    timestamp: '2026-07-14T00:00:00.000Z',
  });

  assert.deepEqual(exported.manifest.creator, {
    name: 'Studio Import Agent',
    id: 'kdna:creator:agent:studio-import',
  });
});

test('runtime manifest preserves a legacy source author when newer creator fields are absent', () => {
  const project = createRuntimeProject();
  project.author = { name: '', id: '' };
  const manifest = buildManifest(
    project,
    {
      files: {
        'kdna.json': JSON.stringify({
          author: { name: ' Source Author ', id: ' source_author ' },
        }),
      },
      identity: { asset_uid: '00000000-0000-4000-8000-000000000331' },
      stats: {},
    },
    Buffer.from('creator-source-author-payload'),
    {
      asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000331',
      timestamp: '2026-07-14T00:00:00.000Z',
    },
  );

  assert.deepEqual(manifest.creator, {
    name: 'Source Author',
    id: 'source_author',
  });
});

test('runtime export does not turn whitespace-only provenance into an identity', () => {
  const project = createRuntimeProject();
  project.author = { name: '\t ', id: 'author-id-without-name' };
  project.creator_identity = {
    creator_id: 'creator-id-without-name',
    display_name: ' \n ',
  };
  const exported = exportRuntimeAsset(project, {
    asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000329',
    timestamp: '2026-07-14T00:00:00.000Z',
  });

  assert.equal(Object.hasOwn(exported.manifest, 'creator'), false);
  assert.doesNotMatch(exported.files['kdna.json'], /Unknown|author-id-without-name|creator-id-without-name/);
});

test('runtime export normalizes string routing fields into arrays', () => {
  const project = createRuntimeProject();
  project.cards[0].fields.applies_when = 'Exporting a runtime .kdna asset';
  project.cards[0].fields.does_not_apply_when = 'Editing an internal Studio project';

  const exported = exportRuntimeAsset(project, {
    asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000324',
    timestamp: '2026-06-19T00:00:00.000Z',
  });

  const [axiom] = exported.payload.core.axioms;
  assert.deepEqual(axiom.applies_when, ['Exporting a runtime .kdna asset']);
  assert.deepEqual(axiom.does_not_apply_when, ['Editing an internal Studio project']);
});

test('runtime export validates with KDNA Core and plans ready when planLoad is available', () => {
  const project = createRuntimeProject();
  const exported = exportRuntimeAsset(project, {
    asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000322',
    timestamp: '2026-06-19T00:00:00.000Z',
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-studio-runtime-'));
  try {
    writeFiles(dir, exported.files);
    const validation = kdnaCore.validate(dir);
    assert.equal(validation.overall_valid, true, validation.problems.join('\n'));

    const assetPath = `${dir}.kdna`;
    kdnaCore.pack(dir, assetPath);
    const plan = kdnaCore.planLoad(assetPath);
    assert.equal(plan.access, 'public');
    assert.equal(plan.state, 'ready');
    assert.equal(plan.required_action, 'load');
    assert.equal(plan.can_load_now, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(`${dir}.kdna`, { force: true });
  }
});

test('runtime export maps protected legacy access to licensed receipt profile', () => {
  const project = createRuntimeProject('protected');
  const exported = exportRuntimeAsset(project, {
    asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000323',
    timestamp: '2026-06-19T00:00:00.000Z',
  });

  assert.equal(exported.manifest.access, 'licensed');
  assert.equal(exported.manifest.entitlement.profile, 'local_receipt');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-studio-runtime-'));
  try {
    writeFiles(dir, exported.files);
    const validation = kdnaCore.validate(dir);
    assert.equal(validation.overall_valid, true, validation.problems.join('\n'));

    const assetPath = `${dir}.kdna`;
    kdnaCore.pack(dir, assetPath);
    const plan = kdnaCore.planLoad(assetPath);
    assert.equal(plan.access, 'licensed');
    assert.equal(plan.entitlement_profile, 'local_receipt');
    assert.equal(plan.state, 'needs_license');
    assert.equal(plan.required_action, 'install_receipt');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(`${dir}.kdna`, { force: true });
  }
});

test('password export uses a CBOR envelope and loads only with the password', () => {
  const project = createRuntimeProject();
  const password = 'studio-runtime-password';
  const exported = exportRuntimeAsset(project, {
    asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000325',
    timestamp: '2026-07-13T00:00:00.000Z',
    password,
  });

  assert.equal(exported.manifest.payload.encoding, 'cbor');
  assert.equal(exported.manifest.payload.encrypted, true);
  assert.equal(exported.manifest.access, 'licensed');
  const envelope = cbor.decode(exported.files['payload.kdnab']);
  assert.equal(typeof envelope, 'object');
  assert.equal(envelope.profile, kdnaCore.PASSWORD_PROTECTED_PROFILE);
  assert.equal(envelope.profile_version, kdnaCore.ENCRYPTION_PROFILE_VERSION);
  assert.equal(exported.manifest.encryption.profile, kdnaCore.PASSWORD_PROTECTED_PROFILE);
  assert.equal(
    exported.manifest.encryption.profile_version,
    kdnaCore.ENCRYPTION_PROFILE_VERSION,
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-studio-encrypted-'));
  try {
    writeFiles(dir, exported.files);
    assert.equal(kdnaCore.validate(dir).overall_valid, true);
    const assetPath = `${dir}.kdna`;
    kdnaCore.pack(dir, assetPath);
    assert.equal(kdnaCore.planLoad(assetPath).state, 'needs_password');
    assert.throws(
      () => kdnaCore.load(assetPath, { password: 'wrong-password' }),
      /decrypt|integrity|KDNA_DECRYPT_FAILED/i,
    );
    const capsule = kdnaCore.load(assetPath, { password, profile: 'compact', as: 'json' });
    assert.equal(capsule.type, 'kdna.runtime-capsule');
    assert.equal(capsule.contract_version, '0.1.0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(`${dir}.kdna`, { force: true });
  }
});
