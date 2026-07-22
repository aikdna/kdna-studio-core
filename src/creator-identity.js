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
 *
 * Canonical identity = the three-file set {kdna.key, kdna.pub, creator.json}.
 * initIdentity publishes that set as one atomic directory transaction: the
 * files are written and fsynced inside a mode-0700 sibling staging directory,
 * and a single directory rename moves the staging directory onto the canonical
 * path. The canonical path therefore never holds a subset of the identity
 * files — a crash leaves either no identity or a complete one — and the first
 * rename to land wins, so concurrent inits cannot overwrite each other.
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
const IDENTITY_FILE_NAMES = new Set([PRIVATE_KEY_FILE, PUBLIC_KEY_FILE, IDENTITY_JSON_FILE]);

// Staging sibling directory naming. Only the identity transaction creates
// directories with this shape, and it writes no other file names into them,
// which is what makes a leftover staging directory provably transaction-owned.
const STAGING_DIR_PREFIX = '.kdna-init-';
const STAGING_DIR_SUFFIX = '.staging.d';
// A staging remnant is removed only when it is provably transaction-owned
// AND its owner process is provably dead. Age is never evidence of death:
// a remnant whose owner pid is still alive belongs to a live (concurrent or
// long-running) init and is left untouched no matter how old it is.

// PBKDF2 iteration count for newly written key envelopes. 600000 matches the
// OWASP recommendation for PBKDF2-HMAC-SHA256 and is supported by the
// pbkdf2Sync implementations of every supported runtime (Node 18, 22, 24;
// engines: >=18).
const PBKDF2_ITERATIONS = 600000;
// Historical envelopes were written at 100000 iterations. The envelope
// carries its own `iterations` value so those envelopes keep decrypting
// without any migration. That self-description is a compatibility mechanism
// for exactly the two counts that were ever written — it is not a license
// for arbitrary values: decryptPrivateKey() rejects every other iteration
// count before the KDF runs.
const PBKDF2_LEGACY_ITERATIONS = 100000;
const PBKDF2_ACCEPTED_ITERATIONS = new Set([PBKDF2_LEGACY_ITERATIONS, PBKDF2_ITERATIONS]);

const ENVELOPE_KDF = 'pbkdf2-sha256';
const ENVELOPE_SALT_BYTES = 16;
const ENVELOPE_IV_BYTES = 12; // AES-256-GCM nonce
const ENVELOPE_TAG_BYTES = 16; // GCM authentication tag
// A PKCS8 Ed25519 private key PEM is ~2 KB; encrypted envelopes an order of
// magnitude larger are never legitimate. The cap keeps hostile envelopes
// from forcing large buffer allocations and is enforced before the KDF runs.
const ENVELOPE_MAX_CIPHERTEXT_BYTES = 64 * 1024;

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
    if (error && (error.code === 'EISDIR' || error.code === 'EINVAL' || error.code === 'EPERM')) return;
    throw error;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}

/**
 * Write one identity file inside this transaction's own staging directory.
 * The staging directory is exclusively owned by this call, so a plain 'wx'
 * create plus fsync is sufficient; atomicity across the three files comes
 * from the directory rename that publishes them together.
 */
