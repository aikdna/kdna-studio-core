const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
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
  IDENTITY_ALREADY_EXISTS,
  IDENTITY_INCOMPLETE,
  IDENTITY_CORRUPT,
  IDENTITY_KDF_FAILED,
  IDENTITY_COMMITTED_DURABILITY_UNCONFIRMED,
  IDENTITY_COMMITTED_INCONSISTENT,
} = require('../src/creator-identity');

const MODULE_PATH = path.join(__dirname, '..', 'src', 'creator-identity.js');
const CRASH_CHILD = path.join(__dirname, 'identity-crash-child.js');
const STAGING_HOLDER_CHILD = path.join(__dirname, 'identity-staging-holder-child.js');

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

function captureError(fn) {
  let failure = null;
  try {
    fn();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, 'expected function to throw');
  return failure;
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

  const failure = captureError(() => initIdentity('second', dir));
  assert.equal(failure.code, IDENTITY_ALREADY_EXISTS);
  assert.equal(failure.identityVerified, true);
  assert.equal(failure.creator_id, first.creator_id);

  assert.equal(readKey(dir, 'kdna.key'), privBefore);
  assert.equal(readKey(dir, 'kdna.pub'), pubBefore);
  assert.equal(readKey(dir, 'creator.json'), jsonBefore);
  assert.equal(loadIdentity(dir).creator_id, first.creator_id);
});

test('initIdentity: a pre-existing creator.json is never overwritten', () => {
  const dir = tempIdentityDir();
  const preExisting = JSON.stringify({ creator_id: 'kdna:creator:ed25519:pre-existing' }, null, 2);
  fs.writeFileSync(path.join(dir, 'creator.json'), preExisting, { mode: 0o644 });

  const failure = captureError(() => initIdentity('tester', dir));
  assert.equal(failure.code, IDENTITY_INCOMPLETE);
  assert.equal(failure.identityVerified, false);
  assert.doesNotMatch(failure.message, /already exists/i);

  assert.equal(readKey(dir, 'creator.json'), preExisting);
  assert.equal(fs.existsSync(path.join(dir, 'kdna.key')), false);
  assert.equal(fs.existsSync(path.join(dir, 'kdna.pub')), false);
});

