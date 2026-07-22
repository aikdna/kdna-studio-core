const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
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

const MODULE_PATH = path.join(__dirname, '..', 'src', 'creator-identity.js');

function tempIdentityDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-studio-identity-'));
}

function readKey(dir, name) {
  return fs.readFileSync(path.join(dir, name), 'utf8');
}

function withPatchedFs(method, patch, fn) {
  const original = fs[method];
  fs[method] = patch(original);
  try {
    fn();
  } finally {
    fs[method] = original;
  }
}

function runNode(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

function visibleFiles(dir) {
  return fs.readdirSync(dir).filter((name) => !name.endsWith('.tmp'));
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

test('initIdentity: a pre-existing creator.json is never overwritten', () => {
  const dir = tempIdentityDir();
  const preExisting = JSON.stringify({ creator_id: 'kdna:creator:ed25519:pre-existing' }, null, 2);
  fs.writeFileSync(path.join(dir, 'creator.json'), preExisting, { mode: 0o644 });

  assert.throws(() => initIdentity('tester', dir), /already exist/);

  assert.equal(readKey(dir, 'creator.json'), preExisting);
  assert.equal(fs.existsSync(path.join(dir, 'kdna.key')), false);
  assert.equal(fs.existsSync(path.join(dir, 'kdna.pub')), false);
});

test('initIdentity: existing public key alone also blocks regeneration', () => {
  const dir = tempIdentityDir();
  fs.writeFileSync(path.join(dir, 'kdna.pub'), 'pre-existing', { mode: 0o644 });
  assert.throws(() => initIdentity('tester', dir), /already exist/);
  assert.equal(readKey(dir, 'kdna.pub'), 'pre-existing');
  assert.equal(fs.existsSync(path.join(dir, 'kdna.key')), false);
});

// ─── initIdentity transaction rollback ─────────────────────────────

test('initIdentity: public key write failure rolls back the private key', () => {
  const dir = tempIdentityDir();
  const pubPath = path.join(dir, 'kdna.pub');

  withPatchedFs('linkSync', (original) => (source, destination) => {
    if (destination === pubPath) throw new Error('simulated public key write failure');
    return original(source, destination);
  }, () => {
    assert.throws(() => initIdentity('tester', dir), /simulated public key write failure/);
  });

  assert.deepEqual(visibleFiles(dir), []);
  assert.equal(loadIdentity(dir), null);
});

test('initIdentity: creator.json commit failure rolls back the whole keypair', () => {
  const dir = tempIdentityDir();
  const jsonPath = path.join(dir, 'creator.json');

  withPatchedFs('linkSync', (original) => (source, destination) => {
    if (destination === jsonPath) throw new Error('simulated creator.json commit failure');
    return original(source, destination);
  }, () => {
    assert.throws(() => initIdentity('tester', dir), /simulated creator.json commit failure/);
  });

  // Rollback scope includes every file the call created: no half identity.
  assert.deepEqual(visibleFiles(dir), []);
  assert.equal(loadIdentity(dir), null);
});

test('initIdentity: creator.json write (pre-commit) failure rolls back the whole keypair', () => {
  const dir = tempIdentityDir();

  withPatchedFs('openSync', (original) => (target, ...rest) => {
    if (typeof target === 'string' && target.includes('creator.json')) {
      throw new Error('simulated creator.json write failure');
    }
    return original(target, ...rest);
  }, () => {
    assert.throws(() => initIdentity('tester', dir), /simulated creator.json write failure/);
  });

  assert.deepEqual(visibleFiles(dir), []);
  assert.equal(loadIdentity(dir), null);
});

// ─── initIdentity crash boundaries (real subprocesses) ─────────────

test('initIdentity: a process killed mid-init leaves no accepted identity and recovers', async () => {
  for (const crashAfter of [1, 2]) {
    const dir = tempIdentityDir();
    const script = `
      const fs = require('fs');
      let links = 0;
      const original = fs.linkSync.bind(fs);
      fs.linkSync = (source, destination) => {
        const result = original(source, destination);
        links += 1;
        if (links === ${crashAfter}) process.exit(42);
        return result;
      };
      require(${JSON.stringify(MODULE_PATH)}).initIdentity('crasher', ${JSON.stringify(dir)});
    `;
    const { code } = await runNode(script);
    assert.equal(code, 42);

    // The remnant files are not accepted as an identity by any path.
    assert.equal(loadIdentity(dir), null);
    assert.throws(() => initIdentity('retry', dir), /already exist/);
    assert.throws(() => signPayload('x', dir), /No valid identity/);

    // After manual cleanup of the remnants, init recovers to a full identity.
    fs.rmSync(path.join(dir, 'kdna.key'), { force: true });
    fs.rmSync(path.join(dir, 'kdna.pub'), { force: true });
    const recovered = initIdentity('recovered', dir);
    assert.equal(loadIdentity(dir).creator_id, recovered.creator_id);
  }
});

test('initIdentity: a process killed right after the commit record leaves a complete identity', async () => {
  const dir = tempIdentityDir();
  const script = `
    const fs = require('fs');
    let links = 0;
    const original = fs.linkSync.bind(fs);
    fs.linkSync = (source, destination) => {
      const result = original(source, destination);
      links += 1;
      if (links === 3) process.exit(42);
      return result;
    };
    require(${JSON.stringify(MODULE_PATH)}).initIdentity('crasher', ${JSON.stringify(dir)});
  `;
  const { code } = await runNode(script);
  assert.equal(code, 42);

  const loaded = loadIdentity(dir);
  assert.ok(loaded);
  assert.equal(loaded.creator_id, creatorFingerprint(readKey(dir, 'kdna.pub')));
  const sig = signPayload('post-crash', dir);
  const sigBytes = Buffer.from(sig.slice('ed25519:'.length), 'hex');
  assert.equal(crypto.verify(null, Buffer.from('post-crash'), loaded.public_key, sigBytes), true);
});

test('initIdentity: concurrent initialization yields exactly one consistent identity', async () => {
  const dir = tempIdentityDir();
  const script = `require(${JSON.stringify(MODULE_PATH)}).initIdentity('racer', ${JSON.stringify(dir)});`;
  const results = await Promise.all(Array.from({ length: 4 }, () => runNode(script)));

  assert.equal(results.filter((r) => r.code === 0).length, 1);
  for (const loser of results.filter((r) => r.code !== 0)) {
    assert.match(loser.stderr, /already exist/);
  }

  const loaded = loadIdentity(dir);
  assert.ok(loaded);
  assert.equal(loaded.creator_id, creatorFingerprint(readKey(dir, 'kdna.pub')));
  const sig = signPayload('race-winner', dir);
  const sigBytes = Buffer.from(sig.slice('ed25519:'.length), 'hex');
  assert.equal(crypto.verify(null, Buffer.from('race-winner'), readKey(dir, 'kdna.pub'), sigBytes), true);
});

// ─── loadIdentity / signPayload consistency ────────────────────────

test('loadIdentity: creator_id that does not match the public key fingerprint is rejected', () => {
  const dir = tempIdentityDir();
  const identity = initIdentity('tester', dir);
  const jsonPath = path.join(dir, 'creator.json');
  const tampered = JSON.parse(readKey(dir, 'creator.json'));
  tampered.creator_id = `${identity.creator_id.slice(0, -1)}${identity.creator_id.endsWith('0') ? '1' : '0'}`;
  fs.writeFileSync(jsonPath, JSON.stringify(tampered, null, 2));

  assert.throws(() => loadIdentity(dir), /does not match the public key fingerprint/);
  assert.throws(() => signPayload('x', dir), /does not match the public key fingerprint/);
});

test('loadIdentity: corrupt creator.json is rejected, not treated as no identity', () => {
  const dir = tempIdentityDir();
  initIdentity('tester', dir);
  fs.writeFileSync(path.join(dir, 'creator.json'), '{ not json');
  assert.throws(() => loadIdentity(dir), /not valid JSON/);
});

test('signPayload: a private key that does not match the public key is rejected', () => {
  const dir = tempIdentityDir();
  initIdentity('tester', dir);
  const { privateKey: foreignPrivate } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  fs.writeFileSync(path.join(dir, 'kdna.key'), foreignPrivate, { mode: 0o600 });

  assert.throws(() => signPayload('x', dir), /does not match the public key/);
});

test('signPayload: key files without creator.json are not a signable identity', () => {
  const dir = tempIdentityDir();
  initIdentity('tester', dir);
  fs.rmSync(path.join(dir, 'creator.json'));
  assert.throws(() => signPayload('x', dir), /No valid identity/);
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
