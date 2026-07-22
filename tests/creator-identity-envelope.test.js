// Hostile-envelope tests for decryptPrivateKey(). Every rejection must
// happen before the PBKDF2 derivation: these cases never reach the KDF or
// the cipher. Runnable standalone: node --test tests/creator-identity-envelope.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { decryptPrivateKey, encryptPrivateKey } = require('../src/creator-identity');

const PLAINTEXT = '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIDest\t\n-----END PRIVATE KEY-----\n';

function makeEnvelope(passphrase = 'pw', iterations = 1, plaintext = PLAINTEXT) {
  const salt = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(passphrase, salt, iterations, 32, 'sha256');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return {
    encrypted: true,
    kdf: 'pbkdf2-sha256',
    iterations,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

// ─── Accept paths ──────────────────────────────────────────────────

test('decryptPrivateKey: minimal-cost envelope (iterations = 1) still decrypts', () => {
  const envelope = makeEnvelope('pw', 1);
  assert.equal(decryptPrivateKey(envelope, 'pw'), PLAINTEXT);
  assert.equal(decryptPrivateKey(JSON.stringify(envelope), 'pw'), PLAINTEXT);
});

test('decryptPrivateKey: encryptPrivateKey roundtrip', () => {
  const envelope = encryptPrivateKey(PLAINTEXT, 'roundtrip-pass');
  assert.equal(decryptPrivateKey(envelope, 'roundtrip-pass'), PLAINTEXT);
});

// ─── Envelope shape ────────────────────────────────────────────────

test('decryptPrivateKey: rejects non-object envelopes', () => {
  for (const bad of [null, undefined, 42, true, [1, 2, 3], 'not json at all', '"5"', '[1]', 'null']) {
    assert.throws(() => decryptPrivateKey(bad, 'pw'), /Invalid key envelope|not valid JSON/);
  }
});

test('decryptPrivateKey: encrypted must be exactly true', () => {
  for (const value of [false, 'true', 1, undefined]) {
    const envelope = makeEnvelope();
    if (value === undefined) delete envelope.encrypted;
    else envelope.encrypted = value;
    assert.throws(() => decryptPrivateKey(envelope, 'pw'), /not encrypted/);
  }
});

// ─── KDF ───────────────────────────────────────────────────────────

test('decryptPrivateKey: unknown KDF names are rejected before any derivation', () => {
  for (const kdf of ['argon2id', 'pbkdf2-sha512', 'scrypt', 'PBKDF2-SHA256', 42, undefined]) {
    const envelope = makeEnvelope();
    if (kdf === undefined) delete envelope.kdf;
    else envelope.kdf = kdf;
    assert.throws(() => decryptPrivateKey(envelope, 'pw'), /Unsupported key envelope KDF/);
  }
});

test('decryptPrivateKey: KDF check precedes the iteration clamp', () => {
  const envelope = makeEnvelope();
  envelope.kdf = 'argon2id';
  envelope.iterations = Number.MAX_SAFE_INTEGER;
  assert.throws(() => decryptPrivateKey(envelope, 'pw'), /Unsupported key envelope KDF/);
});

// ─── Iterations ────────────────────────────────────────────────────

test('decryptPrivateKey: rejects non-integer, non-positive, and oversized iteration counts', () => {
  for (const iterations of ['600000', 0, -1, 1.5, NaN, 4000001, Number.MAX_SAFE_INTEGER, null]) {
    const envelope = makeEnvelope();
    envelope.iterations = iterations;
    assert.throws(() => decryptPrivateKey(envelope, 'pw'), /iterations must be a safe integer/);
  }
});

test('decryptPrivateKey: rejects absurd iteration counts that the old code fed to PBKDF2', () => {
  const envelope = makeEnvelope();
  envelope.iterations = 2 ** 40;
  assert.throws(() => decryptPrivateKey(envelope, 'pw'), /iterations must be a safe integer/);
});

// ─── Base64 fields ─────────────────────────────────────────────────

test('decryptPrivateKey: rejects malformed or wrongly sized salt', () => {
  const wrongLength = makeEnvelope();
  wrongLength.salt = crypto.randomBytes(8).toString('base64');
  assert.throws(() => decryptPrivateKey(wrongLength, 'pw'), /salt must decode to 16 bytes/);

  const notBase64 = makeEnvelope();
  notBase64.salt = '!!!not-base64!!!';
  assert.throws(() => decryptPrivateKey(notBase64, 'pw'), /salt is not well-formed base64/);

  const notString = makeEnvelope();
  notString.salt = 12345;
  assert.throws(() => decryptPrivateKey(notString, 'pw'), /salt must be a non-empty base64 string/);

  const unpadded = makeEnvelope();
  unpadded.salt = 'Zg';
  assert.throws(() => decryptPrivateKey(unpadded, 'pw'), /salt is not well-formed base64/);
});

test('decryptPrivateKey: rejects wrongly sized iv and tag', () => {
  const badIv = makeEnvelope();
  badIv.iv = crypto.randomBytes(16).toString('base64');
  assert.throws(() => decryptPrivateKey(badIv, 'pw'), /iv must decode to 12 bytes/);

  const badTag = makeEnvelope();
  badTag.tag = crypto.randomBytes(12).toString('base64');
  assert.throws(() => decryptPrivateKey(badTag, 'pw'), /tag must decode to 16 bytes/);
});

test('decryptPrivateKey: rejects non-canonical base64 that the lenient decoder would mangle', () => {
  const envelope = makeEnvelope();
  // Same decoded bytes, non-canonical spelling: round-trip does not match.
  envelope.tag = `${envelope.tag.slice(0, -2)}=A`;
  assert.throws(() => decryptPrivateKey(envelope, 'pw'), /tag is not (well-formed|canonical) base64/);
});

// ─── Ciphertext ────────────────────────────────────────────────────

test('decryptPrivateKey: rejects oversized ciphertext before the KDF runs', () => {
  const envelope = makeEnvelope();
  envelope.ciphertext = crypto.randomBytes(64 * 1024 + 1).toString('base64');
  assert.throws(() => decryptPrivateKey(envelope, 'pw'), /ciphertext must decode to between 1 and 65536 bytes/);
});

test('decryptPrivateKey: rejects empty and malformed ciphertext', () => {
  const empty = makeEnvelope();
  empty.ciphertext = '';
  assert.throws(() => decryptPrivateKey(empty, 'pw'), /ciphertext must be a non-empty base64 string/);

  const malformed = makeEnvelope();
  malformed.ciphertext = '####';
  assert.throws(() => decryptPrivateKey(malformed, 'pw'), /ciphertext is not well-formed base64/);
});
