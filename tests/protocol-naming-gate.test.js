'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  findingsForText,
  scanPackedArtifact,
  scanTree,
} = require('../scripts/check-current-protocol-names');

const ROOT = path.resolve(__dirname, '..');

test('repository and actual npm tar contain only current KDNA-owned names', () => {
  assert.deepEqual(scanTree(ROOT), []);
  assert.deepEqual(scanPackedArtifact(ROOT), []);
});

test('naming gate rejects content, tag templates, identifiers, and filenames', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-name-hostile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const generation = ['v', '3'].join('');
  const implementation = ['build', 'V', '4', 'Report'].join('');
  const template = ['v', '${version}'].join('');
  fs.writeFileSync(
    path.join(root, 'src', `report-${generation}.js`),
    `const name = '${generation}';\nconst tag = \`${template}\`;\nconst ${implementation} = true;\n`,
  );

  const findings = scanTree(root);
  assert.ok(findings.some((finding) => finding.rule === 'generation-style label'));
  assert.ok(findings.some((finding) => finding.rule === 'generation-style tag template'));
  assert.ok(
    findings.some((finding) => finding.rule === 'generation-style implementation identifier'),
  );
  assert.ok(findings.some((finding) => finding.file.includes(`report-${generation}.js`)));
});

test('third-party allowlisting is exact and does not hide adjacent owned labels', () => {
  const generation = ['v', '8'].join('');
  const allowlist = [
    {
      file: '.github/workflows/ci.yml',
      text: 'vendor/action@' + generation,
      count: 1,
      reason: 'Third-party action selector.',
    },
  ];
  assert.deepEqual(
    findingsForText('.github/workflows/ci.yml', `uses: vendor/action@${generation}`, allowlist),
    [],
  );
  assert.equal(
    findingsForText(
      '.github/workflows/ci.yml',
      `uses: vendor/action@${generation}\nprofile: kdna-profile-${generation}`,
      allowlist,
    ).length,
    1,
  );
  assert.throws(
    () => findingsForText(
      '.github/workflows/ci.yml',
      `uses: vendor/action@${generation}\nuses: vendor/action@${generation}`,
      allowlist,
    ),
    /count mismatch/,
  );
});