function writeStagedFileSync(stagingDir, name, data, mode) {
  const fd = fs.openSync(path.join(stagingDir, name), 'wx', mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function isStagingDirName(name) {
  return name.startsWith(STAGING_DIR_PREFIX) && name.endsWith(STAGING_DIR_SUFFIX);
}

function stagingOwnerPid(name) {
  const middle = name.slice(STAGING_DIR_PREFIX.length, -STAGING_DIR_SUFFIX.length);
  const pid = Number(middle.split('-')[0]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!(error && error.code === 'EPERM');
  }
}

/**
 * A staging remnant is provably transaction-owned — and therefore safe to
 * remove — only when it carries the transaction naming shape and contains
 * nothing but identity files. Anything else is user state and is left alone.
 */
function isProvableStagingRemnant(absolute) {
  let entries;
  try {
    entries = fs.readdirSync(absolute, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.every((entry) => entry.isFile() && IDENTITY_FILE_NAMES.has(entry.name));
}

/**
 * Remove stale staging remnants from interrupted transactions so they cannot
 * accumulate. A remnant is removed only when it is provably transaction-owned
 * AND its owner is provably dead: the owner pid encoded in the directory name
 * parses and no live process holds it. A live owner — a concurrent or simply
 * long-running init in another process — is never disturbed, regardless of
 * the remnant's age; a directory age threshold can never override the fact
 * that the owner is alive. Remnants whose owner pid does not parse, or whose
 * contents are not provably identity-transaction files, fail safe: they are
 * left alone rather than auto-deleted.
 */
function cleanupStaleStagingDirs(parentDir) {
  let entries;
  try {
    entries = fs.readdirSync(parentDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !isStagingDirName(entry.name)) continue;
    const absolute = path.join(parentDir, entry.name);
    const ownerPid = stagingOwnerPid(entry.name);
    if (ownerPid === null) continue;
    if (processAlive(ownerPid)) continue;
    if (isProvableStagingRemnant(absolute)) {
      fs.rmSync(absolute, { recursive: true, force: true });
    }
  }
}

/**
 * Compute the creator_id fingerprint from a normalized Ed25519 public key PEM.
 */
function creatorFingerprint(publicKeyPem) {
  const hash = crypto.createHash('sha256').update(publicKeyPem).digest('hex');
  return `${CREATOR_ID_PREFIX}${hash}`;
}

/**
 * Parse a PEM public key and return its canonical SPKI/PEM spelling, so two
 * spellings of the same key compare equal and non-Ed25519 or unparseable
 * material is rejected instead of hashed.
 */
function normalizePublicKey(pem, source) {
  let key;
  try {
    key = crypto.createPublicKey(pem);
  } catch {
    throw new Error(`Public key from ${source} is not a parseable PEM public key — the identity is corrupt.`);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `Public key from ${source} is ${key.asymmetricKeyType}, not ed25519 — the identity is corrupt.`,
    );
  }
  return key.export({ type: 'spki', format: 'pem' });
}

function derivePublicKeyFromPrivate(privateKeyPem) {
  const key = crypto.createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('not an ed25519 private key');
  }
  return crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' });
}

const IDENTITY_ALREADY_EXISTS = 'IDENTITY_ALREADY_EXISTS';
const IDENTITY_INCOMPLETE = 'IDENTITY_INCOMPLETE';
const IDENTITY_CORRUPT = 'IDENTITY_CORRUPT';

// Stable machine-readable result codes for post-commit failures:
// the atomic rename already published the complete identity, but the
// parent-directory fsync that would confirm durability failed. This is NOT an
// initialization failure and must never be reported as one — the identity
// exists on disk, must not be deleted or rolled back, and a retry will (and
// should) report that the identity already exists.
const IDENTITY_COMMITTED_DURABILITY_UNCONFIRMED = 'IDENTITY_COMMITTED_DURABILITY_UNCONFIRMED';
const IDENTITY_COMMITTED_INCONSISTENT = 'IDENTITY_COMMITTED_INCONSISTENT';

function identityStateError(code, message, fields = {}, cause = null) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  Object.assign(error, fields);
  return error;
}

/**
 * Build the error for a post-commit parent-directory fsync failure. The
 * committed identity is re-verified through the full three-file consistency
 * checks before the error claims it, so the machine-readable committed state
 * is only ever attached to an identity that actually loads. The error carries
 * public diagnostic fields only — never any private key material.
 */
function committedDurabilityError(dir, cause) {
  let loaded;
  try {
    loaded = loadIdentity(dir);
  } catch (verificationError) {
    const causeCode = cause && cause.code ? cause.code : 'unknown error';
    return identityStateError(
      IDENTITY_COMMITTED_INCONSISTENT,
      `Identity files were committed in ${dir}, but the identity failed consistency verification after `
      + `the commit and parent-directory durability confirmation also failed (${causeCode}). `
      + 'Do not sign with or otherwise use this identity. Preserve the directory without changing or '
      + 'deleting it, restrict access to it, and recover from a trusted backup or have an administrator '
      + 'inspect all three files before any further use. Do not re-run identity initialization.',
      {
        committed: true,
        identityVerified: false,
        durabilityConfirmed: false,
        identity_dir: dir,
      },
      verificationError,
    );
  }
  const causeCode = cause && cause.code ? cause.code : 'unknown error';
  return identityStateError(
    IDENTITY_COMMITTED_DURABILITY_UNCONFIRMED,
    `Identity in ${dir} is committed: the atomic rename published the complete three-file identity`
    + ` (creator_id ${loaded.creator_id}) and it passed the three-file consistency verification`
    + `, but confirming durability of the parent directory failed (${causeCode}). `
    + 'The identity is on disk — do not treat this as "nothing was created", '
    + 'do not delete the files, and do not retry as a fresh initialization; '
    + 'use loadIdentity() to access the identity.',
    {
      committed: true,
      identityVerified: true,
      durabilityConfirmed: false,
      identity_dir: dir,
      creator_id: loaded.creator_id,
    },
    cause,
  );
}

function readCanonicalState(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { exists: false, notDirectory: false, entries: [], identityFiles: [] };
    }
    if (error && error.code === 'ENOTDIR') {
      return { exists: true, notDirectory: true, entries: [], identityFiles: [] };
    }
    throw error;
  }
  return {
    exists: true,
    notDirectory: false,
    entries,
    identityFiles: entries.filter((name) => IDENTITY_FILE_NAMES.has(name)),
  };
}