test('initIdentity: existing public key alone also blocks regeneration', () => {
  const dir = tempIdentityDir();
  fs.writeFileSync(path.join(dir, 'kdna.pub'), 'pre-existing', { mode: 0o644 });
  const failure = captureError(() => initIdentity('tester', dir));
  assert.equal(failure.code, IDENTITY_INCOMPLETE);
  assert.equal(failure.identityVerified, false);
  assert.doesNotMatch(failure.message, /already exists/i);
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

test('initIdentity: each single canonical file is classified as incomplete and preserved', () => {
  for (const file of ['creator.json', 'kdna.key', 'kdna.pub']) {
    const dir = tempIdentityDir();
    const content = file === 'creator.json'
      ? JSON.stringify({ creator_id: 'kdna:creator:ed25519:partial' })
      : `partial-${file}`;
    fs.writeFileSync(path.join(dir, file), content);

    const failure = captureError(() => initIdentity('tester', dir));
    assert.equal(failure.code, IDENTITY_INCOMPLETE, file);
    assert.equal(failure.identityVerified, false, file);
    assert.doesNotMatch(failure.message, /already exists/i);
    assert.equal(readKey(dir, file), content, file);
    assert.deepEqual(fs.readdirSync(dir), [file], file);
  }
});

test('initIdentity: a present but mismatched three-file identity is corrupt, not already-existing', () => {
  const dir = tempIdentityDir();
  initIdentity('tester', dir);
  const beforePrivate = readKey(dir, 'kdna.key');
  const beforePublic = readKey(dir, 'kdna.pub');
  const corrupt = JSON.parse(readKey(dir, 'creator.json'));
  corrupt.creator_id = `${corrupt.creator_id}-wrong`;
  const corruptJson = JSON.stringify(corrupt, null, 2);
  fs.writeFileSync(path.join(dir, 'creator.json'), corruptJson);

  const failure = captureError(() => initIdentity('replacement', dir));
  assert.equal(failure.code, IDENTITY_CORRUPT);
  assert.equal(failure.identityVerified, false);
  assert.doesNotMatch(failure.message, /already exists/i);
  assert.equal(readKey(dir, 'kdna.key'), beforePrivate);
  assert.equal(readKey(dir, 'kdna.pub'), beforePublic);
  assert.equal(readKey(dir, 'creator.json'), corruptJson);
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

// ─── Staging remnant reclamation: liveness, never age ────────────────

async function waitForFile(filePath, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${filePath}`);
}

test('initIdentity: a live owner\'s staging is never reclaimed at any age; a dead owner\'s provable remnant is', async (t) => {
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-live-staging-'));
  t.after(() => fs.rmSync(parentDir, { recursive: true, force: true }));

  // A real, live child process owns a provable staging remnant.
  const holder = spawn(process.execPath, [STAGING_HOLDER_CHILD, parentDir], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let holderStderr = '';
  holder.stderr.on('data', (chunk) => { holderStderr += chunk; });
  const holderExited = new Promise((resolve) => {
    holder.on('close', (code, signal) => resolve({ code, signal }));
  });
  await waitForFile(path.join(parentDir, '.holder-ready'));
  const stagingName = fs.readFileSync(path.join(parentDir, '.holder-ready'), 'utf8');
  const stagingDir = path.join(parentDir, stagingName);
  assert.match(stagingName, new RegExp(`^\\.kdna-init-${holder.pid}-`));
  assert.deepEqual(fs.readdirSync(stagingDir).sort(), ['kdna.key', 'kdna.pub']);

  // Make the remnant look far older than any age-based grace period: an age
  // threshold must never override the fact that the owner is alive. Windows
  // cannot always update directory timestamps; the liveness assertion does
  // not depend on the age adjustment succeeding.
  const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  try { fs.utimesSync(stagingDir, longAgo, longAgo); } catch { /* best effort */ }

  // Another init sweeps the same parent directory. The live owner's staging
  // and its staged files survive byte-for-byte.
  initIdentity('sweeper', path.join(parentDir, 'identity'));
  assert.deepEqual(fs.readdirSync(stagingDir).sort(), ['kdna.key', 'kdna.pub']);
  assert.equal(readKey(stagingDir, 'kdna.key'), 'held-private-key-placeholder');
  assert.equal(readKey(stagingDir, 'kdna.pub'), 'held-public-key-placeholder');

  // Once the owner process is dead, the provable remnant is reclaimed by the
  // next sweep.
  holder.kill('SIGTERM');
  await holderExited;
  assert.equal(holderStderr, '');
  initIdentity('sweeper-2', path.join(parentDir, 'identity-2'));
  assert.equal(fs.existsSync(stagingDir), false);
});

test('initIdentity: remnants with unparseable owners or foreign files fail safe and are never auto-removed', () => {
  const { parentDir, dir } = tempIdentityParent();
  // A real dead pid: spawned, exited, and reaped synchronously.
  const deadPid = spawnSync(process.execPath, ['-e', ''], { shell: false }).pid;
  assert.ok(Number.isSafeInteger(deadPid));

  const unparseable = path.join(parentDir, '.kdna-init-notapid-x.staging.d');
  fs.mkdirSync(unparseable);
  fs.writeFileSync(path.join(unparseable, 'kdna.key'), 'orphaned');

  const foreign = path.join(parentDir, `.kdna-init-${deadPid}-x.staging.d`);
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'notes.txt'), 'user data');

  const provable = path.join(parentDir, `.kdna-init-${deadPid}-y.staging.d`);
  fs.mkdirSync(provable);
  fs.writeFileSync(path.join(provable, 'kdna.pub'), 'orphaned');

  initIdentity('tester', dir);

  // Ownership unproven or content foreign: left alone, never auto-deleted.
  assert.equal(readKey(unparseable, 'kdna.key'), 'orphaned');
  assert.equal(readKey(foreign, 'notes.txt'), 'user data');
  // Dead owner + provable transaction content: reclaimed.
  assert.equal(fs.existsSync(provable), false);
});

// ─── Commit-point semantics: the rename is the logical commit ────────

test('initIdentity: a parent-directory fsync failure after the commit rename reports a committed identity, never a plain failure', () => {
  const { parentDir, dir } = tempIdentityParent();
  const realOpenSync = fs.openSync;
  const injected = new Error('injected parent fsync failure');
  injected.code = 'EIO';
  // Precise post-commit injection: the only (parentDir, 'r') open in the
  // whole transaction is the parent-directory fsync after the rename.
  fs.openSync = function openSync(target, flags, mode) {
    if (flags === 'r' && target === parentDir) throw injected;
    return realOpenSync.call(fs, target, flags, mode);
  };
  let failure = null;
  try {
    initIdentity('durability', dir);
  } catch (error) {
    failure = error;
  } finally {
    fs.openSync = realOpenSync;
  }

  // The caller receives a stable, machine-readable committed state — not an
  // ordinary initialization failure and not an "already exists" report.
  assert.ok(failure);
  assert.equal(failure.code, IDENTITY_COMMITTED_DURABILITY_UNCONFIRMED);
  assert.equal(failure.committed, true);
  assert.equal(failure.identityVerified, true);
  assert.equal(failure.durabilityConfirmed, false);
  assert.equal(failure.identity_dir, dir);
  assert.doesNotMatch(failure.message, /already exist/);
  assert.match(failure.message, /committed/);
  assert.match(failure.message, /durability/);

  // The identity is on disk, complete, and passes every read path — the API
  // must not imply that nothing was created.
  assert.deepEqual(fs.readdirSync(dir).sort(), ['creator.json', 'kdna.key', 'kdna.pub']);
  const loaded = loadIdentity(dir);
  assert.ok(loaded);
  assert.equal(failure.creator_id, loaded.creator_id);
  assert.ok(verifySignature('committed', readKey(dir, 'kdna.pub'), signPayload('committed', dir)));

  // The error never carries private key material, in any field.
  assert.equal(failure.message.includes('PRIVATE KEY'), false);
  assert.equal(failure.stack.includes('PRIVATE KEY'), false);
  assert.equal(JSON.stringify(failure).includes('PRIVATE KEY'), false);
  assert.equal(JSON.stringify(failure).includes(readKey(dir, 'kdna.key')), false);

  // Nothing was rolled back: a retry sees the committed identity and fails
  // closed instead of re-creating it.
  assert.throws(() => initIdentity('retry', dir), /already exist/);
  assert.equal(loadIdentity(dir).creator_id, loaded.creator_id);
  assert.deepEqual(stagingDirs(parentDir), []);
});

test('initIdentity: post-commit verification failure is committed-but-inconsistent and every use path fails closed', () => {
  const { parentDir, dir } = tempIdentityParent();
  const realOpenSync = fs.openSync;
  const injected = new Error('injected parent fsync failure');
  injected.code = 'EIO';

  fs.openSync = function openSync(target, flags, mode) {
    if (flags === 'r' && target === parentDir) {
      // The rename has already committed the canonical directory. Corrupt one
      // public metadata file before the post-commit verifier runs.
      fs.writeFileSync(path.join(dir, 'creator.json'), '{ committed but corrupt');
      throw injected;
    }
    return realOpenSync.call(fs, target, flags, mode);
  };

  let failure;
  try {
    initIdentity('inconsistent', dir);
  } catch (error) {
    failure = error;
  } finally {
    fs.openSync = realOpenSync;
  }

  assert.ok(failure);
  assert.equal(failure.code, IDENTITY_COMMITTED_INCONSISTENT);
  assert.equal(failure.committed, true);
  assert.equal(failure.identityVerified, false);
  assert.equal(failure.durabilityConfirmed, false);
  assert.equal(failure.identity_dir, dir);
  assert.equal(failure.creator_id, undefined);
  assert.match(failure.message, /failed consistency verification/i);
  assert.match(failure.message, /do not sign/i);
  assert.match(failure.message, /preserve the directory/i);
  assert.doesNotMatch(failure.message, /complete three-file identity/i);
  assert.doesNotMatch(failure.message, /use loadIdentity\(\) to access/i);

  assert.deepEqual(fs.readdirSync(dir).sort(), ['creator.json', 'kdna.key', 'kdna.pub']);
  assert.throws(() => loadIdentity(dir), /not valid JSON/);
  assert.throws(() => loadPublicKey(dir), /not valid JSON/);
  assert.throws(() => signPayload('must-not-sign', dir), /not valid JSON/);

  const retryFailure = captureError(() => initIdentity('retry', dir));
  assert.equal(retryFailure.code, IDENTITY_CORRUPT);
  assert.equal(retryFailure.identityVerified, false);
  assert.deepEqual(stagingDirs(parentDir), []);

  const privateKey = readKey(dir, 'kdna.key');
  assert.equal(failure.message.includes(privateKey), false);
  assert.equal(failure.stack.includes(privateKey), false);
  assert.equal(JSON.stringify(failure).includes(privateKey), false);
});

test('initIdentity: a pre-commit failure publishes nothing and init is safely retryable', () => {
  const { parentDir, dir } = tempIdentityParent();
  const realOpenSync = fs.openSync;
  const injected = new Error('injected staging fsync failure');
  injected.code = 'EIO';
  // Precise pre-commit injection: the staging-directory fsync before the
  // rename is the only 'r' open of a .kdna-init-* path.
  fs.openSync = function openSync(target, flags, mode) {
    if (flags === 'r' && path.basename(target).startsWith('.kdna-init-')) throw injected;
    return realOpenSync.call(fs, target, flags, mode);
  };
  let failure = null;
  try {
    initIdentity('pre-commit', dir);
  } catch (error) {
    failure = error;
  } finally {
    fs.openSync = realOpenSync;
  }

  // The failure happened before the commit rename: an ordinary error with no
  // committed state, and nothing on the canonical path.
  assert.ok(failure);
  assert.equal(failure.code, 'EIO');
  assert.equal(failure.committed, undefined);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(loadIdentity(dir), null);
  assert.equal(loadPublicKey(dir), null);
  assert.throws(() => signPayload('x', dir), /No private key found/);

  // The same call succeeds once the fault is gone — pre-commit failures are
  // always safe to retry.
  const identity = initIdentity('retried', dir);
  assert.equal(loadIdentity(dir).creator_id, identity.creator_id);
  assert.ok(verifySignature('retried', readKey(dir, 'kdna.pub'), signPayload('retried', dir)));
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

test('encryptPrivateKey: KDF failures carry a stable machine-readable code', () => {
  const realPbkdf2Sync = crypto.pbkdf2Sync;
  const injected = new Error('injected KDF failure');
  injected.code = 'ERR_CRYPTO_OPERATION_FAILED';
  crypto.pbkdf2Sync = () => { throw injected; };
  try {
    const failure = captureError(() => encryptPrivateKey('private-key', 'passphrase'));
    assert.equal(failure.code, IDENTITY_KDF_FAILED);
    assert.equal(failure.committed, false);
    assert.equal(failure.identityVerified, false);
    assert.doesNotMatch(failure.message, /passphrase|private-key/);
  } finally {
    crypto.pbkdf2Sync = realPbkdf2Sync;
  }
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
