const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  initIdentity,
  loadIdentity,
  signPayload,
  signHumanLock,
  creatorFingerprint,
  loadPublicKey,
  encryptPrivateKey,
  decryptPrivateKey,
  isEncryptedKey,
} = require('../src/creator-identity');

// rotateIdentity is defined in src/creator-identity.js but not exported, and
// this fix deliberately adds no new public API. Tests compile the module
// source with the extra binding exposed so the shipped code is exercised
// as-is.
function loadInternals() {
  const modulePath = path.join(__dirname, '..', 'src', 'creator-identity.js');
  const source = `${fs.readFileSync(modulePath, 'utf8')}\nmodule.exports.rotateIdentity = rotateIdentity;`;
  const mod = { exports: {} };
  const compile = new Function('module', 'exports', 'require', '__dirname', '__filename', source);
  compile(mod, mod.exports, require, path.dirname(modulePath), modulePath);
  return mod.exports;
}

const { rotateIdentity } = loadInternals();

function tempIdentityDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-studio-identity-'));
}

function readKey(dir, name) {
  return fs.readFileSync(path.join(dir, name), 'utf8');
}

// ─── initIdentity ───────────────────────────────────────────────────

test('initIdentity: creates keypair, creator.json, and private key is 0o600', () => {
  const dir = tempIdentityDir();
  const identity = initIdentity('tester', dir);
  assert.ok(identity.creator_id.startsWith('kdna:creator:ed25519:'));
  assert.equal(identity.display_name, 'tester');
  assert.equal(identity.encrypted, false);
  const loaded = loadIdentity(dir);
  assert.equal(loaded.creator_id, identity.creator_id);
  const mode = fs.statSync(path.join(dir, 'kdna.key')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('initIdentity: refuses to overwrite existing keys and leaves files untouched', () => {
  const dir = tempIdentityDir();
  const first = initIdentity('first', dir);
  const privBefore = readKey(dir, 'kdna.key');
  const pubBefore = readKey(dir, 'kdna.pub');
  const jsonBefore = readKey(dir, 'creator.json');

  assert.throws(() => initIdentity('second', dir), /already exist/);

  assert.equal(readKey(dir, 'kdna.key'), privBefore);
  assert.equal(readKey(dir, 'kdna.pub'), pubBefore);
  assert.equal(readKey(dir, 'creator.json'), jsonBefore);
  assert.equal(loadIdentity(dir).creator_id, first.creator_id);
});

test('initIdentity: existing public key alone also blocks regeneration', () => {
  const dir = tempIdentityDir();
  fs.writeFileSync(path.join(dir, 'kdna.pub'), 'pre-existing', { mode: 0o644 });
  assert.throws(() => initIdentity('tester', dir), /already exist/);
  assert.equal(readKey(dir, 'kdna.pub'), 'pre-existing');
  assert.equal(fs.existsSync(path.join(dir, 'kdna.key')), false);
});

// ─── Signing roundtrip ──────────────────────────────────────────────

test('signPayload/signHumanLock: signatures verify against the stored public key', () => {
  const dir = tempIdentityDir();
  initIdentity('signer', dir);
  const publicKeyPem = loadPublicKey(dir);

  const sig = signPayload('hello', dir);
  assert.ok(sig.startsWith('ed25519:'));
  const sigBytes = Buffer.from(sig.slice('ed25519:'.length), 'hex');
  assert.equal(crypto.verify(null, Buffer.from('hello'), publicKeyPem, sigBytes), true);

  const lockSig = signHumanLock('card-1', 'I confirm this judgment.', 'fp-123', dir);
  const lockPayload = ['card-1', 'I confirm this judgment.', 'fp-123'].join('\n');
  const lockSigBytes = Buffer.from(lockSig.slice('ed25519:'.length), 'hex');
  assert.equal(crypto.verify(null, Buffer.from(lockPayload), publicKeyPem, lockSigBytes), true);
});

// ─── Key encryption envelope ────────────────────────────────────────

test('encryptPrivateKey: new envelopes are written at 600000 PBKDF2 iterations', () => {
  const dir = tempIdentityDir();
  initIdentity('encrypted', dir, 'passphrase');
  const envelope = JSON.parse(readKey(dir, 'kdna.key'));
  assert.equal(envelope.encrypted, true);
  assert.equal(envelope.kdf, 'pbkdf2-sha256');
  assert.equal(envelope.iterations, 600000);
  assert.equal(isEncryptedKey(readKey(dir, 'kdna.key')), true);
  const pem = decryptPrivateKey(readKey(dir, 'kdna.key'), 'passphrase');
  assert.ok(pem.includes('PRIVATE KEY'));
});

test('decryptPrivateKey: legacy 100000-iteration envelopes still decrypt', () => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const salt = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync('legacy-pass', salt, 100000, 32, 'sha256');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(privateKey)), cipher.final()]);
  const legacyEnvelope = JSON.stringify({
    encrypted: true,
    kdf: 'pbkdf2-sha256',
    iterations: 100000,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  });
  assert.equal(decryptPrivateKey(legacyEnvelope, 'legacy-pass'), privateKey);
  // A wrong passphrase must fail authentication; the exact message depends on
  // the Node/OpenSSL version, so only the failure itself is asserted here.
  assert.throws(() => decryptPrivateKey(legacyEnvelope, 'wrong-pass'));
});

