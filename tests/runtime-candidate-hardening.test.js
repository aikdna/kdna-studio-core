'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const {
  BINDING_PATH,
  resolveTrustedNpmInvocation,
  strictRegistryLookup,
  verifyCandidateBinding,
  verifyInstalledAikdnaGraph,
} = require('../scripts/runtime-candidate-binding');
const {
  CANDIDATE_AUTHORITIES,
  CANDIDATE_WORKFLOW_PATH,
} = require('../scripts/runtime-candidate-authority');

const ROOT = path.resolve(__dirname, '..');
const CORE = '@aikdna/kdna-core';

function copyAuthorityRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-core-candidate-hardening-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = [
    'package.json',
    'package-lock.json',
    BINDING_PATH,
    CANDIDATE_WORKFLOW_PATH,
    ...CANDIDATE_AUTHORITIES.map((authority) => authority.evidencePath),
  ];
  const binding = JSON.parse(fs.readFileSync(path.join(ROOT, BINDING_PATH), 'utf8'));
  files.push(...binding.packages.map((entry) => entry.artifact));
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
  }
  return root;
}

function mutateJson(root, relativePath, mutation) {
  const target = path.join(root, relativePath);
  const value = JSON.parse(fs.readFileSync(target, 'utf8'));
  mutation(value);
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function writeInstalledPackage(root, installPath, name, version) {
  const directory = path.join(root, 'node_modules', ...installPath.split('/'));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    `${JSON.stringify({ name, version }, null, 2)}\n`,
  );
  return directory;
}

