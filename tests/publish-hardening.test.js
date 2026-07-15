'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { validateCurrentBinding } = require('../scripts/current-release-binding');
const { validateArtifact, validatePackReport } = require('../scripts/release-evidence');
const { validateReleaseContext } = require('../scripts/release-policy');
const { evaluateRegistryResult, expectedE404 } = require('../scripts/registry-policy');
const {
  lookupArguments,
  publishArguments,
  releaseDecision,
} = require('../scripts/publish-verified-artifact');

const ROOT = path.resolve(__dirname, '..');
const HASH = 'a'.repeat(40);

function releaseInput(overrides = {}) {
  const version = overrides.pkg?.version || '1.9.1';
  return {
    pkg: { name: '@aikdna/kdna-studio-core', version, ...overrides.pkg },
    changelog: overrides.changelog ?? `# Changelog\n\n## ${version} (2026-07-15)\n`,
    env: {
      GITHUB_EVENT_NAME: 'release',
      RELEASE_EVENT_ACTION: 'published',
      RELEASE_TAG_NAME: `v${version}`,
      RELEASE_IS_DRAFT: 'false',
      RELEASE_IS_PRERELEASE: 'false',
      GITHUB_REF: `refs/tags/v${version}`,
      GITHUB_SHA: HASH,
      ...overrides.env,
    },
    git: { status: '', head: HASH, tagCommit: HASH, ...overrides.git },
  };
}

function candidateEvidence(bytes = Buffer.from('studio-core-release-artifact')) {
  return {
    schema: 'kdna.studio-core.release-evidence',
    version: '1.0',
    source: { ref: 'refs/tags/v1.9.1', commit: HASH },
    package: { name: '@aikdna/kdna-studio-core', version: '1.9.1' },
    artifact: {
      filename: 'aikdna-kdna-studio-core-1.9.1.tgz',
      integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`,
      shasum: crypto.createHash('sha1').update(bytes).digest('hex'),
      packed_size: bytes.length,
      unpacked_size: 10,
      file_count: 1,
      files: [{ path: 'package.json', size: 10 }],
    },
  };
}

test('publish workflow is release-only, serialized, pinned, and publishes one verified tarball', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/publish.yml'), 'utf8');
  assert.doesNotMatch(workflow, /workflow_dispatch/);
  assert.match(workflow, /release:\n\s+types: \[published\]/);
  assert.match(workflow, /github\.workflow.*github\.event\.release\.tag_name/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /actions\/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7/);
  assert.match(workflow, /actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6/);
  assert.match(workflow, /npm@11\.17\.0/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(workflow, /generate-release-evidence\.js/);
  assert.match(workflow, /publish-verified-artifact\.js/);
  assert.match(workflow, /kdna-studio-core-release\.tgz/g);
  assert.match(workflow, /if: always\(\)/);
});

test('release context binds package, changelog, event, tag ref, HEAD, and workflow SHA', () => {
  assert.deepEqual(validateReleaseContext(releaseInput()), {
    name: '@aikdna/kdna-studio-core',
    version: '1.9.1',
    tag: 'v1.9.1',
    ref: 'refs/tags/v1.9.1',
    commit: HASH,
  });
  for (const input of [
    releaseInput({ env: { GITHUB_EVENT_NAME: 'workflow_dispatch' } }),
    releaseInput({ env: { RELEASE_TAG_NAME: 'v1.9.0' } }),
    releaseInput({ env: { GITHUB_REF: 'refs/heads/main' } }),
    releaseInput({ env: { GITHUB_SHA: 'b'.repeat(40) } }),
    releaseInput({ git: { status: ' M package.json' } }),
    releaseInput({ git: { tagCommit: 'b'.repeat(40) } }),
    releaseInput({ changelog: '# Changelog\n\n## 1.9.0\n' }),
  ]) {
    assert.throws(() => validateReleaseContext(input));
  }
});

test('current binding rejects stale evidence before registry lookup', () => {
  const bytes = Buffer.from('studio-core-release-artifact');
  const evidence = candidateEvidence(bytes);
  assert.equal(validateCurrentBinding({ evidence, ...releaseInput() }), evidence);
  let calls = 0;
  assert.throws(() =>
    releaseDecision({
      evidence,
      tarball: bytes,
      bindCurrent: () => {
        throw new Error('stale release');
      },
      lookup: () => {
        calls += 1;
      },
    }),
  );
  assert.equal(calls, 0);
});

test('pack evidence recomputes artifact identity and rejects changed bytes', () => {
  const bytes = Buffer.from('studio-core-release-artifact');
  const report = [{
    name: '@aikdna/kdna-studio-core',
    version: '1.9.1',
    filename: 'aikdna-kdna-studio-core-1.9.1.tgz',
    integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`,
    shasum: crypto.createHash('sha1').update(bytes).digest('hex'),
    size: bytes.length,
    unpackedSize: 10,
    entryCount: 1,
    files: [{ path: 'package.json', size: 10 }],
  }];
  const evidence = validatePackReport({
    reportText: JSON.stringify(report),
    tarball: bytes,
    pkg: { name: '@aikdna/kdna-studio-core', version: '1.9.1' },
    source: { ref: 'refs/tags/v1.9.1', commit: HASH },
  });
  assert.equal(validateArtifact(evidence, bytes), evidence);
  assert.throws(() => validateArtifact(evidence, Buffer.from('changed')), /size|integrity|shasum/);
  assert.throws(
    () => validateArtifact({ ...evidence, artifact: { ...evidence.artifact, unpacked_size: 11 } }, bytes),
    /unpacked size mismatch/,
  );
  assert.throws(
    () => validateArtifact({ ...evidence, artifact: { ...evidence.artifact, filename: '../release.tgz' } }, bytes),
    /filename mismatch/,
  );
});

