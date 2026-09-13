'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('@aikdna/kdna-core');
const { int64, float64, numericFixture, canonical, sha256 } = require('./numeric-fixtures');
const observations = [];

function admit(id, fixture) {
  const result = core.admitBytes(fixture.bytes);
  observations.push({ id, synthetic_fixture: true, bytes: fixture.bytes.length,
    sha256: sha256(fixture.bytes), container_base64: fixture.bytes.toString('base64'),
    expected_digests: fixture.expectedDigests, result });
  return result;
}

function checkAccepted(result, fixture) {
  assert.equal(result.status, 'accepted', JSON.stringify(result));
  for (const domain of ['A', 'C', 'E']) assert.equal(result.snapshot.digests[domain].observed, fixture.expectedDigests[domain]);
  assert.equal(result.snapshot.ir_digest, sha256(Buffer.from(canonical(result.snapshot.ir))));
  assert.deepEqual(result.snapshot.runtime_entry_names, ['kdna.json', 'payload.kdnab']);
}

const integers = [
  4294967296n, -4294967296n, 9007199254740991n, -9007199254740991n,
  9007199254740992n, -9007199254740992n, 9007199254740994n, -9007199254740994n,
  9223372036854775808n, -9223372036854775808n, 18446744073709549568n, -18446744073709551616n,
];
for (const integer of integers) {
  test(`exact integer ${integer} and equal float have identical IR but distinct byte digests`, () => {
    const value = Number(integer);
    assert.equal(BigInt(value), integer, 'The independent test value must be exactly representable.');
    const a = numericFixture(int64(integer)); const b = numericFixture(float64(value));
    const left = admit('int:' + integer, a); const right = admit('float:' + integer, b);
    checkAccepted(left, a); checkAccepted(right, b);
    const node = left.snapshot.ir.nodes.find(item => item.role === 'result');
    assert.equal(node.value.value.value, value);
    assert.deepEqual(left.snapshot.ir, right.snapshot.ir);
    assert.equal(left.snapshot.ir_digest, right.snapshot.ir_digest);
    for (const domain of ['A', 'C', 'E']) assert.notEqual(left.snapshot.digests[domain].observed, right.snapshot.digests[domain].observed);
  });
}

for (const integer of [9007199254740993n, -9007199254740993n, -9007199254740995n, 18446744073709551615n, -18446744073709551615n]) {
  test(`rejects inexact integer token ${integer} instead of rounding`, () => {
    assert.notEqual(BigInt(Number(integer)), integer);
    const result = admit('inexact:' + integer, numericFixture(int64(integer)));
    assert.equal(result.status, 'rejected'); assert.equal(result.reason, 'READ_CORE_INVALID');
  });
}

test('UInt remains independently bounded at 0 through 2^53-1', () => {
  for (const [label, minimum, maximum, accepted] of [
    ['zero-and-safe-max-int', 0, int64(9007199254740991n), true],
    ['zero-and-safe-max-float', 0, float64(9007199254740991), true],
    ['negative-minimum', -1, 1, false],
    ['too-large-maximum-int', 0, int64(9007199254740992n), false],
    ['too-large-maximum-float', 0, float64(9007199254740992), false],
    ['too-large-minimum', int64(9007199254740992n), null, false],
  ]) {
    const fixture = numericFixture(float64(1), { minimum, maximum });
    const result = admit('uint:' + label, fixture);
    if (accepted) checkAccepted(result, fixture);
    else { assert.equal(result.status, 'rejected', label); assert.equal(result.reason, 'READ_CORE_INVALID'); }
  }
});

test('ordinary finite fractions and large finite floats remain distinct from UInt', () => {
  for (const value of [1.5, -1.5, Number.MAX_VALUE, -Number.MAX_VALUE]) {
    const fixture = numericFixture(float64(value)); const result = admit('finite:' + value, fixture);
    checkAccepted(result, fixture);
  }
  for (const value of [NaN, Infinity, -Infinity]) {
    const result = admit('nonfinite:' + value, numericFixture(float64(value)));
    assert.equal(result.status, 'rejected'); assert.equal(result.reason, 'READ_CORE_INVALID');
  }
});

test('A and E retain JSON whitespace while C canonicalizes only JSON', () => {
  const a = numericFixture(int64(4294967296n));
  const b = numericFixture(int64(4294967296n), { manifestWhitespace: true });
  const left = admit('whitespace:compact', a); const right = admit('whitespace:pretty', b);
  checkAccepted(left, a); checkAccepted(right, b);
  assert.notEqual(left.snapshot.digests.A.observed, right.snapshot.digests.A.observed);
  assert.notEqual(left.snapshot.digests.E.observed, right.snapshot.digests.E.observed);
  assert.equal(left.snapshot.digests.C.observed, right.snapshot.digests.C.observed);
  assert.deepEqual(left.snapshot.ir, right.snapshot.ir);
  assert.equal(left.snapshot.ir_digest, right.snapshot.ir_digest);
});

test.after(() => {
  if (process.env.KDNA_NUMERIC_EVIDENCE_DIR) {
    const target = path.join(process.env.KDNA_NUMERIC_EVIDENCE_DIR, 'numeric-observations.json');
    fs.writeFileSync(target, JSON.stringify(observations, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify({ synthetic_numeric_observations: observations.length,
    accepted: observations.filter(item => item.result.status === 'accepted').length,
    rejected: observations.filter(item => item.result.status === 'rejected').length }));
});
