'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { validateCurrentBinding } = require('../scripts/current-release-binding');
const { parseTarFiles, validateArtifact, validatePackReport } = require('../scripts/release-evidence');
const { validateReleaseContext } = require('../scripts/release-policy');
const { evaluateRegistryResult, expectedE404 } = require('../scripts/registry-policy');
const { resolveTrustedNpmInvocation } = require('../scripts/runtime-candidate-binding');
const {
  lookupArguments,
  publishArguments,
  publishCandidate,
  releaseDecision,
} = require('../scripts/publish-verified-artifact');

const ROOT = path.resolve(__dirname, '..');
const HASH = 'a'.repeat(40);

function writeTarString(header, offset, length, value) {
  const bytes = Buffer.from(value);
  assert.ok(bytes.length <= length, `tar field is too long: ${value}`);
  bytes.copy(header, offset);
}

function writeTarOctal(header, offset, length, value) {
  const octal = value.toString(8).padStart(length - 1, '0');
  assert.ok(octal.length < length, `tar numeric field is too large: ${value}`);
  header.write(octal, offset, length - 1, 'ascii');
  header[offset + length - 1] = 0;
}

function tarEntry({ name, content = Buffer.alloc(0), type = '0' }) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, name);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, data.length);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  writeTarString(header, 257, 6, 'ustar');
  writeTarString(header, 263, 2, '00');
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

function tarGzip(entries, { endBlocks = 2 } = {}) {
  return zlib.gzipSync(
    Buffer.concat([...entries.map((entry) => tarEntry(entry)), Buffer.alloc(512 * endBlocks)]),
  );
}

function paxRecord(key, value) {
  const body = `${key}=${value}\n`;
  let length = Buffer.byteLength(`0 ${body}`);
  while (true) {
    const record = `${length} ${body}`;
    const actual = Buffer.byteLength(record);
    if (actual === length) return Buffer.from(record);
    length = actual;
  }
}

function releaseTarball() {
  return tarGzip([{ name: 'package/package.json', content: '{"name":"studio-release"}\n' }]);
}

function releaseInput(overrides = {}) {
  const version = overrides.pkg?.version || '2.0.0';
  return {
    pkg: { name: '@aikdna/kdna-studio-core', version, ...overrides.pkg },
    changelog: overrides.changelog ?? `# Changelog\n\n## ${version} (2026-07-15)\n`,
    env: {
      GITHUB_EVENT_NAME: 'release',
      RELEASE_EVENT_ACTION: 'published',
      RELEASE_TAG_NAME: version,
      RELEASE_IS_DRAFT: 'false',
      RELEASE_IS_PRERELEASE: 'false',
      GITHUB_REF: `refs/tags/${version}`,
      GITHUB_SHA: HASH,
      ...overrides.env,
    },
    git: { status: '', head: HASH, tagCommit: HASH, ...overrides.git },
  };
}

function candidateEvidence(bytes = releaseTarball()) {
  const files = parseTarFiles(bytes);
  return {
    schema: 'kdna.studio-core.release-evidence',
    version: '1.0',
    source: { ref: 'refs/tags/2.0.0', commit: HASH },
    package: { name: '@aikdna/kdna-studio-core', version: '2.0.0' },
    artifact: {
      filename: 'aikdna-kdna-studio-core-2.0.0.tgz',
      integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`,
      shasum: crypto.createHash('sha1').update(bytes).digest('hex'),
      packed_size: bytes.length,
      unpacked_size: files.reduce((total, file) => total + file.size, 0),
      file_count: files.length,
      files,
    },
  };
}

function packReport(bytes, files = parseTarFiles(bytes)) {
  return [{
    name: '@aikdna/kdna-studio-core',
    version: '2.0.0',
    filename: 'aikdna-kdna-studio-core-2.0.0.tgz',
    integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`,
    shasum: crypto.createHash('sha1').update(bytes).digest('hex'),
    size: bytes.length,
    unpackedSize: files.reduce((total, file) => total + file.size, 0),
    entryCount: files.length,
    files,
  }];
}

