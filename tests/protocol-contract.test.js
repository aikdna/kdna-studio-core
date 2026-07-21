'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const JsonSchema2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const { createProject } = require('../src/project');
const { createCard } = require('../src/cards');
const { compileDomain } = require('../src/compile');
const protocolContract = require('../src/protocol-contract');

const ROOT = path.resolve(__dirname, '..');
const REPORT_SCHEMAS = Object.freeze({
  'reports/build-report.json': 'schemas/studio-build-report.schema.json',
  'reports/human-lock-report.json': 'schemas/human-lock-report.schema.json',
  'build-receipt.json': 'schemas/studio-build-receipt.schema.json',
});

function compileFixture(access = 'public') {
  const project = createProject('report_contract_fixture', 'domain');
  project.release = { ...(project.release || {}), access };
  project.cards.push(
    createCard(
      'axiom',
      {
        one_sentence: 'A report type and its compatibility coordinate are separate.',
        full_statement:
          'Every Studio report declares a responsibility-specific type and an independent schema coordinate.',
        why: 'A combined generation label cannot tell consumers which responsibility changed.',
        applies_when: ['Compiling Studio evidence'],
        does_not_apply_when: ['Reading uncompiled authoring notes'],
        failure_risk: 'Consumers may route the report using an ambiguous identifier.',
      },
      'ax_report_contract',
    ),
  );
  return compileDomain(project, {
    compiled_at: '2026-07-16T00:00:00.000Z',
  });
}

function validator(relativeSchemaPath) {
  const ajv = new JsonSchema2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(
    JSON.parse(fs.readFileSync(path.join(ROOT, relativeSchemaPath), 'utf8')),
  );
}

test('Studio compile reports validate against responsibility-specific schemas', () => {
  const compiled = compileFixture('licensed');
  for (const [reportPath, schemaPath] of Object.entries(REPORT_SCHEMAS)) {
    const value = JSON.parse(compiled.files[reportPath]);
    const validate = validator(schemaPath);
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
    assert.equal(value.schema_version, '0.1.0');
    assert.match(value.type, /^kdna\.studio\./);
  }

  const receipt = JSON.parse(compiled.files['build-receipt.json']);
  assert.equal(receipt.encryption_profile, 'kdna.encryption.licensed-entry');
  assert.equal(receipt.encryption_profile_version, '0.1.0');
  const manifest = JSON.parse(compiled.files['kdna.json']);
  assert.equal('reports/quality-gate-report.json' in compiled.files, false);
  assert.equal('reports/eval-report.json' in compiled.files, false);
  assert.deepEqual(manifest.runtime, {
    min_runtime_version: '0.3.0',
    load_contract: 'kdna.runtime-capsule',
    load_contract_version: '0.1.0',
  });
});

test('report schemas reject a wrong responsibility type or compatibility coordinate', () => {
  const compiled = compileFixture();
  const report = JSON.parse(compiled.files['reports/build-report.json']);
  const validate = validator(REPORT_SCHEMAS['reports/build-report.json']);

  assert.equal(validate({ ...report, type: 'kdna.studio.unrelated-report' }), false);
  assert.equal(validate({ ...report, schema_version: '9.9.9' }), false);
});

test('protocol contract keeps responsibility names separate from coordinates', () => {
  assert.equal(protocolContract.FORMAT_VERSION, '0.1.0');
  assert.equal(protocolContract.PAYLOAD_PROFILE, 'kdna.payload.judgment');
  assert.equal(protocolContract.PAYLOAD_PROFILE_VERSION, '0.1.0');
  assert.equal(protocolContract.RUNTIME_CAPSULE_TYPE, 'kdna.runtime-capsule');
  assert.equal(protocolContract.RUNTIME_CAPSULE_VERSION, '0.1.0');
  assert.equal(
    protocolContract.RUNTIME_ENTRY_SET_DIGEST_PROFILE,
    'kdna.digest-basis.runtime-entry-set',
  );
  assert.equal(protocolContract.RUNTIME_ENTRY_SET_DIGEST_PROFILE_VERSION, '0.1.0');
});
