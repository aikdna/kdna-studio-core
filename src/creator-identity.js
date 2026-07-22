/**
 * Creator Identity — local Ed25519 keypair generation, loading, and signing.
 *
 * Creator IDs use the format: "kdna:creator:ed25519:<sha256-of-public-key>"
 * Private keys are stored in ~/.kdna/identity/ by default.
 *
 * This is local-first — no registration, no upload, no cloud dependency.
 * The private key is the root of creator identity; the public key fingerprint
 * is the creator_id that appears in studio.project.json and exported .kdna assets.
 *
 * Studio Core does not provide identity key rotation. The identity directory
 * holds exactly one identity: kdna.key, kdna.pub, and creator.json either form
 * one mutually consistent identity or are not accepted as an identity at all.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CREATOR_ID_PREFIX = 'kdna:creator:ed25519:';

function defaultIdentityDir() {
  return process.env.KDNA_IDENTITY_DIR || path.join(os.homedir(), '.kdna', 'identity');
}

const PRIVATE_KEY_FILE = 'kdna.key';
const PUBLIC_KEY_FILE = 'kdna.pub';
const IDENTITY_JSON_FILE = 'creator.json';

// PBKDF2 iteration count for newly written key envelopes. 600000 matches the
// OWASP recommendation for PBKDF2-HMAC-SHA256 and is supported by the
// pbkdf2Sync implementations of every supported runtime (Node 18, 22, 24;
// engines: >=18).
//
// The envelope carries its own `iterations` value so envelopes written at
// 100000 iterations keep decrypting without any migration. That
// self-description is a compatibility mechanism, not a security property:
// decryptPrivateKey() strictly validates the envelope (exact KDF name,
// bounded iteration count, strict base64 field lengths) before deriving a
// key, and rejects anything outside the contract below.
const PBKDF2_ITERATIONS = 600000;

// Accepted iteration range for envelopes being decrypted.
// Minimum 1: the count is a cost parameter, not a correctness parameter, so
// any positive value must still decrypt (legacy envelopes included).
// Maximum 4,000,000: PBKDF2-HMAC-SHA256 runs at roughly 1M iterations per
// second on modest hardware, so the clamp bounds a single decrypt call to a
// few seconds worst case. Envelopes carrying absurd counts (2^31 and beyond,
// or negative/fractional values) are rejected before any work instead of
// turning decryptPrivateKey into a CPU-exhaustion vector. The clamp follows
// the same reasoning as the parameter bounds applied to Core's Argon2id
// profile; 4M is ~6.7x the current write-side cost, leaving headroom for
// future increases without permitting hostile values.
const PBKDF2_MIN_ITERATIONS = 1;
const PBKDF2_MAX_ITERATIONS = 4000000;

const ENVELOPE_KDF = 'pbkdf2-sha256';
const ENVELOPE_SALT_BYTES = 16;
const ENVELOPE_IV_BYTES = 12; // AES-256-GCM nonce
const ENVELOPE_TAG_BYTES = 16; // GCM authentication tag
// A PKCS8 Ed25519 private key PEM is ~2 KB; encrypted envelopes an order of
// magnitude larger are never legitimate. The cap keeps hostile envelopes
// from forcing large buffer allocations and is enforced before the KDF runs.
const ENVELOPE_MAX_CIPHERTEXT_BYTES = 64 * 1024;

/**
 * Write `data` to `filePath` only if `filePath` does not already exist:
 * write and fsync a sibling temp file, then hard-link it into place.
 * link(2) is atomic and fails with EEXIST instead of overwriting, so an
 * existing identity file is never clobbered — even by a caller that races
 * the advisory existence checks in initIdentity(). The temp file is fsynced
 * before the link so the linked bytes are durable.
 */
function writeNewFileSync(filePath, data, mode) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', mode);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.linkSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * fsync a directory so the file entries created inside it are durable.
 * Some platforms (notably Windows) cannot open or fsync a directory handle;
 * that limitation does not weaken the per-file fsyncs, so only those
 * platform errors are tolerated.
 */
function fsyncDirectorySync(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    if (error && (error.code === 'EISDIR' || error.code === 'EINVAL')) return;
    throw error;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}

/**
 * Compute the creator_id fingerprint from an Ed25519 public key PEM.
 */
function creatorFingerprint(publicKeyPem) {
  const hash = crypto.createHash('sha256').update(publicKeyPem).digest('hex');
  return `${CREATOR_ID_PREFIX}${hash}`;
}

