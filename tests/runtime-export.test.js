const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cbor = require('cbor-x');

const { createProject } = require('../src/project');
const { createCard, lockCard, transitionCard } = require('../src/cards');
const { exportRuntimeAsset } = require('../src/export-runtime');
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

    const plan = kdnaCore.planLoad(dir);
    assert.equal(plan.access, 'public');
    assert.equal(plan.state, 'ready');
    assert.equal(plan.required_action, 'load');
    assert.equal(plan.can_load_now, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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

    const plan = kdnaCore.planLoad(dir);
    assert.equal(plan.access, 'licensed');
    assert.equal(plan.entitlement_profile, 'local_receipt');
    assert.equal(plan.state, 'needs_license');
    assert.equal(plan.required_action, 'install_receipt');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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
  assert.equal(typeof cbor.decode(exported.files['payload.kdnab']), 'object');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-studio-encrypted-'));
  try {
    writeFiles(dir, exported.files);
    assert.equal(kdnaCore.validate(dir).overall_valid, true);
    assert.equal(kdnaCore.planLoad(dir).state, 'needs_password');
    assert.throws(
      () => kdnaCore.load(dir, { password: 'wrong-password' }),
      /decrypt|integrity|KDNA_DECRYPT_FAILED/i,
    );
    const capsule = kdnaCore.load(dir, { password, profile: 'compact', as: 'json' });
    assert.equal(capsule.type, 'kdna.context.capsule');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
