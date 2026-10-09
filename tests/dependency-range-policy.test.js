'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  checkRepository,
  coordinateFindings,
} = require('../scripts/dependency-coordinate-policy');

// The retired suite tests/legacy/runtime-candidate-hardening.test.js carried
// the assertion "direct dependency must use exact SemVer". Retiring that file
// removed the only active check of the published dependency shape. This test
// restores the coverage and extends it to the file: coordinate policy the
// repository actually follows: an exact SemVer and an integrity-locked file:
// pin are both acceptable, every floating range is still rejected.

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
// The shipped graph now installs its candidates from the exact registry
// coordinates, so the file: pin rules are exercised with a probe coordinate
// that points at a committed vendored archive instead of the candidate graph.
const coordinate = 'file:vendor/noble-hashes-1.8.0.tgz';
const integrity = lock.packages['node_modules/@noble/hashes'].integrity;

function findingsFor(spec, mutateLock) {
  const next = structuredClone(manifest);
  next.dependencies['policy-probe'] = spec;
  const nextLock = structuredClone(lock);
  nextLock.packages['node_modules/policy-probe'] = {
    version: '1.0.0',
    resolved: spec.startsWith('file:') ? spec : undefined,
    integrity,
  };
  if (mutateLock) mutateLock(nextLock);
  return coordinateFindings({ manifest: next, lock: nextLock, root });
}

test('every direct declaration is an exact SemVer or an integrity-locked file: pin', () => {
  const direct = [
    ...Object.entries(manifest.dependencies ?? {}),
    ...Object.entries(manifest.devDependencies ?? {}),
  ];
  assert.ok(direct.length > 0);
  for (const [name, spec] of direct) {
    assert.ok(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(spec) || spec.startsWith('file:'),
      `${name} must be an exact SemVer or a file: pin, got ${spec}`,
    );
  }
  assert.deepEqual(checkRepository(root), []);
});

test('floating ranges are rejected in every shape the retired assertion rejected', () => {
  for (const spec of ['^1.2.3', '~1.2.3', '*', 'latest', '1.2.x', '1.2.*', '>=1.0.0', '1.2.3 || 2.0.0', '1.2.3 - 2.0.0', '1', '1.2', 'next', '']) {
    const findings = findingsFor(spec);
    assert.ok(
      findings.some((finding) => finding.rule === 'floating_or_unpinned_range' && finding.spec === spec),
      `spec ${JSON.stringify(spec)} must be rejected, got ${JSON.stringify(findings)}`,
    );
  }
});

test('exact SemVer forms stay accepted', () => {
  for (const spec of ['1.2.3', '1.2.3-rc.probe.1', '1.2.3+build.1']) {
    assert.deepEqual(findingsFor(spec), [], `spec ${spec} should be accepted`);
  }
});

test('a file: pin is only accepted with a matching lock coordinate and a full sha512 integrity', () => {
  assert.deepEqual(findingsFor(coordinate), []);
  assert.deepEqual(
    findingsFor(coordinate, (nextLock) => { delete nextLock.packages['node_modules/policy-probe'].integrity; })
      .map((finding) => finding.rule),
    ['file_coordinate_without_sha512_integrity'],
  );
  assert.deepEqual(
    findingsFor(coordinate, (nextLock) => { nextLock.packages['node_modules/policy-probe'].integrity = 'sha512-AAA'; })
      .map((finding) => finding.rule),
    ['file_coordinate_without_sha512_integrity'],
  );
  assert.deepEqual(
    findingsFor(coordinate, (nextLock) => { nextLock.packages['node_modules/policy-probe'].resolved = 'file:vendor/elsewhere.tgz'; })
      .map((finding) => finding.rule),
    ['file_coordinate_lock_drift'],
  );
  assert.deepEqual(
    findingsFor('file:vendor/not-committed.tgz').map((finding) => finding.rule),
    ['file_coordinate_target_missing'],
  );
});

test('the standalone gate is red when a committed file: pin loses its integrity', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'core-range-policy-'));
  try {
    // The shipped graph installs its candidates from exact registry
    // coordinates now, so the sandbox carries the committed graph plus one
    // synthetic file: pin; losing that pin's integrity must still turn the
    // standalone gate red.
    const probeName = 'policy-probe';
    const probeManifest = structuredClone(manifest);
    probeManifest.dependencies[probeName] = coordinate;
    fs.writeFileSync(path.join(sandbox, 'package.json'), `${JSON.stringify(probeManifest, null, 2)}\n`);
    const probeLock = structuredClone(lock);
    probeLock.packages[`node_modules/${probeName}`] = { version: '1.0.0', resolved: coordinate, integrity };
    fs.writeFileSync(path.join(sandbox, 'package-lock.json'), `${JSON.stringify(probeLock, null, 2)}\n`);
    fs.mkdirSync(path.join(sandbox, 'vendor'), { recursive: true });
    for (const [, spec] of Object.entries(probeManifest.dependencies ?? {})) {
      if (!spec.startsWith('file:')) continue;
      fs.mkdirSync(path.dirname(path.join(sandbox, spec.slice('file:'.length))), { recursive: true });
      fs.copyFileSync(path.join(root, spec.slice('file:'.length)), path.join(sandbox, spec.slice('file:'.length)));
    }
    const script = path.join(root, 'scripts', 'dependency-coordinate-policy.js');
    const green = spawnSync(process.execPath, [script, '--root', sandbox], { encoding: 'utf8' });
    assert.equal(green.status, 0, green.stdout + green.stderr);

    const mutantLock = JSON.parse(fs.readFileSync(path.join(sandbox, 'package-lock.json'), 'utf8'));
    delete mutantLock.packages[`node_modules/${probeName}`].integrity;
    fs.writeFileSync(path.join(sandbox, 'package-lock.json'), `${JSON.stringify(mutantLock, null, 2)}\n`);
    const red = spawnSync(process.execPath, [script, '--root', sandbox], { encoding: 'utf8' });
    assert.equal(red.status, 1, red.stdout + red.stderr);
    assert.match(red.stdout, /file_coordinate_without_sha512_integrity/);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
