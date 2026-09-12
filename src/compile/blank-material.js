'use strict';

const { Encoder } = require('cbor-x');
const { admitBytes } = require('@aikdna/kdna-core');

// Mechanical compilation of newly authored text judgments. Core alone checks
// public structure, references, interpretation and the A/C/E digest domains.
function compileBlankMaterial({ brief, candidates, asset, createdAt, syntheticFixture }) {
  const reasons = candidates.map((candidate, index) => ({
    id: `reason:${index + 1}`, role: 'support', judgment_ref: `judgment:${index + 1}`,
    statement: candidate.rationale, component_refs: [],
  }));
  const payload = {
    profile: 'kdna.payload.judgment', profile_version: '0.2.0',
    asset: { asset_id: asset.asset_id, asset_version: asset.version, judgment_version: asset.version },
    actors: [], scope: { statement: brief.scope },
    judgments: candidates.map((candidate, index) => ({
      id: `judgment:${index + 1}`, label: candidate.title, focus: candidate.title,
      subject: { actor_ids: [], statement: candidate.subject },
      scope: { statement: candidate.scope },
      result_contract: {
        id: `result-contract:${index + 1}`, form: { term: 'text' },
        shape: { kind: 'scalar', scalar_type: 'text' }, minimum: 1, maximum: 1,
        allowed_result_types: [{ term: 'text' }],
      },
      result: {
        contract_ref: `result-contract:${index + 1}`, result_type: { term: 'text' },
        value: { kind: 'text', value: candidate.statement },
      },
      reason_refs: [reasons[index].id],
    })),
    reasons,
  };
  const manifest = {
    format_version: '0.2.0', asset_id: asset.asset_id, asset_uid: asset.asset_uid,
    asset_type: syntheticFixture ? 'fixture' : 'domain', title: brief.title,
    version: asset.version, judgment_version: asset.version,
    created_at: createdAt, updated_at: createdAt,
    compatibility: { min_loader_version: '0.23.0', profile: 'kdna.payload.judgment', profile_version: '0.2.0' },
    payload: { path: 'payload.kdnab', encoding: 'cbor', encrypted: false },
    runtime: { mandatory_entries: [] },
  };
  // No private source/confirmation/Creator field is copied into Runtime.
  const encoder = new Encoder({ useRecords: false, structuredClone: false, mapsAsObjects: true });
  const bytes = storedZip([
    ['mimetype', Buffer.from('application/vnd.kdna.asset')],
    ['kdna.json', Buffer.from(JSON.stringify(manifest))],
    ['payload.kdnab', Buffer.from(encoder.encode(payload))],
  ]);
  const admission = admitBytes(bytes);
  if (admission.status !== 'accepted') {
    throw Object.assign(new Error(`Public Core rejected compiler output: ${admission.reason}`), {
      code: 'CORE_EXPORT_REJECTED', coreReason: admission.reason,
    });
  }
  return { bytes, manifest, payload, assetDigest: admission.snapshot.digests.A.observed, digests: admission.snapshot.digests };
}

// A bounded, stored ZIP writer for the three known runtime members; not a
// parser or validator. No fallback to an old package/container implementation.
function storedZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, bytes] of entries) {
    if (bytes.length > 5 * 1024 * 1024) throw new Error('Compiler entry exceeds the Core limit.');
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, bytes);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(bytes.length, 20);
    directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(nameBytes.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBytes);
    offset += header.length + nameBytes.length + bytes.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

module.exports = { compileBlankMaterial };