function hasIdentityFiles(dir) {
  try {
    return fs.readdirSync(dir).some((name) => IDENTITY_FILE_NAMES.has(name));
  } catch {
    return false;
  }
}

/**
 * Classify existing canonical identity files using stable machine-readable
 * codes. Only an exact three-file set that passes loadIdentity may be called
 * an existing identity. Partial state is incomplete; a present three-file set
 * that fails verification is corrupt. No classification path modifies disk.
 */
function existingIdentityStateError(dir, state = readCanonicalState(dir)) {
  const present = state.identityFiles.slice().sort();
  if (present.length !== IDENTITY_FILE_NAMES.size) {
    return identityStateError(
      IDENTITY_INCOMPLETE,
      `Identity in ${dir} is incomplete: found ${present.join(', ') || 'no canonical identity files'}, `
      + `but a valid identity requires ${PRIVATE_KEY_FILE}, ${PUBLIC_KEY_FILE}, and ${IDENTITY_JSON_FILE}. `
      + 'The existing files were not changed or removed.',
      { identityVerified: false, identity_dir: dir },
    );
  }

  try {
    const identity = loadIdentity(dir);
    if (!identity) {
      return identityStateError(
        IDENTITY_CORRUPT,
        `Identity in ${dir} has all three canonical files but could not be verified. `
        + 'The existing files were not changed or removed.',
        { identityVerified: false, identity_dir: dir },
      );
    }
    return identityStateError(
      IDENTITY_ALREADY_EXISTS,
      `Identity already exists in ${dir} and passed consistency verification. `
      + 'Use loadIdentity() to access it; initialization never overwrites it.',
      {
        identityVerified: true,
        identity_dir: dir,
        creator_id: identity.creator_id,
      },
    );
  } catch (cause) {
    return identityStateError(
      IDENTITY_CORRUPT,
      `Identity in ${dir} has all three canonical files but failed consistency verification. `
      + 'The existing files were not changed or removed; preserve them and recover manually.',
      { identityVerified: false, identity_dir: dir },
      cause,
    );
  }
}

/**
 * Publish the staging directory onto the canonical identity path with one
 * atomic directory rename. A rename never replaces a non-empty directory, so
 * the first transaction to land wins and every concurrent loser fails instead
 * of overwriting the winner. An empty placeholder directory (e.g. created by
 * the caller beforehand) is removed first; a crash between that removal and
 * the rename leaves no identity at all, which the next init handles normally.
 *
 * The rename is the logical commit point. A failure before the rename leaves
 * the canonical path without identity files, so init fails as an ordinary,
 * safely retryable error. A failure of the parent-directory fsync AFTER the
 * rename is a different result, not a failure: the identity is committed on
 * disk, so it is reported as a committed-but-durability-unconfirmed state
 * (see committedDurabilityError) and is never deleted or rolled back.
 */
