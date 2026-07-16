#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  resolveTrustedNpmInvocation,
  verifyCandidateBinding,
} = require('./runtime-candidate-binding');
const {
  CANDIDATE_AUTHORITIES,
  readPinnedCandidateCommits,
} = require('./runtime-candidate-authority');

const root = path.resolve(__dirname, '..');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: options.encoding === null ? null : 'utf8',
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
    shell: false,
  });
  assert.equal(result.error, undefined, `${options.label || 'command'} failed to start`);
  assert.equal(result.signal, null, `${options.label || 'command'} was interrupted`);
  assert.equal(result.status, 0, `${options.label || 'command'} failed`);
  if (!options.allowStderr) {
    assert.equal(
      options.encoding === null ? result.stderr.length : result.stderr,
      options.encoding === null ? 0 : '',
      `${options.label || 'command'} wrote unexpected stderr`,
    );
  }
  return result.stdout;
}

function git(repository, args, options = {}) {
  const output = run('git', args, {
    cwd: repository,
    encoding: options.encoding,
    maxBuffer: options.maxBuffer,
    label: 'candidate source git inspection',
  });
  return Buffer.isBuffer(output) ? output : output.trim();
}

function assertCleanPinnedRepository(repository, expectedCommit, packageSubdirectory) {
  const stat = fs.lstatSync(repository);
  assert.ok(
    stat.isDirectory() && !stat.isSymbolicLink(),
    'candidate source repository must be a regular non-symlink directory',
  );
  assert.equal(
    fs.realpathSync(repository),
    repository,
    'candidate source repository path must be canonical',
  );
  assert.equal(
    git(repository, ['rev-parse', 'HEAD']),
    expectedCommit,
    'candidate source HEAD does not match the CI pin',
  );
  assert.equal(
    git(repository, ['rev-parse', `${expectedCommit}^{commit}`]),
    expectedCommit,
    'candidate source pin is not an exact commit',
  );
  assert.equal(
    git(repository, ['status', '--porcelain', '--untracked-files=all']),
    '',
    'candidate source worktree is not clean',
  );
  const indexRecords = git(repository, ['ls-files', '-v', '-z'], { encoding: null })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const hidden = indexRecords.filter((record) => /^[a-zS] /.test(record));
  assert.deepEqual(
    hidden,
    [],
    'candidate source index contains assume-unchanged or skip-worktree flags',
  );
  const source = path.resolve(repository, packageSubdirectory);
  const relative = path.relative(repository, source);
  assert.ok(
    relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    'candidate package path escapes its repository',
  );
  const sourceStat = fs.lstatSync(source);
  assert.ok(
    sourceStat.isDirectory() && !sourceStat.isSymbolicLink(),
    'candidate package path must be a regular non-symlink directory',
  );
  assert.equal(fs.realpathSync(source), source, 'candidate package path is not canonical');
  git(repository, ['cat-file', '-e', `${expectedCommit}:${packageSubdirectory}/package.json`]);
  return Object.freeze({ repository, source });
}

function tarString(block, offset, length) {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString('utf8');
}

function tarOctal(block, offset, length, label) {
  const raw = tarString(block, offset, length).trim();
  assert.match(raw, /^[0-7]+$/, `candidate commit archive ${label} is invalid`);
  const value = Number.parseInt(raw, 8);
  assert.ok(Number.isSafeInteger(value) && value >= 0, `candidate commit archive ${label} is invalid`);
  return value;
}

