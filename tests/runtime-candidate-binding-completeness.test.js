'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyCandidateBinding } = require('../scripts/runtime-candidate-binding');

const ROOT = path.resolve(__dirname, '..');

function copyFixtureRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-core-binding-completeness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'fixtures/runtime-candidates'), { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
  }
  for (const file of fs.readdirSync(path.join(ROOT, 'fixtures/runtime-candidates'))) {
    fs.copyFileSync(
      path.join(ROOT, 'fixtures/runtime-candidates', file),
      path.join(root, 'fixtures/runtime-candidates', file),
    );
  }
  return root;
}

function mutateJson(root, relativePath, mutation) {
  const target = path.join(root, relativePath);
  const value = JSON.parse(fs.readFileSync(target, 'utf8'));
  mutation(value);
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

test('candidate binding completeness rejects omissions, duplicates, extras, and hostile lock graphs', (t) => {
  const root = copyFixtureRoot(t);
  const bindingPath = path.join(root, 'fixtures/runtime-candidates/binding.json');
  const packagePath = path.join(root, 'package.json');
  const lockPath = path.join(root, 'package-lock.json');
  const originals = new Map(
    [bindingPath, packagePath, lockPath].map((file) => [file, fs.readFileSync(file)]),
  );
  const reset = () => {
    for (const [file, bytes] of originals) fs.writeFileSync(file, bytes);
  };
  const rejects = (relativePath, mutation, pattern) => {
    reset();
    mutateJson(root, relativePath, mutation);
    assert.throws(() => verifyCandidateBinding(root), pattern);
  };

  assert.doesNotThrow(() => verifyCandidateBinding(root));
  rejects(
    'fixtures/runtime-candidates/binding.json',
    (binding) => { binding.packages = []; },
    /candidate binding is empty|package set mismatch/,
  );
  rejects(
    'fixtures/runtime-candidates/binding.json',
    (binding) => { binding.packages.push({ ...binding.packages[0] }); },
    /candidate binding contains duplicate packages/,
  );
  rejects(
    'fixtures/runtime-candidates/binding.json',
    (binding) => {
      binding.packages.push({ ...binding.packages[0], name: '@aikdna/unexpected-runtime' });
    },
    /candidate binding package set mismatch.*unexpected-runtime/,
  );
  rejects(
    'package.json',
    (pkg) => { pkg.dependencies['@aikdna/unbound-runtime'] = '1.0.0'; },
    /candidate binding package set mismatch.*unbound-runtime/,
  );
  rejects(
    'package-lock.json',
    (lock) => { delete lock.packages[''].dependencies['@aikdna/kdna-core']; },
    /lock root AIKDNA dependencies package set mismatch.*kdna-core/,
  );
  rejects(
    'package-lock.json',
    (lock) => {
      lock.packages['node_modules/@aikdna/unbound-runtime'] = {
        version: '1.0.0',
        resolved:
          'https://registry.npmjs.org/@aikdna/unbound-runtime/-/unbound-runtime-1.0.0.tgz',
      };
    },
    /unbound AIKDNA lock package/,
  );
  rejects(
    'package-lock.json',
    (lock) => {
      lock.packages['node_modules/unbound-candidate'] = {
        version: '1.0.0',
        resolved: 'file:fixtures/runtime-candidates/kdna-core-0.19.0.tgz',
      };
    },
    /unbound file lock package/,
  );
  rejects(
    'package-lock.json',
    (lock) => {
      lock.packages['node_modules/foreign/node_modules/@aikdna/kdna-core'] = {
        version: '0.18.1',
        resolved: 'https://registry.npmjs.org/@aikdna/kdna-core/-/kdna-core-0.18.1.tgz',
      };
    },
    /bound AIKDNA lock package must appear exactly once.*kdna-core.*count=2/,
  );
  rejects(
    'package-lock.json',
    (lock) => {
      lock.packages[
        'node_modules/foreign/node_modules/@aikdna/kdna-core/node_modules/transitive'
      ] = { version: '1.0.0' };
    },
    /bound AIKDNA lock package must appear exactly once.*kdna-core.*count=2/,
  );
  rejects(
    'package-lock.json',
    (lock) => {
      const topLevel = lock.packages['node_modules/@aikdna/kdna-core'];
      lock.packages['node_modules/foreign/node_modules/@aikdna/kdna-core'] = {
        ...topLevel,
        resolved: 'file:fixtures/runtime-candidates/kdna-core-0.19.0.tgz',
      };
    },
    /bound AIKDNA lock package must appear exactly once.*kdna-core.*count=2/,
  );
  rejects(
    'package-lock.json',
    (lock) => {
      const topLevelPath = 'node_modules/@aikdna/kdna-core';
      lock.packages['node_modules/foreign/node_modules/@aikdna/kdna-core'] =
        lock.packages[topLevelPath];
      delete lock.packages[topLevelPath];
    },
    /bound AIKDNA lock package must be top-level.*kdna-core/,
  );
  rejects(
    'package-lock.json',
    (lock) => {
      lock.packages['node_modules/foreign/node_modules/@aikdna%2fkdna-core'] = {
        version: '0.19.0',
      };
    },
    /AIKDNA lock package path invalid/,
  );
  rejects(
    'package-lock.json',
    (lock) => {
      lock.packages['node_modules/foreign/node_modules/%2540aikdna%252fkdna-core'] = {
        version: '0.19.0',
      };
    },
    /AIKDNA lock package name invalid/,
  );
  rejects(
    'package-lock.json',
    (lock) => {
      lock.packages['node_modules/foreign/node_modules/@AIKDNA/kdna-core'] = {
        version: '0.19.0',
      };
    },
    /AIKDNA lock package name invalid/,
  );
});