function publishStagingDir(stagingDir, targetDir) {
  const state = readCanonicalState(targetDir);
  if (state.notDirectory) {
    throw new Error(`Identity path ${targetDir} exists and is not a directory — refusing to publish.`);
  }
  if (state.identityFiles.length > 0) throw existingIdentityStateError(targetDir, state);
  if (state.entries.length > 0) {
    throw new Error(
      `Identity directory ${targetDir} is not empty and holds no identity files. The identity is `
      + 'published as one atomic directory, so init refuses to merge into a directory with foreign files.',
    );
  }
  if (state.exists) {
    try {
      fs.rmdirSync(targetDir);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        if (hasIdentityFiles(targetDir)) throw existingIdentityStateError(targetDir);
        throw error;
      }
    }
  }
  try {
    fs.renameSync(stagingDir, targetDir);
  } catch (error) {
    if (error && ['ENOTEMPTY', 'EEXIST', 'EPERM', 'ENOTDIR'].includes(error.code)
        && hasIdentityFiles(targetDir)) {
      throw existingIdentityStateError(targetDir);
    }
    throw error;
  }
  try {
    fsyncDirectorySync(path.dirname(targetDir));
  } catch (error) {
    throw committedDurabilityError(targetDir, error);
  }
}

/**
 * Generate a new Ed25519 keypair and persist to identityDir.
 * If passphrase is provided, the private key is encrypted with AES-256-GCM
 * (key derived via PBKDF2-SHA256). Without passphrase, plaintext with 0o600.
 *
 * The three identity files commit as one transaction: they are written and
 * fsynced inside a mode-0700 sibling staging directory, the staging directory
 * is fsynced, and a single atomic directory rename publishes the set onto the
 * canonical path. The rename is the logical commit point: before it the
 * canonical path holds none of the identity files and any failure is an
 * ordinary, safely retryable init error; after it the identity exists. If the
 * post-commit parent-directory fsync fails, initIdentity throws a
 * machine-readable committed result (code
 * IDENTITY_COMMITTED_DURABILITY_UNCONFIRMED, committed: true) — the identity
 * is on disk and re-verified, only its durability confirmation failed; it is
 * never deleted or rolled back. A process killed at any point leaves either
 * a complete, mutually consistent identity or no valid identity, and the
 * next init recovers without manual cleanup: provable staging remnants of
 * provably dead owner processes are removed, live owners are never disturbed
 * regardless of remnant age, and anything not provably owned by the
 * transaction is never touched. An existing identity is never overwritten —
 * the rename fails rather than replacing a non-empty directory, so a racing
 * init cannot clobber a winner.
 */
