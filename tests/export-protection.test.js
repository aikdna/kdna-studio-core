'use strict';
// W-2 E-J2 protection tests (kdna-c0, 2026-10-06).
//
// The container constructor below is a minimal adaptation of the public
// conformance fixture recipe (blank/encode) from aikdna/kdna,
// conformance/public-contract/test/bytes-fixtures.cjs, as reviewed in the W-2
// batch. It builds one admitted blank judgment asset as a stored ZIP so these
// tests do not depend on a checked-in binary. The version tuple comes from the
// studio's own runtime binding, so the fixture follows the bound Core.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Encoder } = require('cbor-x/index-no-eval');
const binding = require('../src/creation-engine/component-runtime-binding.json');
const { protectExportedContainer } = require('../src/export-runtime');
const { admitProtectedNode } = require('@aikdna/kdna-core/protection-node');

const RECOVERY_CODE_PATTERN = /^kdna-recover-(?:[0-9A-F]{4}-){15}[0-9A-F]{4}$/;
const PASSWORD = 'studio-protection-probe-password';
const SUPPLIED_CODE =
  'kdna-recover-0000-1111-2222-3333-4444-5555-6666-7777-8888-9999-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF';
const SIGNATURE_POLICY = Object.freeze({ requireSignature: false, expectedPublicKeyHex: null });
const PROVIDER = Object.freeze({ kind: 'local', clock: () => Date.now() });

function crc(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  let offset = 0;
  const localParts = [];
  const centralParts = [];
  for (const [name, value] of Object.entries(entries)) {
    const n = Buffer.from(name);
    const b = Buffer.from(value);
    const checksum = crc(b);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(b.length, 18);
    local.writeUInt32LE(b.length, 22);
    local.writeUInt16LE(n.length, 26);
    localParts.push(local, n, b);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(b.length, 20);
    central.writeUInt32LE(b.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, n);
    offset += 30 + n.length + b.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  const count = Object.keys(entries).length;
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

function blankContainerBytes() {
  const tuple = binding.tuple;
  const manifest = {
    format_version: tuple.container,
    asset_id: 'asset:studio-protect-probe',
    asset_uid: 'uid:studio-protect-probe',
    asset_type: 'fixture',
    title: 'Studio protection probe asset',
    summary: 'Synthetic asset for the W-2 protection tests.',
    languages: ['en'],
    lineage: [],
    history: { coverage: 'complete', statement: 'Initial engineering fixture only.', entries: [] },
    version: '1.0.0',
    judgment_version: '1.0.0',
    created_at: '2026-10-06T00:00:00Z',
    updated_at: '2026-10-06T00:00:00Z',
    compatibility: {
      min_loader_version: '0.36.0',
      profile: tuple.payload_profile,
      profile_version: tuple.payload_version,
    },
    payload: { path: 'payload.kdnab', encoding: 'cbor', encrypted: false },
    runtime: { mandatory_entries: [] },
  };
  const payload = {
    profile: tuple.payload_profile,
    profile_version: tuple.payload_version,
    asset: {
      asset_id: manifest.asset_id,
      asset_version: manifest.version,
      judgment_version: manifest.judgment_version,
    },
    actors: [],
    scope: { statement: 'Asset scope' },
    declarations: {
      highest_question: { state: 'provided', value: 'What does this engineering fixture declare?' },
      boundaries: { state: 'none', value: null },
    },
    kernel: { purpose: { kind: 'summary' }, foundation_refs: [] },
    contracts: [],
    conditions: [],
    shared_declarations: [],
    materials: [],
    reasons: [],
    sources: [],
    source_uses: [],
    resources: [],
    relationships: [],
    dependencies: [],
    examples: [],
    exceptions: [],
    misuse: [],
    reading_order: ['j:0'],
    extensions: [],
    asset_capability: 'asserted_answers',
    judgments: [{
      id: 'j:0',
      focus: 'Explicit issue 0',
      subject: { actor_ids: [], statement: 'Example subject' },
      scope: { statement: 'Bounded scope 0' },
      answer_kind: 'preference',
      parent_ref: null,
      core_expression: {
        kind: 'authored',
        statement: 'Synthetic authored answer 0',
        qualification_refs: [],
      },
      method: {
        method: { term: 'feeling' },
        components: [{
          id: 'component:0',
          method: { term: 'feeling' },
          role: '个人感受',
          material_refs: [],
          statement: 'Synthetic subjective basis for regression testing.',
        }],
        bindings: [],
      },
      material_refs: [],
      reason_refs: [],
      content_uses: [],
      ports: [],
      inputs: [],
      boundaries: { state: 'none', value: null },
      exceptions: { state: 'none', value: null },
      misuse: { state: 'none', value: null },
      extensions: [],
      result_contract: {
        id: 'result-contract:0',
        form: { term: 'scalar', vocabulary: 'core' },
        shape: { kind: 'scalar', scalar_type: 'text' },
        minimum: 1,
        maximum: 1,
        allowed_result_types: [{ term: 'text', vocabulary: 'core' }],
      },
      result: {
        contract_ref: 'result-contract:0',
        result_type: { term: 'text', vocabulary: 'core' },
        value: { kind: 'text', value: 'Authored result 0' },
      },
      form: 'conclusion',
    }],
  };
  const encoder = new Encoder({ useRecords: false, mapsAsObjects: true, structuredClone: false });
  return zip({
    mimetype: Buffer.from('application/vnd.kdna.asset'),
    'kdna.json': Buffer.from(JSON.stringify(manifest)),
    'payload.kdnab': encoder.encode(payload),
  });
}

// Minimal structural probe: the stored local-file-header names of a container
// produced by Core's stored writer. It reads names only; it is not a second
// container parser.
function memberNames(input) {
  const bytes = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const names = [];
  let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0, 'expected a stored member');
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const size = bytes.readUInt32LE(offset + 18);
    names.push(bytes.toString('utf8', offset + 30, offset + 30 + nameLength));
    offset += 30 + nameLength + extraLength + size;
  }
  return names;
}

