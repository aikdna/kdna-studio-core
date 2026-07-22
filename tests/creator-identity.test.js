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
const CRASH_CHILD = path.join(__dirname, 'identity-crash-child.js');

function tempIdentityDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-studio-identity-'));
}

// A dedicated parent directory holding a not-yet-existing identity dir, so
// tests can assert on staging siblings without scanning the shared tmpdir.
function tempIdentityParent() {
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-identity-parent-'));
  return { parentDir, dir: path.join(parentDir, 'identity') };
}

function readKey(dir, name) {
  return fs.readFileSync(path.join(dir, name), 'utf8');
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stderr }));
  });
}

function stagingDirs(parentDir) {
  return fs.readdirSync(parentDir)
    .filter((name) => name.startsWith('.kdna-init-') && name.endsWith('.staging.d'));
}

function verifySignature(payload, publicKeyPem, signature) {
  const sigBytes = Buffer.from(signature.slice('ed25519:'.length), 'hex');
  return crypto.verify(null, Buffer.from(payload), publicKeyPem, sigBytes);
}

function ed25519Keypair() {
  return crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

// Drive the real initIdentity export in a subprocess and have a watcher
// thread SIGKILL it at the requested commit phase. The child loops attempts
// internally so the watcher always catches the millisecond-wide phase
// window; a returned attempt is always a real kill at the real phase,
// proven by the marker the watcher writes before dying (its content is the
// interrupted transaction's parent directory).
async function crashInitAtPhase(phase, maxAttempts = 5) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), `kdna-crash-${phase}-`));
    const result = await runNode([CRASH_CHILD, baseDir, phase]);
    const markerPath = path.join(baseDir, '.crash-marker');
    if (fs.existsSync(markerPath)) {
      assert.notEqual(result.code, 0, `crash child at phase ${phase} exited cleanly`);
      const parentDir = fs.readFileSync(markerPath, 'utf8');
      // The marker must name the interrupted attempt inside this baseDir;
      // anything else means the kill raced the marker write — retry.
      if (parentDir.startsWith(`${baseDir}${path.sep}`)) {
        return { parentDir, dir: path.join(parentDir, 'identity'), result };
      }
    }
  }
  assert.fail(`crash harness never observed phase "${phase}" in ${maxAttempts} attempts`);
  return null;
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
  // Windows does not honor POSIX file modes.
  if (process.platform !== 'win32') {
    const mode = fs.statSync(path.join(dir, 'kdna.key')).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test('initIdentity: publishes into a not-yet-existing directory as one atomic rename', () => {
  const { parentDir, dir } = tempIdentityParent();
  const identity = initIdentity('tester', dir);
  assert.equal(loadIdentity(dir).creator_id, identity.creator_id);
  // The canonical directory holds exactly the three identity files and no
  // staging sibling is left behind.
  assert.deepEqual(fs.readdirSync(dir).sort(), ['creator.json', 'kdna.key', 'kdna.pub']);
  assert.deepEqual(stagingDirs(parentDir), []);
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

test('initIdentity: refuses to merge into a directory holding foreign files', () => {
  const dir = tempIdentityDir();
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'user data', { mode: 0o644 });
  assert.throws(() => initIdentity('tester', dir), /not empty/);
  assert.equal(readKey(dir, 'notes.txt'), 'user data');
  assert.equal(fs.existsSync(path.join(dir, 'kdna.key')), false);
});

// ─── initIdentity crash boundaries (real subprocesses, real SIGKILL) ──

for (const phase of ['key', 'pub', 'json']) {
  test(`initIdentity: SIGKILL after the ${phase} write (pre-commit) never publishes, and the next init recovers without manual cleanup`, async () => {
    const { parentDir, dir } = await crashInitAtPhase(phase);

    if (fs.existsSync(path.join(dir, 'creator.json'))) {
      // The kill landed in the microseconds after the rename: that is the
      // post-commit case and the identity must be complete and usable.
      const loaded = loadIdentity(dir);
      assert.ok(loaded);
      assert.equal(loaded.creator_id, creatorFingerprint(readKey(dir, 'kdna.pub')));
      assert.ok(verifySignature('late-kill', readKey(dir, 'kdna.pub'), signPayload('late-kill', dir)));
      return;
    }

    // The canonical directory never holds a subset of the identity files.
    assert.equal(fs.existsSync(dir), false);
    assert.equal(loadIdentity(dir), null);
    assert.equal(loadPublicKey(dir), null);
    assert.throws(() => signPayload('x', dir), /No private key found/);

    // The next init recovers directly. The test deletes nothing by hand:
    // the recovery itself removes the provable staging remnant (its owner
    // pid is the dead crash child).
    const recovered = initIdentity('recovered', dir);
    assert.equal(loadIdentity(dir).creator_id, recovered.creator_id);
    assert.ok(verifySignature('recovered', readKey(dir, 'kdna.pub'), signPayload('recovered', dir)));
    assert.deepEqual(stagingDirs(parentDir), []);
  });
}

test('initIdentity: SIGKILL immediately after the atomic publish leaves a complete identity', async () => {
  const { dir } = await crashInitAtPhase('post-commit');

  // The rename already happened: the identity loads and signs directly,
  // with no recovery step at all.
  const loaded = loadIdentity(dir);
  assert.ok(loaded);
  assert.equal(loaded.creator_id, creatorFingerprint(readKey(dir, 'kdna.pub')));
  const sig = signPayload('post-crash', dir);
  assert.ok(verifySignature('post-crash', loaded.public_key, sig));
});

test('initIdentity: four concurrent subprocesses yield exactly one identity and losers never damage the winner', async () => {
  const { parentDir, dir } = tempIdentityParent();
  const script = `require(${JSON.stringify(MODULE_PATH)}).initIdentity('racer', ${JSON.stringify(dir)});`;
  const results = await Promise.all(Array.from({ length: 4 }, () => runNode(['-e', script])));

  assert.equal(results.filter((r) => r.code === 0).length, 1);
  for (const loser of results.filter((r) => r.code !== 0)) {
    assert.match(loser.stderr, /already exist/);
  }

  const loaded = loadIdentity(dir);
  assert.ok(loaded);
  assert.equal(loaded.creator_id, creatorFingerprint(readKey(dir, 'kdna.pub')));
  const sig = signPayload('race-winner', dir);
  assert.ok(verifySignature('race-winner', readKey(dir, 'kdna.pub'), sig));

  // The losers exited without removing or overwriting the winner: the
  // identity is still intact and a further init still fails closed.
  assert.throws(() => initIdentity('third', dir), /already exist/);
  assert.equal(loadIdentity(dir).creator_id, loaded.creator_id);
  assert.ok(verifySignature('still-winner', readKey(dir, 'kdna.pub'), signPayload('still-winner', dir)));
  assert.deepEqual(stagingDirs(parentDir), []);
});

// ─── Canonical three-file consistency ────────────────────────────────

test('loadIdentity: creator_id that does not match the public key fingerprint is rejected', () => {
  const dir = tempIdentityDir();
  const identity = initIdentity('tester', dir);
  const tampered = JSON.parse(readKey(dir, 'creator.json'));
  tampered.creator_id = `${identity.creator_id.slice(0, -1)}${identity.creator_id.endsWith('0') ? '1' : '0'}`;
  fs.writeFileSync(path.join(dir, 'creator.json'), JSON.stringify(tampered, null, 2));

  for (const read of [() => loadIdentity(dir), () => loadPublicKey(dir), () => signPayload('x', dir)]) {
    assert.throws(read, /does not match the public key fingerprint/);
  }
});

test('loadIdentity: corrupt creator.json is rejected, not treated as no identity', () => {
  const dir = tempIdentityDir();
  initIdentity('tester', dir);
  fs.writeFileSync(path.join(dir, 'creator.json'), '{ not json');
  assert.throws(() => loadIdentity(dir), /not valid JSON/);
  assert.throws(() => loadPublicKey(dir), /not valid JSON/);
});

test('loadIdentity: a creator.json public key that differs from kdna.pub is rejected', () => {
  const dirA = tempIdentityDir();
  const dirB = tempIdentityDir();
  initIdentity('A', dirA);
  initIdentity('B', dirB);

  // creator.json now names key B while kdna.pub holds key A: the directory
  // would present two different public keys to different readers.
  const json = JSON.parse(readKey(dirA, 'creator.json'));
  json.public_key = readKey(dirB, 'kdna.pub');
  fs.writeFileSync(path.join(dirA, 'creator.json'), JSON.stringify(json, null, 2));

  for (const read of [() => loadIdentity(dirA), () => loadPublicKey(dirA), () => signPayload('x', dirA)]) {
    assert.throws(read, /not the same Ed25519 public key/);
  }
});

test('cross-directory tamper: the kdna.pub of identity B inside directory A is rejected by load, loadPublicKey, and sign', () => {
  const dirA = tempIdentityDir();
  const dirB = tempIdentityDir();
  initIdentity('A', dirA);
  initIdentity('B', dirB);

  fs.writeFileSync(path.join(dirA, 'kdna.pub'), readKey(dirB, 'kdna.pub'), { mode: 0o644 });

  for (const read of [() => loadIdentity(dirA), () => loadPublicKey(dirA), () => signPayload('x', dirA)]) {
    assert.throws(read, /not the same Ed25519 public key/);
  }
});

test('loadIdentity: deleting kdna.pub breaks the canonical identity and every read path fails closed', () => {
  const dir = tempIdentityDir();
  initIdentity('tester', dir);
  fs.rmSync(path.join(dir, 'kdna.pub'));

  for (const read of [() => loadIdentity(dir), () => loadPublicKey(dir), () => signPayload('x', dir)]) {
    assert.throws(read, /incomplete/);
  }
});

test('loadIdentity: deleting the private key breaks the canonical identity and every read path fails closed', () => {
  const dir = tempIdentityDir();
  initIdentity('tester', dir);
  fs.rmSync(path.join(dir, 'kdna.key'));

  assert.throws(() => loadIdentity(dir), /incomplete/);
  assert.throws(() => loadPublicKey(dir), /incomplete/);
  assert.throws(() => signPayload('x', dir), /No private key found/);
});

test('loadIdentity/signPayload: a replaced private key is rejected on every path', () => {
  const dir = tempIdentityDir();
  initIdentity('tester', dir);
  const { privateKey: foreignPrivate } = ed25519Keypair();
  fs.writeFileSync(path.join(dir, 'kdna.key'), foreignPrivate, { mode: 0o600 });

  assert.throws(() => loadIdentity(dir), /does not match the public key/);
  assert.throws(() => loadPublicKey(dir), /does not match the public key/);
  assert.throws(() => signPayload('x', dir), /does not match the public key/);
});

test('signPayload: key files without creator.json are not a signable identity', () => {
  const dir = tempIdentityDir();
  initIdentity('tester', dir);
  fs.rmSync(path.join(dir, 'creator.json'));

  assert.equal(loadIdentity(dir), null);
  assert.throws(() => signPayload('x', dir), /No valid identity/);
  assert.throws(() => loadPublicKey(dir), /incomplete/);
});

test('loadPublicKey: returns null only for a directory with no identity files', () => {
  const dir = tempIdentityDir();
  assert.equal(loadPublicKey(dir), null);
  const { dir: missing } = tempIdentityParent();
  assert.equal(loadPublicKey(missing), null);
});

// ─── Signing roundtrip ──────────────────────────────────────────────

test('signPayload/signHumanLock: signatures verify against the stored public key', () => {
  const dir = tempIdentityDir();
  initIdentity('signer', dir);
  const publicKeyPem = loadPublicKey(dir);
  assert.equal(publicKeyPem, readKey(dir, 'kdna.pub'));

  const sig = signPayload('hello', dir);
  assert.ok(sig.startsWith('ed25519:'));
  assert.ok(verifySignature('hello', publicKeyPem, sig));

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
  // The encrypted identity still passes the full consistency checks.
  assert.equal(loadIdentity(dir).encrypted, true);
  assert.ok(verifySignature('encrypted-sign', loadPublicKey(dir), signPayload('encrypted-sign', dir, 'passphrase')));
});

test('decryptPrivateKey: legacy 100000-iteration envelopes still decrypt', () => {
  const { privateKey } = ed25519Keypair();
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