// ─── Rotation ───────────────────────────────────────────────────────

test('rotateIdentity: rotates keys, records previous key, and new key signs', () => {
  const dir = tempIdentityDir();
  const before = initIdentity('rotator', dir);
  const oldPub = loadPublicKey(dir);
  const oldPrivRaw = readKey(dir, 'kdna.key');

  const rotated = rotateIdentity(null, dir);

  assert.notEqual(rotated.creator_id, before.creator_id);
  assert.equal(rotated.creator_id, creatorFingerprint(loadPublicKey(dir)));
  assert.equal(rotated.previous_keys.length, 1);
  assert.equal(rotated.previous_keys[0].creator_id, before.creator_id);
  assert.equal(rotated.previous_keys[0].public_key, oldPub);
  assert.ok(rotated.previous_keys[0].rotation_signature.startsWith('ed25519:'));
  assert.equal(rotated.previous_keys[0].private_key_backup, 'kdna.key.previous');

  // Old private key bytes are preserved in the backup file.
  assert.equal(readKey(dir, 'kdna.key.previous'), oldPrivRaw);
  assert.equal(fs.statSync(path.join(dir, 'kdna.key.previous')).mode & 0o777, 0o600);

  // New key signs and verifies against the new public key.
  const sig = signPayload('post-rotation', dir);
  const sigBytes = Buffer.from(sig.slice('ed25519:'.length), 'hex');
  assert.equal(crypto.verify(null, Buffer.from('post-rotation'), loadPublicKey(dir), sigBytes), true);

  assert.equal(loadIdentity(dir).creator_id, rotated.creator_id);
});

test('rotateIdentity: encrypted identity re-encrypts the new key with the passphrase', () => {
  const dir = tempIdentityDir();
  initIdentity('encrypted-rotator', dir, 'pw');
  const oldEnvelope = readKey(dir, 'kdna.key');

  const rotated = rotateIdentity('pw', dir);

  assert.equal(isEncryptedKey(readKey(dir, 'kdna.key')), true);
  // Backup preserves the old envelope bytes, still encrypted.
  assert.equal(readKey(dir, 'kdna.key.previous'), oldEnvelope);
  const sig = signPayload('x', dir, 'pw');
  const sigBytes = Buffer.from(sig.slice('ed25519:'.length), 'hex');
  assert.equal(crypto.verify(null, Buffer.from('x'), rotated.public_key, sigBytes), true);
});

test('rotateIdentity: encrypted identity without passphrase fails without touching files', () => {
  const dir = tempIdentityDir();
  initIdentity('encrypted', dir, 'pw');
  const privBefore = readKey(dir, 'kdna.key');
  const pubBefore = readKey(dir, 'kdna.pub');
  const jsonBefore = readKey(dir, 'creator.json');

  assert.throws(() => rotateIdentity(null, dir), /encrypted/);

  assert.equal(readKey(dir, 'kdna.key'), privBefore);
  assert.equal(readKey(dir, 'kdna.pub'), pubBefore);
  assert.equal(readKey(dir, 'creator.json'), jsonBefore);
  assert.equal(fs.existsSync(path.join(dir, 'kdna.key.previous')), false);
});

