/**
 * Creator Identity — local Ed25519 keypair generation, loading, and signing.
 *
 * Creator IDs use the format: "kdna:creator:ed25519:<sha256-of-public-key>"
 * Private keys are stored in ~/.kdna/identity/ by default.
 *
 * This is local-first — no registration, no upload, no cloud dependency.
 * The private key is the root of creator identity; the public key fingerprint
 * is the creator_id that appears in studio.project.json and exported .kdna assets.
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

/**
 * Compute the creator_id fingerprint from an Ed25519 public key PEM.
 */
function creatorFingerprint(publicKeyPem) {
  const hash = crypto.createHash('sha256').update(publicKeyPem).digest('hex');
  return `${CREATOR_ID_PREFIX}${hash}`;
}

/**
 * Generate a new Ed25519 keypair and persist to identityDir.
 * If passphrase is provided, the private key is encrypted with AES-256-GCM
 * (key derived via PBKDF2-SHA256). Without passphrase, plaintext with 0o600.
 */
function initIdentity(displayName, identityDir = null, passphrase = null) {
  const dir = identityDir || defaultIdentityDir();
  fs.mkdirSync(dir, { recursive: true });

  const privateKeyPath = path.join(dir, PRIVATE_KEY_FILE);
  const publicKeyPath = path.join(dir, PUBLIC_KEY_FILE);
  const identityJsonPath = path.join(dir, IDENTITY_JSON_FILE);

  if (fs.existsSync(privateKeyPath) || fs.existsSync(publicKeyPath)) {
    throw new Error(
      `Identity keys already exist in ${dir}. Use loadIdentity() to access them, or remove the files to regenerate.`,
    );
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const privateKeyData = passphrase
    ? encryptPrivateKey(privateKey, passphrase)
    : privateKey;

  fs.writeFileSync(privateKeyPath, privateKeyData, { mode: 0o600 });
  fs.writeFileSync(publicKeyPath, publicKey, { mode: 0o644 });

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

  fs.writeFileSync(identityJsonPath, JSON.stringify(identity, null, 2), { mode: 0o644 });

  return identity;
}

/**
 * Load an existing creator identity from disk.
 * Returns null if no identity has been initialized.
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
    return null;
  }

  // Ensure public key is loaded (may have been deleted from JSON for security)
  if (!identity.public_key && fs.existsSync(publicKeyPath)) {
    identity.public_key = fs.readFileSync(publicKeyPath, 'utf8');
  }

  identity.identity_dir = dir;
  identity.public_key_path = publicKeyPath;

  return identity;
}

/**
 * Sign a payload with the creator's Ed25519 private key.
 * Returns the signature in "ed25519:<hex>" format.
 * If the key is encrypted, passphrase is required.
 */
function signPayload(payload, identityDir = null, passphrase = null) {
  const dir = identityDir || defaultIdentityDir();
  const privateKeyPath = path.join(dir, PRIVATE_KEY_FILE);

  if (!fs.existsSync(privateKeyPath)) {
    throw new Error(
      `No private key found at ${privateKeyPath}. Run identity init first.`,
    );
  }

  let privateKeyPem = fs.readFileSync(privateKeyPath, 'utf8');
  if (isEncryptedKey(privateKeyPem)) {
    if (!passphrase) throw new Error('Private key is encrypted. Provide --passphrase to sign.');
    privateKeyPem = decryptPrivateKey(privateKeyPem, passphrase);
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
  const salt = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(pem)), cipher.final()]);
  return JSON.stringify({
    encrypted: true,
    kdf: 'pbkdf2-sha256',
    iterations: 100000,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  });
}

function decryptPrivateKey(envelope, passphrase) {
  const env = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
  if (!env.encrypted) throw new Error('Private key is not encrypted');
  const key = crypto.pbkdf2Sync(passphrase, Buffer.from(env.salt, 'base64'), env.iterations, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(env.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  } catch (e) {
    if (e.code === 'ERR_OSSL_EVP_BAD_DECRYPT' || e.message.includes('bad decrypt')) {
      throw new Error('Wrong passphrase — cannot decrypt private key.');
    }
    throw e;
  }
}

// (original function body replaced above)
function __unused_decryptPrivateKey_original(envelope, passphrase) {
  const env = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
  if (!env.encrypted) throw new Error('Private key is not encrypted');
  const key = crypto.pbkdf2Sync(passphrase, Buffer.from(env.salt, 'base64'), env.iterations, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(env.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function isEncryptedKey(content) {
  try { const o = JSON.parse(content); return o.encrypted === true; }
  catch { return false; }
}

// ── Key Rotation ────────────────────────────────────────────────

/**
 * Rotate the creator's private key. Generates a new Ed25519 keypair,
 * signs the rotation event with the old key, and saves both.
 * The old public key is recorded in creator.json under previous_keys.
 */
function rotateIdentity(passphrase = null, identityDir = null) {
  const identity = loadIdentity(identityDir);
  if (!identity) throw new Error('No identity found. Run identity init first.');

  const dir = identityDir || defaultIdentityDir();
  const oldPrivPath = path.join(dir, PRIVATE_KEY_FILE);
  const oldPubPath = path.join(dir, PUBLIC_KEY_FILE);

  if (!fs.existsSync(oldPrivPath) || !fs.existsSync(oldPubPath)) {
    throw new Error('Key files not found for rotation.');
  }

  // Decrypt old key if needed
  let oldPrivatePem = fs.readFileSync(oldPrivPath, 'utf8');
  if (isEncryptedKey(oldPrivatePem)) {
    if (!passphrase) throw new Error('Private key is encrypted. Provide passphrase to rotate.');
    oldPrivatePem = decryptPrivateKey(oldPrivatePem, passphrase);
  }

  // Generate new keypair
  const { publicKey: newPub, privateKey: newPriv } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Sign rotation event with old key
  const rotationPayload = [
    identity.creator_id,
    creatorFingerprint(newPub),
    new Date().toISOString(),
  ].join('\n');
  const rotationSig = `ed25519:${crypto.sign(null, Buffer.from(rotationPayload), oldPrivatePem).toString('hex')}`;

  // Save new keypair
  const newPrivData = passphrase ? encryptPrivateKey(newPriv, passphrase) : newPriv;
  fs.writeFileSync(oldPrivPath, newPrivData, { mode: 0o600 });
  fs.writeFileSync(oldPubPath, newPub, { mode: 0o644 });

  // Update identity record
  const newCreatorId = creatorFingerprint(newPub);
  const identityJson = path.join(dir, IDENTITY_JSON_FILE);
  let idData = {};
  try { idData = JSON.parse(fs.readFileSync(identityJson, 'utf8')); } catch {}

  const previousKeys = idData.previous_keys || [];
  previousKeys.push({
    creator_id: identity.creator_id,
    public_key: identity.public_key,
    rotated_at: new Date().toISOString(),
    rotation_signature: rotationSig,
  });

  idData.creator_id = newCreatorId;
  idData.public_key = newPub;
  idData.rotated_at = new Date().toISOString();
  idData.encrypted = !!passphrase;
  idData.previous_keys = previousKeys;

  fs.writeFileSync(identityJson, JSON.stringify(idData, null, 2), { mode: 0o644 });

  return { ...idData, creator_id: newCreatorId };
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