function extractCommitPackage(repository, expectedCommit, packageSubdirectory, destination) {
  const archive = git(
    repository,
    ['archive', '--format=tar', expectedCommit, '--', packageSubdirectory],
    { encoding: null, maxBuffer: 128 * 1024 * 1024 },
  );
  const normalizedPrefix = packageSubdirectory.split(path.sep).join('/');
  const seen = new Set();
  let offset = 0;
  let terminated = false;
  let regularFiles = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      assert.ok(
        archive.subarray(offset).every((byte) => byte === 0),
        'candidate commit archive has bytes after its end marker',
      );
      terminated = true;
      break;
    }
    const storedChecksum = tarOctal(header, 148, 8, 'header checksum');
    let actualChecksum = 0;
    for (let index = 0; index < header.length; index += 1) {
      actualChecksum += index >= 148 && index < 156 ? 32 : header[index];
    }
    assert.equal(storedChecksum, actualChecksum, 'candidate commit archive checksum mismatch');
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const entryPath = prefix ? `${prefix}/${name}` : name;
    const size = tarOctal(header, 124, 12, 'entry size');
    const type = header[156];
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    assert.ok(bodyEnd <= archive.length, `candidate commit archive entry is truncated: ${entryPath}`);
    if (type === 103) {
      assert.equal(offset, 0, 'candidate commit archive global header must be first');
      assert.equal(entryPath, 'pax_global_header', 'candidate commit archive global header is invalid');
      assert.equal(
        archive.subarray(bodyStart, bodyEnd).toString('utf8'),
        `52 comment=${expectedCommit}\n`,
        'candidate commit archive is not bound to the expected commit',
      );
      seen.add(entryPath);
      offset = bodyStart + Math.ceil(size / 512) * 512;
      continue;
    }
    const canonicalEntry = type === 53 && entryPath.endsWith('/')
      ? entryPath.slice(0, -1)
      : entryPath;
    const isAncestorDirectory =
      type === 53 && normalizedPrefix.startsWith(`${canonicalEntry}/`);
    assert.ok(
      isAncestorDirectory ||
        canonicalEntry === normalizedPrefix ||
        canonicalEntry.startsWith(`${normalizedPrefix}/`),
      `candidate commit archive escaped the package tree: ${entryPath}`,
    );
    assert.ok(
      /^[\x21-\x7e]+$/.test(canonicalEntry) &&
        !canonicalEntry.includes('\\') &&
        !path.posix.isAbsolute(canonicalEntry) &&
        path.posix.normalize(canonicalEntry) === canonicalEntry &&
        !canonicalEntry.split('/').some((segment) => ['', '.', '..'].includes(segment)) &&
        !seen.has(canonicalEntry),
      `candidate commit archive path is invalid: ${entryPath}`,
    );
    const mode = tarOctal(header, 100, 8, 'entry mode') & 0o777;
    assert.ok(
      type === 0 || type === 48 || type === 53,
      `candidate commit archive type is unsupported: ${entryPath}`,
    );
    const stripped = isAncestorDirectory || canonicalEntry === normalizedPrefix
      ? ''
      : canonicalEntry.slice(normalizedPrefix.length + 1);
    if (stripped) {
      const output = path.join(destination, ...stripped.split('/'));
      const relative = path.relative(destination, output);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      if (type === 53) {
        fs.mkdirSync(output, { recursive: true, mode: mode || 0o700 });
      } else {
        fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
        fs.writeFileSync(output, archive.subarray(bodyStart, bodyEnd), {
          flag: 'wx',
          mode: mode || 0o600,
        });
        regularFiles += 1;
      }
    }
    seen.add(canonicalEntry);
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  assert.ok(terminated, 'candidate commit archive end marker is missing');
  assert.ok(seen.has('pax_global_header'), 'candidate commit archive commit header is missing');
  assert.ok(regularFiles > 0, 'candidate commit package contains no files');
  return destination;
}

function packOnce(invocation, source, destination) {
  const stdout = run(
    invocation.command,
    [
      ...invocation.prefixArgs,
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      destination,
      '--registry=https://registry.npmjs.org/',
      '--@aikdna:registry=https://registry.npmjs.org/',
    ],
    { cwd: source, label: 'candidate source pack' },
  );
  const reports = JSON.parse(stdout);
  assert.equal(reports.length, 1, 'candidate source pack must emit one artifact');
  const report = reports[0];
  assert.equal(typeof report.filename, 'string', 'candidate source pack filename is missing');
  return fs.readFileSync(path.join(destination, report.filename));
}

function verifyCandidateSources(options = {}) {
  const repositoryRoot = options.root || root;
  const environment = options.environment || process.env;
  const binding = verifyCandidateBinding(repositoryRoot);
  const byName = new Map(binding.packages.map((entry) => [entry.name, entry]));
  const pinned = readPinnedCandidateCommits(repositoryRoot);
  const invocation = resolveTrustedNpmInvocation(repositoryRoot, {
    tarballPath: options.tarballPath,
  });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-candidate-source-pack-'));
  try {
    for (const authority of CANDIDATE_AUTHORITIES) {
      const sourceRoot = environment[authority.sourceEnvironment];
      assert.ok(sourceRoot, `${authority.sourceEnvironment} is required`);
      const repository = path.resolve(sourceRoot);
      const expectedCommit = pinned.get(authority.name);
      assertCleanPinnedRepository(repository, expectedCommit, authority.sourcePackageSubdirectory);

      const isolatedSource = path.join(temporary, `${authority.name.split('/').at(-1)}-source`);
      fs.mkdirSync(isolatedSource, { mode: 0o700 });
      extractCommitPackage(
        repository,
        expectedCommit,
        authority.sourcePackageSubdirectory,
        isolatedSource,
      );
      const packageManifest = JSON.parse(fs.readFileSync(path.join(isolatedSource, 'package.json'), 'utf8'));
      assert.equal(packageManifest.name, authority.name, `candidate source package mismatch: ${authority.name}`);
      assert.equal(packageManifest.version, authority.version, `candidate source version mismatch: ${authority.name}`);
      assert.equal(byName.get(authority.name)?.commit, expectedCommit);

      const first = path.join(temporary, `${authority.name.split('/').at(-1)}-first`);
      const second = path.join(temporary, `${authority.name.split('/').at(-1)}-second`);
      fs.mkdirSync(first);
      fs.mkdirSync(second);
      const firstBytes = packOnce(invocation, isolatedSource, first);
      const secondBytes = packOnce(invocation, isolatedSource, second);
      assert.deepEqual(firstBytes, secondBytes, `candidate source pack is not reproducible: ${authority.name}`);
      assert.deepEqual(
        firstBytes,
        fs.readFileSync(path.join(repositoryRoot, byName.get(authority.name).artifact)),
        `candidate artifact differs from the CI-pinned commit tree: ${authority.name}`,
      );
      assertCleanPinnedRepository(repository, expectedCommit, authority.sourcePackageSubdirectory);
    }
    return binding;
  } finally {
    invocation.cleanup();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) verifyCandidateSources();

module.exports = {
  assertCleanPinnedRepository,
  extractCommitPackage,
  packOnce,
  verifyCandidateSources,
};
