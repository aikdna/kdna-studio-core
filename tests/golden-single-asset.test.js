const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cbor = require('cbor-x');
const kdnaCore = require('@aikdna/kdna-core');

const { loadProject, validateProject } = require('../src/project');
const { compileDomain } = require('../src/compile');
const { exportRuntimeAsset } = require('../src/export-runtime');

const FIXTURE_PATH = path.join(
  __dirname,
  '..',
  'fixtures',
  'golden-single-asset',
  'authoring-source.json',
);

function loadFixture() {
  return loadProject(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

function pick(source, fields) {
  return Object.fromEntries(fields.map((field) => [field, source[field]]));
}

const AXIOM_FIELDS = [
  'id',
  'one_sentence',
  'full_statement',
  'why',
  'confidence',
  'applies_when',
  'does_not_apply_when',
  'failure_risk',
];
const BOUNDARY_FIELDS = [
  'id',
  'scope',
  'out_of_scope',
  'acceptable_exceptions',
];

function writeFiles(directory, files) {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(directory, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

test('Golden synthetic authoring source preserves exact values through compiled JSON and CBOR payload', () => {
  const project = loadFixture();
  assert.deepEqual(validateProject(project), { valid: true, issues: [] });

  const sourceAxiom = project.cards.find((card) => card.type === 'axiom');
  const sourceBoundary = project.cards.find((card) => card.type === 'boundary');
  const sourceSelfCheck = project.cards.find((card) => card.type === 'self_check');
  const compiled = compileDomain(project);
  const compiledCore = JSON.parse(compiled.files['KDNA_Core.json']);
  const compiledPatterns = JSON.parse(compiled.files['KDNA_Patterns.json']);

  assert.deepEqual(
    pick(compiledCore, Object.keys(project.judgment_core)),
    project.judgment_core,
  );
  assert.deepEqual(
    pick(compiledCore.axioms[0], AXIOM_FIELDS),
    pick({ id: sourceAxiom.id, ...sourceAxiom.fields }, AXIOM_FIELDS),
  );
  assert.deepEqual(
    pick(compiledCore.boundaries[0], BOUNDARY_FIELDS),
    pick({ id: sourceBoundary.id, ...sourceBoundary.fields }, BOUNDARY_FIELDS),
  );
  assert.deepEqual(compiledPatterns.self_check, [sourceSelfCheck.fields.question]);

  const exported = exportRuntimeAsset(project, {
    compiled,
    asset_id: 'kdna:fixture:release-decision-golden',
    asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000401',
    timestamp: '2026-07-14T00:00:00.000Z',
  });
  const decodedPayload = cbor.decode(exported.files['payload.kdnab']);

  assert.deepEqual(decodedPayload, exported.payload);
  assert.deepEqual(
    pick(decodedPayload.core, Object.keys(project.judgment_core)),
    project.judgment_core,
  );
  assert.deepEqual(
    pick(decodedPayload.core.axioms[0], AXIOM_FIELDS),
    pick({ id: sourceAxiom.id, ...sourceAxiom.fields }, AXIOM_FIELDS),
  );
  assert.deepEqual(
    pick(decodedPayload.core.boundaries[0], BOUNDARY_FIELDS),
    pick({ id: sourceBoundary.id, ...sourceBoundary.fields }, BOUNDARY_FIELDS),
  );
  assert.deepEqual(decodedPayload.reasoning.self_check, [sourceSelfCheck.fields.question]);
});

test('Golden compiled domain lints clean and runtime export passes every public Core validation gate', () => {
  const project = loadFixture();
  const compiled = compileDomain(project);
  const exported = exportRuntimeAsset(project, {
    compiled,
    asset_id: 'kdna:fixture:release-decision-golden',
    asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000401',
    timestamp: '2026-07-14T00:00:00.000Z',
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-studio-golden-'));

  try {
    writeFiles(directory, exported.files);
    const validation = kdnaCore.validate(directory);
    for (const gate of [
      'format_valid',
      'schema_valid',
      'payload_valid',
      'checksums_valid',
      'load_contract_valid',
      'overall_valid',
    ]) {
      assert.equal(validation[gate], true, validation.problems.join('\n'));
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('runtime export fails closed when supplied compile output changes a declared Golden value', () => {
  const project = loadFixture();
  const compiled = compileDomain(project);
  const compiledCore = JSON.parse(compiled.files['KDNA_Core.json']);
  compiledCore.value_order = [...compiledCore.value_order].reverse();
  compiled.files['KDNA_Core.json'] = JSON.stringify(compiledCore, null, 2);

  assert.throws(
    () => exportRuntimeAsset(project, { compiled }),
    (error) => {
      assert.equal(error.code, 'SEMANTIC_FIDELITY_FAILED');
      assert.equal(error.stage, 'compiled_core');
      assert.deepEqual(error.failures, ['value_order']);
      return true;
    },
  );
});

test('project validation rejects malformed or unsupported judgment_core declarations', () => {
  const project = loadFixture();
  project.judgment_core.value_order = ['valid', 3];
  project.judgment_core.policy_table = { deploy: true };

  const result = validateProject(project);
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.includes('judgment_core.value_order[1]: expected a non-empty string'),
  );
  assert.ok(result.issues.includes('judgment_core.policy_table: unsupported field'));
});