// ─── Rotation crash safety ──────────────────────────────────────────

function withPatchedFs(method, patch, fn) {
  const original = fs[method];
  fs[method] = patch(original);
  try {
    fn();
  } finally {
    fs[method] = original;
  }
}

test('rotateIdentity: failure while replacing the private key leaves the old keypair usable', () => {
  const dir = tempIdentityDir();
  const before = initIdentity('crash-test', dir);
  const privBefore = readKey(dir, 'kdna.key');
  const pubBefore = readKey(dir, 'kdna.pub');
  const privPath = path.join(dir, 'kdna.key');

  withPatchedFs('renameSync', (original) => (source, destination) => {
    if (destination === privPath) throw new Error('simulated crash during key replacement');
    return original(source, destination);
  }, () => {
    assert.throws(() => rotateIdentity(null, dir), /simulated crash/);
  });

  // Old keypair is untouched and still signs.
  assert.equal(readKey(dir, 'kdna.key'), privBefore);
  assert.equal(readKey(dir, 'kdna.pub'), pubBefore);
  const sig = signPayload('still-me', dir);
  const sigBytes = Buffer.from(sig.slice('ed25519:'.length), 'hex');
  assert.equal(crypto.verify(null, Buffer.from('still-me'), pubBefore, sigBytes), true);

  // The old identity is still the loaded one, and the backup landed before
  // any overwrite was attempted.
  assert.equal(loadIdentity(dir).creator_id, before.creator_id);
  assert.equal(readKey(dir, 'kdna.key.previous'), privBefore);
  assert.equal(loadIdentity(dir).previous_keys.length, 1);
  assert.equal(loadIdentity(dir).previous_keys[0].public_key, pubBefore);
});

test('rotateIdentity: failure on the very first backup write changes nothing', () => {
  const dir = tempIdentityDir();
  initIdentity('crash-test', dir);
  const privBefore = readKey(dir, 'kdna.key');
  const pubBefore = readKey(dir, 'kdna.pub');
  const jsonBefore = readKey(dir, 'creator.json');
  const backupPath = path.join(dir, 'kdna.key.previous');

  withPatchedFs('renameSync', (original) => (source, destination) => {
    if (destination === backupPath) throw new Error('simulated crash during backup');
    return original(source, destination);
  }, () => {
    assert.throws(() => rotateIdentity(null, dir), /simulated crash/);
  });

  assert.equal(readKey(dir, 'kdna.key'), privBefore);
  assert.equal(readKey(dir, 'kdna.pub'), pubBefore);
  assert.equal(readKey(dir, 'creator.json'), jsonBefore);
  assert.equal(fs.existsSync(backupPath), false);
});

test('rotateIdentity: failure after key replacement keeps recovery data on disk', () => {
  const dir = tempIdentityDir();
  const before = initIdentity('crash-test', dir);
  const oldPub = loadPublicKey(dir);
  const oldPrivRaw = readKey(dir, 'kdna.key');
  const jsonPath = path.join(dir, 'creator.json');

  // Let the step-1 creator.json write (previous_keys backup) succeed, then
  // fail the step-3 creator.json write that advances to the new identity.
  let jsonRenames = 0;
  withPatchedFs('renameSync', (original) => (source, destination) => {
    if (destination === jsonPath) {
      jsonRenames += 1;
      if (jsonRenames === 2) throw new Error('simulated crash after key replacement');
    }
    return original(source, destination);
  }, () => {
    assert.throws(() => rotateIdentity(null, dir), /simulated crash/);
  });

  // Keys were rotated, creator.json was not advanced — but the previous
  // public key and old private key bytes survive on disk for recovery.
  assert.notEqual(readKey(dir, 'kdna.pub'), oldPub);
  const saved = loadIdentity(dir);
  assert.equal(saved.creator_id, before.creator_id);
  assert.equal(saved.previous_keys.length, 1);
  assert.equal(saved.previous_keys[0].public_key, oldPub);
  assert.equal(readKey(dir, 'kdna.key.previous'), oldPrivRaw);
});