function createTrustedNpmFixture(t, manifest = { name: 'npm', version: '11.17.0' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-core-trusted-npm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const npmRoot = path.join(root, 'npm');
  const npmExecPath = path.join(npmRoot, 'bin', 'npm-cli.js');
  fs.mkdirSync(path.dirname(npmExecPath), { recursive: true });
  fs.writeFileSync(npmExecPath, '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(npmRoot, 'package.json'), `${JSON.stringify(manifest)}\n`);
  return fs.realpathSync(npmExecPath);
}

test('static graph rejects the reproduced npm alias even when locked.name is omitted', (t) => {
  const root = copyAuthorityRoot(t);
  mutateJson(root, 'package.json', (pkg) => {
    pkg.dependencies['shadow-core'] = 'npm:@aikdna/kdna-core@0.18.0';
  });
  mutateJson(root, 'package-lock.json', (lock) => {
    lock.packages[''].dependencies['shadow-core'] = 'npm:@aikdna/kdna-core@0.18.0';
    lock.packages['node_modules/shadow-core'] = {
      version: '0.18.0',
      resolved: 'https://registry.npmjs.org/@aikdna/kdna-core/-/kdna-core-0.18.0.tgz',
      integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
    };
  });
  assert.throws(() => verifyCandidateBinding(root), /alias or encoded dependency spec/);
});

test('static graph rejects hidden identities in lock names, resolutions, and dependency maps', (t) => {
  const cases = [
    (lock) => {
      lock.packages['node_modules/shadow-core'] = {
        name: CORE,
        version: '0.18.0',
        resolved: 'https://registry.npmjs.org/@aikdna/kdna-core/-/kdna-core-0.18.0.tgz',
        integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
      };
    },
    (lock) => {
      lock.packages['node_modules/foreign'] = {
        version: '1.0.0',
        dependencies: { 'shadow-core': 'npm:%2540aikdna%252fkdna-core@0.18.0' },
      };
    },
    (lock) => {
      lock.packages['node_modules/shadow-core'] = {
        version: '0.18.0',
        resolved: 'https://registry.npmjs.org/%40aikdna%2fkdna-core/-/kdna-core-0.18.0.tgz',
        integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
      };
    },
  ];
  for (const mutation of cases) {
    const root = copyAuthorityRoot(t);
    mutateJson(root, 'package-lock.json', mutation);
    assert.throws(() => verifyCandidateBinding(root), /AIKDNA|alias|resolution/);
  }
});

test('candidate commits are bound to canonical CI pins and evidence', (t) => {
  const root = copyAuthorityRoot(t);
  mutateJson(root, BINDING_PATH, (binding) => {
    binding.packages[0].commit = 'b'.repeat(40);
  });
  assert.throws(() => verifyCandidateBinding(root), /does not match the CI pin/);

  const evidenceRoot = copyAuthorityRoot(t);
  mutateJson(evidenceRoot, CANDIDATE_AUTHORITIES[0].evidencePath, (evidence) => {
    evidence.git_head = 'b'.repeat(40);
  });
  assert.throws(() => verifyCandidateBinding(evidenceRoot), /source evidence mismatch/);
});

test('every candidate authority rejects symlinks and hard links', async (t) => {
  const files = [
    ['package.json', 'package manifest'],
    ['package-lock.json', 'package lock'],
    [BINDING_PATH, 'candidate binding'],
    [CANDIDATE_WORKFLOW_PATH, 'candidate source workflow'],
    [CANDIDATE_AUTHORITIES[0].evidencePath, 'candidate source evidence'],
    [JSON.parse(fs.readFileSync(path.join(ROOT, BINDING_PATH), 'utf8')).packages[0].artifact, 'candidate artifact'],
  ];
  for (const [relativePath, label] of files) {
    await t.test(`${label} symlink`, (t) => {
      const root = copyAuthorityRoot(t);
      const file = path.join(root, relativePath);
      const sibling = path.join(root, `outside-${path.basename(file)}`);
      fs.renameSync(file, sibling);
      fs.symlinkSync(sibling, file);
      assert.throws(() => verifyCandidateBinding(root), /regular non-symlink|escapes/);
    });
    await t.test(`${label} hard link`, (t) => {
      const root = copyAuthorityRoot(t);
      const file = path.join(root, relativePath);
      fs.linkSync(file, path.join(root, `hardlink-${path.basename(file)}`));
      assert.throws(() => verifyCandidateBinding(root), /exactly one hard link/);
    });
  }
});

test('installed graph rejects aliases, descendants, vendored identities, symlinks, and hard links', async (t) => {
  const canonical = (root) => writeInstalledPackage(root, CORE, CORE, '0.19.0');
  await t.test('canonical graph', (t) => {
    const root = copyAuthorityRoot(t);
    canonical(root);
    assert.deepEqual(verifyInstalledAikdnaGraph(root), { [CORE]: '0.19.0' });
  });
  for (const [name, mutation, pattern] of [
    ['alias', (root) => writeInstalledPackage(root, 'shadow-core', CORE, '0.18.0'), /canonical top-level/],
    ['descendant', (root) => writeInstalledPackage(root, 'foreign/dist/node_modules/shadow-core', CORE, '0.19.0'), /canonical top-level/],
    ['vendored', (root) => writeInstalledPackage(root, 'foreign/vendor/deep/shadow-core', CORE, '0.19.0'), /canonical top-level/],
    ['bin descendant', (root) => writeInstalledPackage(root, '.bin/node_modules/shadow-core', CORE, '0.19.0'), /\.bin must not contain directories/],
  ]) {
    await t.test(name, (t) => {
      const root = copyAuthorityRoot(t);
      canonical(root);
      mutation(root);
      assert.throws(() => verifyInstalledAikdnaGraph(root), pattern);
    });
  }
  await t.test('package symlink', (t) => {
    const root = copyAuthorityRoot(t);
    canonical(root);
    fs.symlinkSync(path.join(root, 'node_modules', CORE), path.join(root, 'node_modules/shadow-core'));
    assert.throws(() => verifyInstalledAikdnaGraph(root), /package graph contains a symlink/);
  });
  await t.test('manifest hard link', (t) => {
    const root = copyAuthorityRoot(t);
    const core = canonical(root);
    fs.linkSync(path.join(core, 'package.json'), path.join(root, 'installed-core-hardlink.json'));
    assert.throws(() => verifyInstalledAikdnaGraph(root), /exactly one hard link/);
  });
});

test('registry lookup uses only the pinned absolute npm client and both canonical registries', (t) => {
  const npmExecPath = createTrustedNpmFixture(t);
  let invocation;
  const integrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
  const metadata = strictRegistryLookup(CORE, '0.19.0', {
    root: ROOT,
    npmExecPath,
    nodeExecPath: process.execPath,
    runner: (command, args, options) => {
      invocation = { command, args, options };
      return {
        status: 0,
        signal: null,
        stdout: JSON.stringify({ name: CORE, version: '0.19.0', 'dist.integrity': integrity }),
        stderr: '',
      };
    },
  });
  assert.equal(metadata.name, CORE);
  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.args[0], npmExecPath);
  assert.ok(invocation.args.includes('--registry=https://registry.npmjs.org/'));
  assert.ok(invocation.args.includes('--@aikdna:registry=https://registry.npmjs.org/'));
  assert.equal(invocation.options.shell, false);
  assert.throws(() => resolveTrustedNpmInvocation(ROOT, 'npm', process.execPath), /must be absolute/);
  const wrongVersion = createTrustedNpmFixture(t, { name: 'npm', version: '11.16.0' });
  assert.throws(
    () => resolveTrustedNpmInvocation(ROOT, wrongVersion, process.execPath),
    /must be npm 11\.17\.0/,
  );
});

test('published package contains no candidate tar, binding, or evidence files', (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-core-public-pack-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const invocation = resolveTrustedNpmInvocation(ROOT);
  const result = spawnSync(
    invocation.command,
    [
      ...invocation.prefixArgs,
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      output,
      '--registry=https://registry.npmjs.org/',
      '--@aikdna:registry=https://registry.npmjs.org/',
    ],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, shell: false },
  );
  assert.equal(result.status, 0, result.stderr);
  const [report] = JSON.parse(result.stdout);
  assert.deepEqual(
    report.files.filter((file) => /runtime-candidates|\.tgz$|evidence\.json$/.test(file.path)),
    [],
  );
});
