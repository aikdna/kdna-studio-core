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
  assert.equal(exported.manifest.authoring.conformance.kdna_version, '1.0');
  assert.equal(
    exported.manifest.authoring.conformance.validator,
    '@aikdna/kdna-studio-core/export-runtime',
  );
  assert.ok(!('KDNA_Core.json' in exported.files));
  assert.ok(!('KDNA_Patterns.json' in exported.files));
  assert.equal(cbor.decode(exported.files['payload.kdnab']).profile, 'judgment-profile-v1');
  const checksums = JSON.parse(exported.files['checksums.json']);
  assert.equal(checksums.digest_profile, 'kdna-runtime-entry-set-v1');
  assert.deepEqual(checksums.covered_entries, ['kdna.json', 'payload.kdnab']);
  assert.match(checksums.entry_set_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(checksums.entry_set_digest, checksums.asset_digest);
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
  assert.equal(exported.manifest.encryption.profile, kdnaCore.PASSWORD_PROTECTED_PROFILE);

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
    assert.equal(capsule.type, 'kdna.context.capsule');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(`${dir}.kdna`, { force: true });
  }
});
