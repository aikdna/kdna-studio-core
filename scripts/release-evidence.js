'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { COMMIT_RE, EXPECTED_PACKAGE_NAME, STABLE_VERSION_RE } = require('./release-policy');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha1(bytes) {
  return crypto.createHash('sha1').update(bytes).digest('hex');
}

function integrity(bytes) {
  return `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`;
}

function validateFiles(files) {
  assert(Array.isArray(files) && files.length > 0, 'npm pack must report files');
  const normalized = files.map((file) => {
    assert(file && typeof file === 'object', 'npm pack file entry is invalid');
    assert(
      typeof file.path === 'string' &&
        file.path.length > 0 &&
        !path.isAbsolute(file.path) &&
        !file.path.split('/').some((part) => part === '' || part === '..'),
      'npm pack reported an unsafe path',
    );
    assert(Number.isSafeInteger(file.size) && file.size >= 0, 'npm pack file size is invalid');
    return { path: file.path, size: file.size };
  });
  normalized.sort((left, right) => left.path.localeCompare(right.path));
  assert(new Set(normalized.map((file) => file.path)).size === normalized.length, 'duplicate pack path');
  return normalized;
}

function validatePackReport({ reportText, tarball, pkg, source }) {
  assert(pkg.name === EXPECTED_PACKAGE_NAME, 'npm pack package name mismatch');
  assert(STABLE_VERSION_RE.test(pkg.version || ''), 'npm pack package version is invalid');
  assert(source.ref === `refs/tags/v${pkg.version}`, 'npm pack source ref mismatch');
  assert(COMMIT_RE.test(source.commit || ''), 'npm pack source commit is invalid');
  let reports;
  try {
    reports = JSON.parse(reportText);
  } catch {
    throw new Error('npm pack output must be one JSON document');
  }
  assert(Array.isArray(reports) && reports.length === 1, 'npm pack must report one artifact');
  const report = reports[0];
  assert(report.name === pkg.name && report.version === pkg.version, 'npm pack identity mismatch');
  const expectedFilename = `${pkg.name.slice(1).replace('/', '-')}-${pkg.version}.tgz`;
  assert(
    report.filename === expectedFilename && path.basename(report.filename) === report.filename,
    'npm pack filename mismatch',
  );
  assert(Buffer.isBuffer(tarball) && tarball.length > 0, 'npm pack tarball is empty');
  const files = validateFiles(report.files);
  const unpackedSize = files.reduce((total, file) => total + file.size, 0);
  const computedIntegrity = integrity(tarball);
  const computedShasum = sha1(tarball);
  assert(report.integrity === computedIntegrity, 'npm pack integrity mismatch');
  assert(report.shasum === computedShasum, 'npm pack shasum mismatch');
  assert(report.size === tarball.length, 'npm pack size mismatch');
  assert(report.entryCount === files.length, 'npm pack entry count mismatch');
  assert(report.unpackedSize === unpackedSize, 'npm pack unpacked size mismatch');
  return {
    schema: 'kdna.studio-core.release-evidence',
    version: '1.0',
    source: { ref: source.ref, commit: source.commit },
    package: { name: pkg.name, version: pkg.version },
    artifact: {
      filename: report.filename,
      integrity: computedIntegrity,
      shasum: computedShasum,
      packed_size: tarball.length,
      unpacked_size: unpackedSize,
      file_count: files.length,
      files,
    },
  };
}

function validateEvidence(evidence) {
  assert(evidence?.schema === 'kdna.studio-core.release-evidence', 'release evidence schema mismatch');
  assert(evidence.version === '1.0', 'release evidence version mismatch');
  assert(evidence.package?.name === EXPECTED_PACKAGE_NAME, 'release evidence package mismatch');
  assert(STABLE_VERSION_RE.test(evidence.package.version || ''), 'release evidence package version invalid');
  assert(evidence.source?.ref === `refs/tags/v${evidence.package.version}`, 'release evidence ref mismatch');
  assert(COMMIT_RE.test(evidence.source.commit || ''), 'release evidence commit invalid');
  assert(
    evidence.artifact?.filename ===
      `${evidence.package.name.slice(1).replace('/', '-')}-${evidence.package.version}.tgz` &&
      path.basename(evidence.artifact.filename) === evidence.artifact.filename,
    'release evidence filename mismatch',
  );
  assert(/^sha512-[A-Za-z0-9+/]{86}==$/.test(evidence.artifact?.integrity || ''), 'release evidence integrity invalid');
  assert(/^[0-9a-f]{40}$/.test(evidence.artifact?.shasum || ''), 'release evidence shasum invalid');
  assert(Number.isSafeInteger(evidence.artifact?.packed_size) && evidence.artifact.packed_size > 0, 'release evidence packed size invalid');
  assert(
    Number.isSafeInteger(evidence.artifact?.unpacked_size) && evidence.artifact.unpacked_size > 0,
    'release evidence unpacked size invalid',
  );
  assert(Number.isSafeInteger(evidence.artifact?.file_count) && evidence.artifact.file_count > 0, 'release evidence file count invalid');
  const files = validateFiles(evidence.artifact.files);
  assert(files.length === evidence.artifact.file_count, 'release evidence files mismatch');
  assert(
    files.reduce((total, file) => total + file.size, 0) === evidence.artifact.unpacked_size,
    'release evidence unpacked size mismatch',
  );
  return evidence;
}

function validateArtifact(rawEvidence, tarball) {
  const evidence = validateEvidence(rawEvidence);
  assert(Buffer.isBuffer(tarball) && tarball.length === evidence.artifact.packed_size, 'verified artifact size mismatch');
  assert(integrity(tarball) === evidence.artifact.integrity, 'verified artifact integrity mismatch');
  assert(sha1(tarball) === evidence.artifact.shasum, 'verified artifact shasum mismatch');
  return evidence;
}

module.exports = { validateArtifact, validateEvidence, validatePackReport };
