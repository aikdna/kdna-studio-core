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

function run(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  assert.equal(result.error, undefined, 'candidate source pack failed to start');
  assert.equal(result.signal, null, 'candidate source pack was interrupted');
  assert.equal(result.status, 0, 'candidate source pack failed');
  assert.equal(result.stderr, '', 'candidate source pack wrote unexpected stderr');
  return result.stdout;
}

function git(repository, args) {
  const result = spawnSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    shell: false,
  });
  assert.equal(result.error, undefined, 'candidate source git inspection failed to start');
  assert.equal(result.signal, null, 'candidate source git inspection was interrupted');
  assert.equal(result.status, 0, 'candidate source git inspection failed');
  assert.equal(result.stderr, '', 'candidate source git inspection wrote unexpected stderr');
  return result.stdout.trim();
}

function assertCleanPinnedRepository(repository, expectedCommit, packageSubdirectory) {
  const stat = fs.lstatSync(repository);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'candidate source repository must be a regular non-symlink directory');
  assert.equal(fs.realpathSync(repository), repository, 'candidate source repository path must be canonical');
  assert.equal(git(repository, ['rev-parse', 'HEAD']), expectedCommit, 'candidate source HEAD does not match the CI pin');
  assert.equal(
    git(repository, ['status', '--porcelain', '--untracked-files=all']),
    '',
    'candidate source worktree is not clean',
  );
  const source = path.resolve(repository, packageSubdirectory);
  const relative = path.relative(repository, source);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'candidate package path escapes its repository');
  assert.equal(fs.realpathSync(source), source, 'candidate package path is not canonical');
  return source;
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
    { cwd: source },
  );
  const reports = JSON.parse(stdout);
  assert.equal(reports.length, 1, 'candidate source pack must emit one artifact');
  const report = reports[0];
  assert.equal(typeof report.filename, 'string', 'candidate source pack filename is missing');
  return fs.readFileSync(path.join(destination, report.filename));
}

function main() {
  const binding = verifyCandidateBinding(root);
  const byName = new Map(binding.packages.map((entry) => [entry.name, entry]));
  const pinned = readPinnedCandidateCommits(root);
  const invocation = resolveTrustedNpmInvocation(root);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-candidate-source-pack-'));
  try {
    for (const authority of CANDIDATE_AUTHORITIES) {
      const sourceRoot = process.env[authority.sourceEnvironment];
      assert.ok(sourceRoot, `${authority.sourceEnvironment} is required`);
      const repository = path.resolve(sourceRoot);
      const expectedCommit = pinned.get(authority.name);
      const source = assertCleanPinnedRepository(
        repository,
        expectedCommit,
        authority.sourcePackageSubdirectory,
      );
      const packageManifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
      assert.equal(packageManifest.name, authority.name, `candidate source package mismatch: ${authority.name}`);
      assert.equal(packageManifest.version, authority.version, `candidate source version mismatch: ${authority.name}`);
      assert.equal(byName.get(authority.name)?.commit, pinned.get(authority.name));

      const first = path.join(temporary, `${authority.name.split('/').at(-1)}-first`);
      const second = path.join(temporary, `${authority.name.split('/').at(-1)}-second`);
      fs.mkdirSync(first);
      fs.mkdirSync(second);
      const firstBytes = packOnce(invocation, source, first);
      const secondBytes = packOnce(invocation, source, second);
      assert.deepEqual(firstBytes, secondBytes, `candidate source pack is not reproducible: ${authority.name}`);
      assert.deepEqual(
        firstBytes,
        fs.readFileSync(path.join(root, byName.get(authority.name).artifact)),
        `candidate artifact differs from the CI-pinned source: ${authority.name}`,
      );
      assertCleanPinnedRepository(
        repository,
        expectedCommit,
        authority.sourcePackageSubdirectory,
      );
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main();
