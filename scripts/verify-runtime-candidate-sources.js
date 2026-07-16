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
const {
  assertNoHiddenIndexFlags,
  assertNoReplacementRefs,
  authoritativeGit,
  materializeCommitTree,
} = require('./authoritative-git');

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
  return authoritativeGit(repository, args, {
    encoding: options.encoding,
    maxBuffer: options.maxBuffer,
  });
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
  assertNoReplacementRefs(repository);
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
  assertNoHiddenIndexFlags(repository);
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

function materializeCommitPackage(repository, expectedCommit, packageSubdirectory, destination) {
  return materializeCommitTree(
    repository,
    expectedCommit,
    packageSubdirectory,
    destination,
    { requiredPath: 'package.json' },
  );
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
      materializeCommitPackage(
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
  materializeCommitPackage,
  packOnce,
  verifyCandidateSources,
};