function evidenceForUntrustedBytes(bytes) {
  const evidence = candidateEvidence();
  return {
    ...evidence,
    artifact: {
      ...evidence.artifact,
      integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`,
      shasum: crypto.createHash('sha1').update(bytes).digest('hex'),
      packed_size: bytes.length,
    },
  };
}

test('publish workflow is release-only, serialized, pinned, and publishes one verified tarball', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/publish.yml'), 'utf8');
  assert.doesNotMatch(workflow, /workflow_dispatch/);
  assert.match(workflow, /release:\n\s+types: \[published\]/);
  assert.match(workflow, /github\.workflow.*github\.event\.release\.tag_name/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /actions\/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0/);
  assert.match(workflow, /actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38/);
  assert.match(workflow, /npm@11\.17\.0/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(workflow, /npm run release:generate-evidence --/);
  assert.match(workflow, /npm run release:publish-verified --/);
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts['release:generate-evidence'], 'node scripts/generate-release-evidence.js');
  assert.equal(scripts['release:publish-verified'], 'node scripts/publish-verified-artifact.js');
  assert.match(workflow, /kdna-studio-core-release\.tgz/g);
  assert.match(workflow, /if: always\(\)/);
});

test('release context binds package, changelog, event, tag ref, HEAD, and workflow SHA', () => {
  assert.deepEqual(validateReleaseContext(releaseInput()), {
    name: '@aikdna/kdna-studio-core',
    version: '2.0.0',
    tag: '2.0.0',
    ref: 'refs/tags/2.0.0',
    commit: HASH,
  });
  for (const input of [
    releaseInput({ env: { GITHUB_EVENT_NAME: 'workflow_dispatch' } }),
    releaseInput({ env: { RELEASE_TAG_NAME: '1.9.0' } }),
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
  const bytes = releaseTarball();
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

test('pack evidence independently parses a real npm tgz and rejects changed bytes', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-release-pack-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const npmInvocation = resolveTrustedNpmInvocation(ROOT);
  const packed = spawnSync(
    npmInvocation.command,
    [
      ...npmInvocation.prefixArgs,
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      temp,
      '--registry=https://registry.npmjs.org/',
      '--@aikdna:registry=https://registry.npmjs.org/',
    ],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, shell: false },
  );
  assert.equal(packed.status, 0, packed.stderr);
  const [report] = JSON.parse(packed.stdout);
  const bytes = fs.readFileSync(path.join(temp, report.filename));
  const evidence = validatePackReport({
    reportText: packed.stdout,
    tarball: bytes,
    pkg: { name: '@aikdna/kdna-studio-core', version: '2.0.0' },
    source: { ref: 'refs/tags/2.0.0', commit: HASH },
  });
  assert.equal(validateArtifact(evidence, bytes), evidence);
  assert.throws(() => validateArtifact(evidence, Buffer.from('changed')), /size|integrity|shasum/);
  assert.throws(
    () =>
      validateArtifact(
        { ...evidence, artifact: { ...evidence.artifact, unpacked_size: evidence.artifact.unpacked_size + 1 } },
        bytes,
      ),
    /unpacked size mismatch/,
  );
  assert.throws(
    () => validateArtifact({ ...evidence, artifact: { ...evidence.artifact, filename: '../release.tgz' } }, bytes),
    /filename mismatch/,
  );
});

test('independent tar parser supports PAX paths and GNU long names', () => {
  const paxPath = `package/nested/${'p'.repeat(96)}.js`;
  const paxBytes = tarGzip([
    { name: 'PaxHeader', type: 'x', content: paxRecord('path', paxPath) },
    { name: 'package/placeholder', content: 'pax' },
  ]);
  assert.deepEqual(parseTarFiles(paxBytes), [{ path: paxPath.slice('package/'.length), size: 3 }]);

  const longPath = `package/nested/${'g'.repeat(96)}.js`;
  const longNameBytes = tarGzip([
    { name: '././@LongLink', type: 'L', content: `${longPath}\0` },
    { name: 'package/placeholder', content: 'gnu' },
  ]);
  assert.deepEqual(parseTarFiles(longNameBytes), [{ path: longPath.slice('package/'.length), size: 3 }]);
});

test('independent tar parser rejects non-gzip, truncation, checksum damage, bad endings, duplicates, and unsafe paths', () => {
  const valid = releaseTarball();
  const tar = zlib.gunzipSync(valid);
  const checksumDamage = Buffer.from(tar);
  checksumDamage[0] ^= 1;
  const cases = [
    ['non-gzip', Buffer.from('ordinary bytes'), /gzip/],
    ['truncated gzip', valid.subarray(0, valid.length - 8), /gzip/],
    ['truncated tar entry', zlib.gzipSync(tar.subarray(0, 520)), /truncated tar entry/],
    ['header checksum', zlib.gzipSync(checksumDamage), /checksum/],
    [
      'missing second end block',
      tarGzip([{ name: 'package/package.json', content: '{}' }], { endBlocks: 1 }),
      /end marker/,
    ],
    [
      'duplicate path',
      tarGzip([
        { name: 'package/package.json', content: '{}' },
        { name: 'package/package.json', content: '[]' },
      ]),
      /duplicate/,
    ],
    ['parent traversal', tarGzip([{ name: 'package/../escape.js', content: 'x' }]), /unsafe/],
    ['absolute-like path', tarGzip([{ name: 'package//escape.js', content: 'x' }]), /unsafe/],
    ['backslash path', tarGzip([{ name: 'package/..\\escape.js', content: 'x' }]), /unsafe/],
    ['symbolic link', tarGzip([{ name: 'package/link', type: '2', content: '' }]), /unsupported/],
  ];
  for (const [name, bytes, pattern] of cases) {
    assert.throws(() => parseTarFiles(bytes), pattern, name);
  }
});

test('pack JSON and retained evidence must exactly match the independently parsed tar manifest', () => {
  const bytes = releaseTarball();
  const report = packReport(bytes);
  report[0].files = [{ path: 'README.md', size: report[0].files[0].size }];
  assert.throws(
    () =>
      validatePackReport({
        reportText: JSON.stringify(report),
        tarball: bytes,
        pkg: { name: '@aikdna/kdna-studio-core', version: '2.0.0' },
        source: { ref: 'refs/tags/2.0.0', commit: HASH },
      }),
    /file report/,
  );

  const evidence = candidateEvidence(bytes);
  const drifted = {
    ...evidence,
    artifact: {
      ...evidence.artifact,
      files: [{ path: 'README.md', size: evidence.artifact.files[0].size }],
    },
  };
  assert.throws(() => validateArtifact(drifted, bytes), /artifact files/);
});

test('non-tar bytes cannot reach registry lookup or npm publication even with matching outer hashes', () => {
  const bytes = Buffer.from('ordinary strings are not npm tarballs');
  const evidence = evidenceForUntrustedBytes(bytes);
  let lookupCalls = 0;
  let publishCalls = 0;
  assert.throws(
    () =>
      releaseDecision({
        evidence,
        tarball: bytes,
        bindCurrent: () => evidence,
        lookup: () => {
          lookupCalls += 1;
        },
      }),
    /gzip/,
  );
  assert.throws(
    () =>
      publishCandidate({
        evidence,
        tarball: bytes,
        artifactPath: '/tmp/not-reached.tgz',
        bindCurrent: () => evidence,
        publish: () => {
          publishCalls += 1;
        },
      }),
    /gzip/,
  );
  assert.equal(lookupCalls, 0);
  assert.equal(publishCalls, 0);
});

test('registry policy publishes only on the exact npm 11 E404 and skips only identical bytes', () => {
  const bytes = releaseTarball();
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
  assert.deepEqual(lookupArguments('@aikdna/kdna-studio-core@2.0.0'), [
    'view',
    '@aikdna/kdna-studio-core@2.0.0',
    'name',
    'version',
    'dist.integrity',
    'dist.shasum',
    '--json',
    '--loglevel=silent',
    '--registry=https://registry.npmjs.org/',
    '--@aikdna:registry=https://registry.npmjs.org/',
  ]);
  assert.deepEqual(publishArguments('/tmp/exact.tgz'), [
    'publish',
    '/tmp/exact.tgz',
    '--ignore-scripts',
    '--provenance',
    '--access',
    'public',
    '--registry=https://registry.npmjs.org/',
    '--@aikdna:registry=https://registry.npmjs.org/',
  ]);
});