function initIdentity(displayName, identityDir = null, passphrase = null) {
  const dir = identityDir || defaultIdentityDir();
  const parentDir = path.dirname(dir);
  fs.mkdirSync(parentDir, { recursive: true });
  cleanupStaleStagingDirs(parentDir);

  // Advisory pre-checks for clear messages. The authoritative no-clobber
  // guarantee is the atomic publish: the canonical directory is only ever
  // created by the rename, and the rename never replaces a non-empty target.
  const state = readCanonicalState(dir);
  if (state.notDirectory) {
    const error = new Error(`Identity path ${dir} exists and is not a directory — refusing to initialize.`);
    error.code = 'ENOTDIR';
    throw error;
  }
  if (state.identityFiles.length > 0) {
    throw existingIdentityStateError(dir, state);
  }
  if (state.entries.length > 0) {
    throw new Error(
      `Identity directory ${dir} is not empty and holds no identity files. The identity is `
      + 'published as one atomic directory, so init refuses to merge into a directory with foreign files.',
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
    public_key_path: path.join(dir, PUBLIC_KEY_FILE),
    identity_dir: dir,
    created_at: new Date().toISOString(),
    verified: false,
    encrypted: !!passphrase,
  };
  const identityJson = JSON.stringify(identity, null, 2);

  const stagingName = `${STAGING_DIR_PREFIX}${process.pid}-${Date.now().toString(36)}-`
    + `${crypto.randomBytes(6).toString('hex')}${STAGING_DIR_SUFFIX}`;
  const stagingDir = path.join(parentDir, stagingName);
  fs.mkdirSync(stagingDir, { mode: 0o700 });
  try {
    writeStagedFileSync(stagingDir, PRIVATE_KEY_FILE, privateKeyData, 0o600);
    writeStagedFileSync(stagingDir, PUBLIC_KEY_FILE, publicKey, 0o644);
    // creator.json is written last inside staging, but the commit point is
    // the rename: all three files become visible together, or none do.
    writeStagedFileSync(stagingDir, IDENTITY_JSON_FILE, identityJson, 0o644);
    fsyncDirectorySync(stagingDir);
    publishStagingDir(stagingDir, dir);
  } finally {
    // After a successful publish the staging path no longer exists (it was
    // renamed); this removes only this transaction's own staging copy after
    // a failure. It never touches the canonical directory or another
    // transaction's staging.
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  return identity;
}

/**
 * Load an existing creator identity from disk.
 * Returns null only when no creator.json exists. Anything else that is not a
 * complete, mutually consistent three-file identity — missing kdna.pub or
 * kdna.key, unparseable creator.json, a creator.json public key that differs
 * from kdna.pub, a creator_id that does not match the normalized kdna.pub
 * fingerprint, or a plaintext private key that derives a different public
 * key — is rejected with an error instead of being silently loaded or
 * silently treated as "no identity".
 */
function loadIdentity(identityDir = null) {
  const dir = identityDir || defaultIdentityDir();
  const identityJsonPath = path.join(dir, IDENTITY_JSON_FILE);
  const publicKeyPath = path.join(dir, PUBLIC_KEY_FILE);
  const privateKeyFilePath = path.join(dir, PRIVATE_KEY_FILE);

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

  if (!fs.existsSync(publicKeyPath)) {
    throw new Error(
      `Identity in ${dir} is incomplete: ${PUBLIC_KEY_FILE} is missing. The canonical identity `
      + `requires ${PRIVATE_KEY_FILE}, ${PUBLIC_KEY_FILE}, and ${IDENTITY_JSON_FILE}.`,
    );
  }
  if (!fs.existsSync(privateKeyFilePath)) {
    throw new Error(
      `Identity in ${dir} is incomplete: ${PRIVATE_KEY_FILE} is missing. The canonical identity `
      + `requires ${PRIVATE_KEY_FILE}, ${PUBLIC_KEY_FILE}, and ${IDENTITY_JSON_FILE}.`,
    );
  }

  const diskPublicKey = normalizePublicKey(
    fs.readFileSync(publicKeyPath, 'utf8'), `${PUBLIC_KEY_FILE} in ${dir}`,
  );

  // creator.json may carry the public key, but it must be the same Ed25519
  // key as kdna.pub — the directory may never present two different keys.
  if (typeof identity.public_key === 'string' && identity.public_key) {
    const jsonPublicKey = normalizePublicKey(identity.public_key, `public_key in ${dir}/creator.json`);
    if (jsonPublicKey !== diskPublicKey) {
      throw new Error(
        `public_key in ${dir}/creator.json is not the same Ed25519 public key as ${PUBLIC_KEY_FILE} — `
        + 'refusing to load an inconsistent identity.',
      );
    }
  }

  const expectedId = creatorFingerprint(diskPublicKey);
  if (identity.creator_id !== expectedId) {
    throw new Error(
      `creator_id in ${dir}/creator.json does not match the public key fingerprint `
      + `(expected ${expectedId}, found ${identity.creator_id}) — refusing to load a mismatched identity.`,
    );
  }

  // A plaintext private key is checked against the public key eagerly; an
  // encrypted envelope can only be verified by signPayload after decryption.
  const privateKeyContent = fs.readFileSync(privateKeyFilePath, 'utf8');
  if (!isEncryptedKey(privateKeyContent)) {
    let derived;
    try {
      derived = derivePublicKeyFromPrivate(privateKeyContent);
    } catch {
      throw new Error(
        `Private key at ${privateKeyFilePath} is not a parseable ed25519 private key — the identity is corrupt.`,
      );
    }
    if (derived !== diskPublicKey) {
      throw new Error(
        `Private key in ${dir} does not match the public key in ${PUBLIC_KEY_FILE} — `
        + 'refusing to load a mismatched identity.',
      );
    }
  }

  identity.public_key = diskPublicKey;
  identity.identity_dir = dir;
  identity.public_key_path = publicKeyPath;

  return identity;
}

/**
 * Sign a payload with the creator's Ed25519 private key.
 * Returns the signature in "ed25519:<hex>" format.
 * If the key is encrypted, passphrase is required.
 *
 * Signing requires the full canonical identity and proves four-way
 * consistency before any signature is produced: the public key derived from
 * the private key, kdna.pub, creator.json's public key, and the creator_id
 * fingerprint must all be the same Ed25519 key. Nothing is ever signed with
 * key material that does not belong to the recorded creator_id.
 */
function signPayload(payload, identityDir = null, passphrase = null) {
  const dir = identityDir || defaultIdentityDir();
  const privateKeyFilePath = path.join(dir, PRIVATE_KEY_FILE);

  if (!fs.existsSync(privateKeyFilePath)) {
    throw new Error(
      `No private key found at ${privateKeyFilePath}. Run identity init first.`,
    );
  }

  const identity = loadIdentity(dir);
  if (!identity) {
    throw new Error(
      `No valid identity in ${dir}: creator.json is missing, so the private key is not part of a complete identity. Run identity init first.`,
    );
  }

  let privateKeyPem = fs.readFileSync(privateKeyFilePath, 'utf8');
  if (isEncryptedKey(privateKeyPem)) {
    if (!passphrase) throw new Error('Private key is encrypted. Provide --passphrase to sign.');
    privateKeyPem = decryptPrivateKey(privateKeyPem, passphrase);
  }

  let derivedPublicKey;
  try {
    derivedPublicKey = derivePublicKeyFromPrivate(privateKeyPem);
  } catch {
    throw new Error(
      `Private key at ${privateKeyFilePath} is not a parseable ed25519 private key — the identity is corrupt.`,
    );
  }
  if (derivedPublicKey !== identity.public_key) {
    throw new Error(
      `Private key in ${dir} does not match the public key recorded in the identity — `
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
 * iteration counts outside the accepted set, malformed base64, wrong field
 * lengths, and oversized ciphertexts never reach the KDF or the cipher.
 * The envelope being self-describing is a compatibility mechanism, not a
 * trust decision — only the exact contract written by encryptPrivateKey()
 * (600000 iterations) and the historical 100000-iteration envelopes are
 * accepted. Any other iteration count is rejected.
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
  if (!Number.isSafeInteger(env.iterations) || !PBKDF2_ACCEPTED_ITERATIONS.has(env.iterations)) {
    throw new Error(
      `Invalid key envelope: iterations must be exactly ${PBKDF2_LEGACY_ITERATIONS} (legacy) or `
      + `${PBKDF2_ITERATIONS} (current), got ${String(env.iterations)}.`,
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
 * Returns null only when the directory holds no identity files at all. The
 * key is never read straight off disk: it is returned only after the full
 * three-file consistency verification in loadIdentity, so a partial,
 * replaced, or cross-copied public key is rejected instead of served.
 */
function loadPublicKey(identityDir = null) {
  const dir = identityDir || defaultIdentityDir();
  const anyIdentityFile = [PRIVATE_KEY_FILE, PUBLIC_KEY_FILE, IDENTITY_JSON_FILE]
    .some((name) => fs.existsSync(path.join(dir, name)));
  if (!anyIdentityFile) return null;
  const identity = loadIdentity(dir);
  if (!identity) {
    throw new Error(
      `Identity in ${dir} is incomplete: ${IDENTITY_JSON_FILE} is missing, so ${PUBLIC_KEY_FILE} `
      + 'is not part of a verified identity — refusing to return it.',
    );
  }
  return identity.public_key;
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
  IDENTITY_ALREADY_EXISTS,
  IDENTITY_INCOMPLETE,
  IDENTITY_CORRUPT,
  IDENTITY_COMMITTED_DURABILITY_UNCONFIRMED,
  IDENTITY_COMMITTED_INCONSISTENT,
};
