'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const studioPackage = require('../package.json');
const packageLock = require('../package-lock.json');
const corePackage = require('@aikdna/kdna-core/package.json');
const cliPackage = require('@aikdna/kdna-cli/package.json');
const kdnaCore = require('@aikdna/kdna-core');

const { createProject } = require('../src/project');
const { createCard } = require('../src/cards');
const { compileDomain } = require('../src/compile');
const { exportRuntimeAsset } = require('../src/export-runtime');

const KDNA_CLI = path.join(path.dirname(require.resolve('@aikdna/kdna-cli/package.json')), 'src', 'cli.js');

function writeFiles(directory, files) {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(directory, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

test('release dependency graph contains the exact Runtime pair and one physical Core', () => {
  assert.equal(studioPackage.dependencies['@aikdna/kdna-cli'], '0.33.0');
  assert.equal(studioPackage.dependencies['@aikdna/kdna-core'], '0.18.0');
  assert.equal(packageLock.packages[''].dependencies['@aikdna/kdna-cli'], '0.33.0');
  assert.equal(packageLock.packages[''].dependencies['@aikdna/kdna-core'], '0.18.0');
  assert.equal(packageLock.packages['node_modules/@aikdna/kdna-cli'].version, '0.33.0');
  assert.equal(
    packageLock.packages['node_modules/@aikdna/kdna-cli'].dependencies['@aikdna/kdna-core'],
    '0.18.0',
  );
  assert.equal(packageLock.packages['node_modules/@aikdna/kdna-core'].version, '0.18.0');
  assert.equal(cliPackage.version, '0.33.0');
  assert.equal(corePackage.version, '0.18.0');

  const coreEntries = Object.keys(packageLock.packages).filter((entry) =>
    entry.endsWith('node_modules/@aikdna/kdna-core'),
  );
  assert.deepEqual(coreEntries, ['node_modules/@aikdna/kdna-core']);

  const directCore = fs.realpathSync(require.resolve('@aikdna/kdna-core/package.json'));
  const cliCore = fs.realpathSync(
    require.resolve('@aikdna/kdna-core/package.json', {
      paths: [path.dirname(require.resolve('@aikdna/kdna-cli/package.json'))],
    }),
  );
  assert.equal(cliCore, directCore);
});

test('blank authoring project reaches Core load while the CLI keeps its default Runtime boundary', (t) => {
  const project = createProject('blank_release_boundary', 'domain');
  project.cards.push(
    createCard(
      'axiom',
      {
        one_sentence: 'A portable judgment must preserve its declared boundary.',
        full_statement:
          'A portable judgment must preserve its declared boundary from authoring source through Runtime loading.',
        why: 'Silent boundary loss changes the decision.',
        applies_when: ['Exporting a runtime asset'],
        does_not_apply_when: ['Editing authoring notes'],
        failure_risk: 'The judgment may be applied outside its declared scope.',
      },
      'ax_release_boundary',
    ),
  );

  const compiled = compileDomain(project);
  const exported = exportRuntimeAsset(project, {
    compiled,
    asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000501',
    timestamp: '2026-07-15T00:00:00.000Z',
  });
  assert.deepEqual(Object.keys(exported.files).sort(), [
    'checksums.json',
    'kdna.json',
    'mimetype',
    'payload.kdnab',
  ]);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-studio-release-pair-'));
  const assetPath = `${directory}.kdna`;
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(assetPath, { force: true });
  });

  writeFiles(directory, exported.files);
  kdnaCore.pack(directory, assetPath);
  const validation = kdnaCore.validate(assetPath);
  assert.equal(validation.overall_valid, true, validation.problems.join('\n'));

  const capsule = kdnaCore.load(assetPath, { profile: 'compact', as: 'json' });
  assert.equal(capsule.type, 'kdna.context.capsule');
  assert.equal(capsule.version, '1.0');
  assert.equal(capsule.context.axioms[0].id, 'ax_release_boundary');
  assert.deepEqual(capsule.context.axioms[0].applies_when, ['Exporting a runtime asset']);
  assert.deepEqual(capsule.context.axioms[0].does_not_apply_when, ['Editing authoring notes']);

  const plan = JSON.parse(
    execFileSync(
      process.execPath,
      [KDNA_CLI, 'plan-use', assetPath, '--task=Review release boundary', '--as=json'],
      { encoding: 'utf8', env: { ...process.env, KDNA_QUIET: '1' } },
    ),
  );
  assert.equal(plan.plan_version, '0.9.0');
  assert.equal(plan.asset_ref.asset_id, 'kdna:studio:blank_release_boundary');
});
