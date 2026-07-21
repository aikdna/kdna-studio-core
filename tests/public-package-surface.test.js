'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

test('npm tarball excludes unvalidated Studio workshops', () => {
  const packed = spawnSync(
    'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: ROOT, encoding: 'utf8', shell: false },
  );
  assert.equal(packed.status, 0, packed.stderr);
  const reports = JSON.parse(packed.stdout);
  assert.equal(reports.length, 1);
  const files = reports[0].files.map((entry) => entry.path);

  for (const forbidden of [
    'src/cards/feynman.js',
    'src/governance/',
    'src/quality/',
    'src/testlab/',
    'schemas/evaluation-report.schema.json',
    'schemas/quality-gate-report.schema.json',
  ]) {
    assert.equal(
      files.some((file) => file === forbidden || file.startsWith(forbidden)),
      false,
      `experimental workshop leaked into npm tarball: ${forbidden}`,
    );
  }

  for (const required of [
    'src/index.js',
    'src/authoring/index.js',
    'src/compile/index.js',
    'src/export-runtime/index.js',
    'src/project/index.js',
  ]) {
    assert.ok(files.includes(required), `public authoring primitive missing from npm tarball: ${required}`);
  }
});
