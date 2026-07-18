#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const LEGACY_NAME = '@aikdna/studio-core';
const LEGACY_VERSION = '1.2.1';
const CURRENT_NAME = '@aikdna/kdna-studio-core';
const CURRENT_VERSION = '2.0.2';
const REGISTRY = 'https://registry.npmjs.org/';

function installRegistryPackages(consumerRoot) {
  const runner = path.join(__dirname, 'run-trusted-npm.js');
  const result = spawnSync(process.execPath, [
    runner,
    'install',
    '--prefix', consumerRoot,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=true',
    `--registry=${REGISTRY}`,
    `--@aikdna:registry=${REGISTRY}`,
    `${LEGACY_NAME}@${LEGACY_VERSION}`,
    `${CURRENT_NAME}@${CURRENT_VERSION}`,
  ], {
    cwd: consumerRoot,
    env: process.env,
    encoding: 'utf8',
    shell: false,
  });

  if (result.error) throw result.error;
  if (result.signal) throw new Error(`registry install was interrupted by ${result.signal}`);
  if (result.status !== 0) {
    throw new Error(`registry install failed with exit status ${String(result.status)}`);
  }
}

function verifyExactPackage(consumerRequire, packageName, version) {
  const manifest = consumerRequire(`${packageName}/package.json`);
  assert.equal(manifest.name, packageName);
  assert.equal(manifest.version, version);
  assert.equal(manifest.type, 'commonjs');
  assert.equal(manifest.main, 'src/index.js');
  assert.equal(manifest.engines.node, '>=18');
  return manifest;
}

function verifyLegacyMainFailure(consumerRequire) {
  assert.throws(
    () => consumerRequire(LEGACY_NAME),
    (error) => {
      assert.equal(error.code, 'MODULE_NOT_FOUND');
      assert.match(
        error.message,
        /studio-schemas[/\\]studio\.project\.schema\.json/,
        'legacy main must fail for the known missing packaged schema',
      );
      return true;
    },
  );
}

function verifyCurrentMain(consumerRequire) {
  const studio = consumerRequire(CURRENT_NAME);

  for (const [responsibility, method] of [
    ['project', 'createProject'],
    ['project', 'validateProject'],
    ['cards', 'createCard'],
    ['cards', 'transitionCard'],
    ['cards', 'lockCard'],
    ['compile', 'compileDomain'],
    ['exportRuntime', 'exportRuntimeAsset'],
  ]) {
    assert.equal(
      typeof studio[responsibility]?.[method],
      'function',
      `${CURRENT_NAME} main must export ${responsibility}.${method}`,
    );
  }

  const project = studio.project.createProject('registry_migration_smoke', 'domain', {
    author: { name: 'Registry Smoke', id: 'registry_smoke' },
  });
  const draft = studio.cards.createCard('axiom', {
    one_sentence: 'Runtime packages require explicit migration.',
    full_statement: 'Registry migration must preserve the current authoring and runtime export contract.',
    why: 'A package rename without a cold-install smoke can hide missing files and changed behavior.',
    applies_when: ['Migrating the Studio Core package'],
    does_not_apply_when: ['Reviewing unrelated packages'],
    failure_risk: 'Consumers may assume compatibility that the registry artifacts do not provide.',
  }, 'ax_registry_migration');
  const revised = studio.cards.transitionCard(draft, 'revised', { by: 'registry_smoke' });
  const locked = studio.cards.lockCard(revised, {
    by: 'registry_smoke',
    statement: 'This synthetic fixture verifies only package mechanics.',
    checked: {
      applies_when: true,
      does_not_apply_when: true,
      failure_risk: true,
    },
  });

  assert.equal(draft.status, 'draft', 'transitionCard must not mutate its input');
  assert.equal(revised.status, 'revised', 'lockCard must not mutate its input');
  assert.equal(locked.status, 'locked');
  project.cards.push(locked);

  assert.deepEqual(studio.project.validateProject(project), { valid: true, issues: [] });
  const compiled = studio.compile.compileDomain(project);
  const exported = studio.exportRuntime.exportRuntimeAsset(project, {
    compiled,
    asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000501',
    timestamp: '2026-07-18T00:00:00.000Z',
  });

  assert.deepEqual(Object.keys(exported.files).sort(), [
    'checksums.json',
    'kdna.json',
    'mimetype',
    'payload.kdnab',
  ]);
  assert.equal(exported.files.mimetype, 'application/vnd.kdna.asset');
  assert.equal(exported.payload.profile, 'kdna.payload.judgment');
  assert.equal(exported.payload.profile_version, '0.1.0');
}

function verifyLockfile(consumerRoot) {
  const lock = JSON.parse(fs.readFileSync(path.join(consumerRoot, 'package-lock.json'), 'utf8'));
  for (const [name, version] of [
    [LEGACY_NAME, LEGACY_VERSION],
    [CURRENT_NAME, CURRENT_VERSION],
  ]) {
    const suffix = `/node_modules/${name}`;
    const matches = Object.entries(lock.packages).filter(([key]) => (
      key === `node_modules/${name}` || key.endsWith(suffix)
    ));
    assert.ok(
      matches.length === 1,
      `package-lock must record exactly one top-level ${name} entry`,
    );
    const [, entry] = matches[0];
    assert.equal(entry.version, version);
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
    assert.match(entry.integrity, /^sha512-/);
  }
}

function verifyInstalledMigration(consumerRoot) {
  const consumerRequire = createRequire(path.join(consumerRoot, 'registry-consumer.cjs'));
  const legacyManifest = verifyExactPackage(consumerRequire, LEGACY_NAME, LEGACY_VERSION);
  const currentManifest = verifyExactPackage(consumerRequire, CURRENT_NAME, CURRENT_VERSION);

  assert.equal(legacyManifest.dependencies['@aikdna/kdna-core'], '^0.3.0');
  assert.equal(legacyManifest.peerDependencies['@aikdna/kdna-cli'], '>=0.16.0');
  assert.equal(currentManifest.dependencies['@aikdna/kdna-core'], '0.20.0');

  verifyLockfile(consumerRoot);
  verifyLegacyMainFailure(consumerRequire);
  verifyCurrentMain(consumerRequire);
}

function main() {
  const consumerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-studio-registry-migration-'));
  try {
    installRegistryPackages(consumerRoot);
    verifyInstalledMigration(consumerRoot);
    console.log(`Verified registry migration boundary: ${LEGACY_NAME}@${LEGACY_VERSION} -> ${CURRENT_NAME}@${CURRENT_VERSION}`);
  } finally {
    fs.rmSync(consumerRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Registry migration verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  installRegistryPackages,
  verifyInstalledMigration,
};