function identityExistsError(dir) {
  return new Error(
    `Identity keys already exist in ${dir}. Use loadIdentity() to access them, or remove the files to regenerate.`,
  );
}

/**
 * Generate a new Ed25519 keypair and persist to identityDir.
 * If passphrase is provided, the private key is encrypted with AES-256-GCM
 * (key derived via PBKDF2-SHA256). Without passphrase, plaintext with 0o600.
 *
 * The three identity files are committed as one transaction: kdna.key,
 * kdna.pub, then creator.json as the final commit record. Every write is
 * no-clobber (an existing creator.json is never overwritten) and any
 * write/link/fsync failure rolls back every file this call created. A
 * process killed between commit boundaries leaves either a complete,
 * mutually consistent identity or no valid identity: remnant key files
 * without a creator.json are rejected here and by loadIdentity()/signPayload().
 */
function initIdentity(displayName, identityDir = null, passphrase = null) {
  const dir = identityDir || defaultIdentityDir();
  fs.mkdirSync(dir, { recursive: true });

  const privateKeyPath = path.join(dir, PRIVATE_KEY_FILE);
  const publicKeyPath = path.join(dir, PUBLIC_KEY_FILE);
  const identityJsonPath = path.join(dir, IDENTITY_JSON_FILE);

  // Advisory pre-checks for clear messages. The authoritative no-clobber
  // guarantee is the EEXIST failure of the hard-link commit below, which
  // closes the TOCTOU gap between these checks and the writes.
  if (fs.existsSync(identityJsonPath)) {
    throw new Error(
      `Identity already exists in ${dir}: creator.json is present and is never overwritten. `
      + 'Use loadIdentity() to access it, or remove the files to regenerate.',
    );
  }
  const remnants = [privateKeyPath, publicKeyPath].filter((p) => fs.existsSync(p));
  if (remnants.length > 0) {
    throw new Error(
      `Identity files already exist in ${dir} without a creator.json `
      + `(${remnants.map((p) => path.basename(p)).join(', ')}). An incomplete identity left by an `
      + 'interrupted init is not a valid identity; remove the remnant files to regenerate.',
    );
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const privateKeyData = passphrase
    ? encryptPrivateKey(privateKey, passphrase)
    : privateKey;

  const creatorId = creatorFingerprint(publicKey);
  const identity = {
    creator_id: creatorId,
    display_name: displayName || '',
    public_key: publicKey,
    public_key_path: publicKeyPath,
    identity_dir: dir,
    created_at: new Date().toISOString(),
    verified: false,
    encrypted: !!passphrase,
  };
  const identityJson = JSON.stringify(identity, null, 2);

  const created = [];
  try {
    writeNewFileSync(privateKeyPath, privateKeyData, 0o600);
    created.push(privateKeyPath);
    writeNewFileSync(publicKeyPath, publicKey, 0o644);
    created.push(publicKeyPath);
    // creator.json is the commit record: once it exists, the directory holds
    // a complete identity; before it exists, the directory holds none.
    writeNewFileSync(identityJsonPath, identityJson, 0o644);
    created.push(identityJsonPath);
    fsyncDirectorySync(dir);
  } catch (error) {
    // Roll back every file this call created — including creator.json — so a
    // failed init never leaves a half-written identity behind. Files that
    // already existed are never touched: a path is only in `created` after
    // this call's own link succeeded.
    for (const createdPath of created.reverse()) {
      fs.rmSync(createdPath, { force: true });
    }
    if (error && error.code === 'EEXIST') throw identityExistsError(dir);
    throw error;
  }

  return identity;
}

/**
 * Load an existing creator identity from disk.
 * Returns null only when no creator.json exists. A creator.json that is
 * unparseable, has no usable public key, or whose creator_id does not match
 * the public key fingerprint is corrupt or mismatched state and is rejected
 * with an error instead of being silently loaded or silently treated as
 * "no identity".
 */
function loadIdentity(identityDir = null) {
  const dir = identityDir || defaultIdentityDir();
  const identityJsonPath = path.join(dir, IDENTITY_JSON_FILE);
  const publicKeyPath = path.join(dir, PUBLIC_KEY_FILE);

  if (!fs.existsSync(identityJsonPath)) return null;

  let identity;
  try {
    identity = JSON.parse(fs.readFileSync(identityJsonPath, 'utf8'));
  } catch {
    throw new Error(
      `creator.json in ${dir} is not valid JSON — the identity is corrupt and is not loaded.`,
    );
  }
  if (!identity || typeof identity !== 'object' || typeof identity.creator_id !== 'string') {
    throw new Error(
      `creator.json in ${dir} does not describe an identity (missing creator_id) — not loaded.`,
    );
  }

  // Public key material may live in creator.json itself or only in kdna.pub
  // (it may have been deleted from the JSON for security).
  const publicKeyPem = typeof identity.public_key === 'string' && identity.public_key
    ? identity.public_key
    : (fs.existsSync(publicKeyPath) ? fs.readFileSync(publicKeyPath, 'utf8') : null);
  if (!publicKeyPem) {
    throw new Error(
      `Identity in ${dir} is incomplete: creator.json carries no public key and ${PUBLIC_KEY_FILE} is missing.`,
    );
  }

  const expectedId = creatorFingerprint(publicKeyPem);
  if (identity.creator_id !== expectedId) {
    throw new Error(
      `creator_id in ${dir}/creator.json does not match the public key fingerprint `
      + '(expected ' + expectedId + ', found ' + identity.creator_id + ') — refusing to load a mismatched identity.',
    );
  }

  identity.public_key = publicKeyPem;
  identity.identity_dir = dir;
  identity.public_key_path = publicKeyPath;

  return identity;
}

/**
 * Sign a payload with the creator's Ed25519 private key.
 * Returns the signature in "ed25519:<hex>" format.
 * If the key is encrypted, passphrase is required.
 *
 * Signing requires the full identity — private key, public key, and
 * creator.json — to be present and mutually consistent. A partial or
 * mismatched set is rejected; nothing is ever signed with key material that
 * does not belong to the recorded creator_id.
 */
function signPayload(payload, identityDir = null, passphrase = null) {
  const dir = identityDir || defaultIdentityDir();
  const privateKeyPath = path.join(dir, PRIVATE_KEY_FILE);

  if (!fs.existsSync(privateKeyPath)) {
    throw new Error(
      `No private key found at ${privateKeyPath}. Run identity init first.`,
    );
  }

  const identity = loadIdentity(dir);
  if (!identity) {
    throw new Error(
      `No valid identity in ${dir}: creator.json is missing, so the private key is not part of a complete identity. Run identity init first.`,
    );
  }

  let privateKeyPem = fs.readFileSync(privateKeyPath, 'utf8');
  if (isEncryptedKey(privateKeyPem)) {
    if (!passphrase) throw new Error('Private key is encrypted. Provide --passphrase to sign.');
    privateKeyPem = decryptPrivateKey(privateKeyPem, passphrase);
  }

  let derivedPublicKey;
  try {
    derivedPublicKey = crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' });
  } catch {
    throw new Error(
      `Private key at ${privateKeyPath} is not a parseable private key — the identity is corrupt.`,
    );
  }
  if (derivedPublicKey !== identity.public_key) {
    throw new Error(
      `Private key in ${dir} does not match the public key recorded in creator.json — `
      + 'refusing to sign with a mismatched identity.',
    );
  }

  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const sig = crypto.sign(null, data, privateKeyPem);
  return `ed25519:${sig.toString('hex')}`;
}

/**
 * Sign a Human Lock payload.
 * If the key is encrypted, passphrase is required.
 */
function signHumanLock(cardId, statement, judgmentFingerprint, identityDir = null, passphrase = null) {
  const lockPayload = [cardId, statement, judgmentFingerprint].join('\n');
  return signPayload(lockPayload, identityDir, passphrase);
}

// ── Private Key Encryption ────────────────────────────────────────

function encryptPrivateKey(pem, passphrase) {
  const salt = crypto.randomBytes(ENVELOPE_SALT_BYTES);
  const key = crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, 32, 'sha256');
  const iv = crypto.randomBytes(ENVELOPE_IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(pem)), cipher.final()]);
  return JSON.stringify({
    encrypted: true,
    kdf: ENVELOPE_KDF,
    iterations: PBKDF2_ITERATIONS,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  });
}