test('registry policy publishes only on the exact npm 11 E404 and skips only identical bytes', () => {
  const bytes = Buffer.from('studio-core-release-artifact');
  const evidence = candidateEvidence(bytes);
  const absent = { status: 1, stdout: JSON.stringify({ error: expectedE404(evidence) }), stderr: '' };
  assert.deepEqual(evaluateRegistryResult(absent, evidence), {
    decision: 'publish',
    shouldPublish: true,
  });
  const present = {
    status: 0,
    stdout: JSON.stringify({
      name: evidence.package.name,
      version: evidence.package.version,
      'dist.integrity': evidence.artifact.integrity,
      'dist.shasum': evidence.artifact.shasum,
    }),
    stderr: '',
  };
  assert.deepEqual(evaluateRegistryResult(present, evidence), {
    decision: 'skip-identical',
    shouldPublish: false,
  });
  for (const result of [
    { ...absent, stderr: 'npm error code E401\n' },
    { status: 2, stdout: '', stderr: 'outage' },
    { status: null, stdout: '', stderr: '', error: new Error('ETIMEDOUT') },
    { ...present, stdout: `${present.stdout}\ntrailing` },
    { ...present, stdout: present.stdout.replace(evidence.artifact.shasum, 'b'.repeat(40)) },
  ]) {
    assert.throws(() => evaluateRegistryResult(result, evidence));
  }
});

test('registry lookup and publication use the official registry and the exact tarball', () => {
  assert.deepEqual(lookupArguments('@aikdna/kdna-studio-core@1.9.1'), [
    'view',
    '@aikdna/kdna-studio-core@1.9.1',
    'name',
    'version',
    'dist.integrity',
    'dist.shasum',
    '--json',
    '--loglevel=silent',
    '--registry=https://registry.npmjs.org/',
  ]);
  assert.deepEqual(publishArguments('/tmp/exact.tgz'), [
    'publish',
    '/tmp/exact.tgz',
    '--ignore-scripts',
    '--provenance',
    '--access',
    'public',
    '--registry=https://registry.npmjs.org/',
  ]);
});
