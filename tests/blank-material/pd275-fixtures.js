'use strict';

// Synthetic public container vectors only. This helper is never shipped and
// does not add a numeric/raw-field authoring API to the text Creation kernel.
const crypto = require('node:crypto');
const tokenBrand = Symbol('synthetic-cbor-token');

function int64(value) {
  const integer = BigInt(value);
  const argument = integer < 0n ? -1n - integer : integer;
  if (argument < 0n || argument > 0xffffffffffffffffn) throw new RangeError('Fixture integer is outside CBOR uint64 argument range.');
  const raw = Buffer.alloc(9);
  raw[0] = integer < 0n ? 0x3b : 0x1b;
  raw.writeBigUInt64BE(argument, 1);
  return { [tokenBrand]: raw };
}

function float64(value) {
  const raw = Buffer.alloc(9);
  raw[0] = 0xfb;
  raw.writeDoubleBE(value, 1);
  return { [tokenBrand]: raw };
}

function argument(major, value) {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 256) return Buffer.from([(major << 5) | 24, value]);
  if (value < 65536) {
    const out = Buffer.alloc(3); out[0] = (major << 5) | 25; out.writeUInt16BE(value, 1); return out;
  }
  const out = Buffer.alloc(5); out[0] = (major << 5) | 26; out.writeUInt32BE(value, 1); return out;
}

function cbor(value) {
  if (value && value[tokenBrand]) return value[tokenBrand];
  if (value === null) return Buffer.from([0xf6]);
  if (typeof value === 'boolean') return Buffer.from([value ? 0xf5 : 0xf4]);
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 0 && value <= 0xffffffff) return argument(0, value);
    return float64(value)[tokenBrand];
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value); return Buffer.concat([argument(3, bytes.length), bytes]);
  }
  if (Array.isArray(value)) return Buffer.concat([argument(4, value.length), ...value.map(cbor)]);
  const pairs = Object.entries(value);
  return Buffer.concat([argument(5, pairs.length), ...pairs.flatMap(([key, item]) => [cbor(key), cbor(item)])]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const records = []; const directory = []; let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name); const crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    records.push(local, nameBytes, data);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(central, nameBytes); offset += local.length + nameBytes.length + data.length;
  }
  const central = Buffer.concat(directory); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, central, end]);
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function sha256(bytes) {
  return 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
}

function word(value, bytes) {
  const out = Buffer.alloc(bytes);
  if (bytes === 4) out.writeUInt32BE(value); else out.writeBigUInt64BE(BigInt(value));
  return out;
}

// Independent digest oracle restricted to these literal fixtures: C uses JCS
// for JSON and retains raw CBOR; E contains only the two mandatory base entries.
function digests(entries, bytes) {
  const names = Object.keys(entries).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const c = [Buffer.from('KDNA-CONTENT-TREE\0' + '0.2.0\0'), word(names.length, 4)];
  for (const name of names) {
    const n = Buffer.from(name); const isJson = name.endsWith('.json');
    const data = isJson ? Buffer.from(canonical(JSON.parse(entries[name]))) : entries[name];
    c.push(word(n.length, 4), n, Buffer.from([isJson ? 0 : 1]), word(data.length, 8), data);
  }
  const eNames = ['kdna.json', 'payload.kdnab'];
  const e = [Buffer.from('KDNA-RUNTIME-ENTRY-SET\0' + '0.2.0\0'), word(eNames.length, 4)];
  for (const name of eNames) {
    const n = Buffer.from(name); e.push(word(n.length, 4), n, word(entries[name].length, 8), entries[name]);
  }
  return { A: sha256(bytes), C: sha256(Buffer.concat(c)), E: sha256(Buffer.concat(e)) };
}

function numericFixture(value, { minimum = 1, maximum = 1, manifestWhitespace = false } = {}) {
  const manifest = {
    format_version: '0.2.0', asset_id: 'asset:synthetic-pd275',
    asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000275', asset_type: 'fixture',
    title: 'Synthetic PD275 numeric fixture', version: '0.1.0', judgment_version: '0.1.0',
    created_at: '2026-09-07T00:00:00Z', updated_at: '2026-09-07T00:00:00Z',
    compatibility: { min_loader_version: '0.23.0', profile: 'kdna.payload.judgment', profile_version: '0.2.0' },
    payload: { path: 'payload.kdnab', encoding: 'cbor', encrypted: false }, runtime: { mandatory_entries: [] },
  };
  const payload = {
    profile: 'kdna.payload.judgment', profile_version: '0.2.0',
    asset: { asset_id: manifest.asset_id, asset_version: manifest.version, judgment_version: manifest.judgment_version },
    actors: [], scope: { statement: 'Synthetic numeric decoder test; no real judgment, human or authorization.' },
    judgments: [{
      id: 'judgment:synthetic-number', focus: 'A synthetic numerical result',
      subject: { actor_ids: [], statement: 'Synthetic number' }, scope: { statement: 'Codec fixture only' },
      result_contract: { id: 'result-contract:synthetic-number', form: { term: 'number' },
        shape: { kind: 'scalar', scalar_type: 'number' }, minimum, maximum, allowed_result_types: [{ term: 'number' }] },
      result: { contract_ref: 'result-contract:synthetic-number', result_type: { term: 'number' }, value: { kind: 'number', value } },
    }],
  };
  const entries = {
    mimetype: Buffer.from('application/vnd.kdna.asset'),
    'kdna.json': Buffer.from(JSON.stringify(manifest, null, manifestWhitespace ? 2 : undefined)),
    'payload.kdnab': cbor(payload),
  };
  const bytes = zip(entries);
  return { bytes, entries, expectedDigests: digests(entries, bytes) };
}

module.exports = { int64, float64, numericFixture, canonical, sha256 };