/**
 * Strictly decode one base64 envelope field. Node's base64 decoder is
 * lenient — it silently drops characters outside the alphabet — so the
 * value is first checked against the strict alphabet/padding shape and then
 * round-tripped; anything the decoder would have mangled is rejected. When
 * `expectedBytes` is given, the decoded length must match exactly.
 */
function decodeEnvelopeField(value, name, expectedBytes) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid key envelope: ${name} must be a non-empty base64 string.`);
  }
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error(`Invalid key envelope: ${name} is not well-formed base64.`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new Error(`Invalid key envelope: ${name} is not canonical base64.`);
  }
  if (expectedBytes != null && decoded.length !== expectedBytes) {
    throw new Error(
      `Invalid key envelope: ${name} must decode to ${expectedBytes} bytes, got ${decoded.length}.`,
    );
  }
  return decoded;
}

/**
 * Decrypt a private key envelope produced by encryptPrivateKey().
 *
 * Every structural check runs BEFORE the expensive PBKDF2 derivation, so a
 * hostile or corrupt envelope is rejected cheaply: unknown KDF names,
 * out-of-range or non-integer iteration counts, malformed base64, wrong
 * field lengths, and oversized ciphertexts never reach the KDF or the
 * cipher. The envelope being self-describing is a compatibility mechanism,
 * not a trust decision — only the exact contract written by
 * encryptPrivateKey() (plus legacy iteration counts within the clamp) is
 * accepted.
 */
function decryptPrivateKey(envelope, passphrase) {
  let env = envelope;
  if (typeof envelope === 'string') {
    try {
      env = JSON.parse(envelope);
    } catch {
      throw new Error('Invalid key envelope: not valid JSON.');
    }
  }
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new Error('Invalid key envelope: expected a plain object.');
  }
  if (env.encrypted !== true) throw new Error('Private key is not encrypted');
  if (env.kdf !== ENVELOPE_KDF) {
    const seen = typeof env.kdf === 'string' ? `'${env.kdf}'` : typeof env.kdf;
    throw new Error(
      `Unsupported key envelope KDF: ${seen}. Only '${ENVELOPE_KDF}' is accepted.`,
    );
  }
  if (!Number.isSafeInteger(env.iterations)
      || env.iterations < PBKDF2_MIN_ITERATIONS
      || env.iterations > PBKDF2_MAX_ITERATIONS) {
    throw new Error(
      `Invalid key envelope: iterations must be a safe integer between ${PBKDF2_MIN_ITERATIONS} `
      + `and ${PBKDF2_MAX_ITERATIONS}, got ${String(env.iterations)}.`,
    );
  }
  const salt = decodeEnvelopeField(env.salt, 'salt', ENVELOPE_SALT_BYTES);
  const iv = decodeEnvelopeField(env.iv, 'iv', ENVELOPE_IV_BYTES);
  const tag = decodeEnvelopeField(env.tag, 'tag', ENVELOPE_TAG_BYTES);
  const ciphertext = decodeEnvelopeField(env.ciphertext, 'ciphertext', null);
  if (ciphertext.length === 0 || ciphertext.length > ENVELOPE_MAX_CIPHERTEXT_BYTES) {
    throw new Error(
      `Invalid key envelope: ciphertext must decode to between 1 and ${ENVELOPE_MAX_CIPHERTEXT_BYTES} bytes, `
      + `got ${ciphertext.length}.`,
    );
  }

  const key = crypto.pbkdf2Sync(passphrase, salt, env.iterations, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (e) {
    if (e.code === 'ERR_OSSL_EVP_BAD_DECRYPT' || e.message.includes('bad decrypt')) {
      throw new Error('Wrong passphrase — cannot decrypt private key.');
    }
    throw e;
  }
}

function isEncryptedKey(content) {
  try { const o = JSON.parse(content); return o.encrypted === true; }
  catch { return false; }
}

/**
 * Get the public key PEM for the creator identity.
 */
function loadPublicKey(identityDir = null) {
  const dir = identityDir || defaultIdentityDir();
  const publicKeyPath = path.join(dir, PUBLIC_KEY_FILE);
  if (!fs.existsSync(publicKeyPath)) return null;
  return fs.readFileSync(publicKeyPath, 'utf8');
}

/**
 * Get the private key path. Used by consumers that need direct key access.
 */
function privateKeyPath(identityDir = null) {
  return path.join(identityDir || defaultIdentityDir(), PRIVATE_KEY_FILE);
}

module.exports = {
  initIdentity,
  loadIdentity,
  signPayload,
  signHumanLock,
  creatorFingerprint,
  loadPublicKey,
  privateKeyPath,
  defaultIdentityDir,
  encryptPrivateKey,
  decryptPrivateKey,
  isEncryptedKey,
  CREATOR_ID_PREFIX,
};