async function unlock(bytes, credential) {
  return admitProtectedNode(
    bytes,
    { credential, signaturePolicy: SIGNATURE_POLICY },
    PROVIDER,
  );
}

test('a protected export returns one studio-format recovery code and a four-member container', async () => {
  const plain = blankContainerBytes();
  assert.deepEqual(memberNames(plain), ['mimetype', 'kdna.json', 'payload.kdnab']);

  const produced = await protectExportedContainer(plain, { password: PASSWORD });
  assert.equal(produced.status, 'produced');
  assert.match(produced.recoveryCode, RECOVERY_CODE_PATTERN);
  assert.ok(produced.bytes instanceof Uint8Array && produced.bytes.length > 0);
  assert.deepEqual(
    memberNames(produced.bytes),
    ['mimetype', 'kdna.json', 'payload.kdnab', 'checksums.json'],
  );
  assert.equal(produced.evidence.entry, 'payload.kdnab');
  assert.equal(produced.evidence.profile.id, 'kdna.envelope.aead');
  assert.equal(produced.evidence.proof, 'producer_observation_not_consumer_admission');
});

test('both slots unlock through Core admission; wrong password and cross-slot attempts do not', async () => {
  const produced = await protectExportedContainer(blankContainerBytes(), { password: PASSWORD });

  const byPassword = await unlock(produced.bytes, {
    kind: 'password',
    password: Buffer.from(PASSWORD, 'utf8'),
    slotIndex: 0,
  });
  assert.equal(byPassword.status, 'accepted');

  const byRecovery = await unlock(produced.bytes, {
    kind: 'password',
    password: Buffer.from(produced.recoveryCode, 'utf8'),
    slotIndex: 1,
  });
  assert.equal(byRecovery.status, 'accepted');

  const wrongPassword = await unlock(produced.bytes, {
    kind: 'password',
    password: Buffer.from('wrong-password', 'utf8'),
    slotIndex: 0,
  });
  assert.equal(wrongPassword.status, 'protection_failed');

  const recoveryAtPasswordSlot = await unlock(produced.bytes, {
    kind: 'password',
    password: Buffer.from(produced.recoveryCode, 'utf8'),
    slotIndex: 0,
  });
  assert.equal(recoveryAtPasswordSlot.status, 'protection_failed');
});

test('a supplied recovery code is accepted only in the studio format and is echoed once', async () => {
  const produced = await protectExportedContainer(blankContainerBytes(), {
    password: PASSWORD,
    recoveryCode: SUPPLIED_CODE,
  });
  assert.equal(produced.recoveryCode, SUPPLIED_CODE);
});

test('invalid input is rejected before any asset exists, with studio codes or Core codes verbatim', async () => {
  const plain = blankContainerBytes();

  await assert.rejects(
    protectExportedContainer(plain, { password: '' }),
    (error) => error.code === 'PROTECTED_EXPORT_PASSWORD_REQUIRED',
  );
  await assert.rejects(
    protectExportedContainer(plain, { password: PASSWORD, recoveryCode: 'kdna-recover-not-a-code' }),
    (error) => error.code === 'PROTECTED_EXPORT_RECOVERY_FORMAT',
  );
  await assert.rejects(
    protectExportedContainer(Buffer.from('not a container'), { password: PASSWORD }),
    (error) => error.code === 'PROTECTED_EXPORT_SOURCE_INVALID' && error.core.status !== 'accepted',
  );

  const mismatchedUid = await protectExportedContainer(plain, {
    password: PASSWORD,
    asset_uid: 'uid:someone-else',
  }).then(
    () => null,
    (error) => error,
  );
  assert.equal(mismatchedUid.code, 'PROTECTION_DECLARATION_INVALID');
  assert.equal(mismatchedUid.core.status, 'protection_failed');

  const overlongUid = await protectExportedContainer(plain, {
    password: PASSWORD,
    asset_uid: 'u'.repeat(300),
  }).then(
    () => null,
    (error) => error,
  );
  assert.equal(overlongUid.code, 'PROTECTION_INPUT_INVALID');
  assert.equal(overlongUid.core.status, 'protection_failed');
});
