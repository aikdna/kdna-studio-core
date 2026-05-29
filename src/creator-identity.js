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
const DEFAULT_IDENTITY_DIR = path.join(os.homedir(), '.kdna', 'identity');
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
 * Returns the creator identity object. Does NOT overwrite existing keys.
 */
function initIdentity(displayName, identityDir = null) {
  const dir = identityDir || DEFAULT_IDENTITY_DIR;
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

  fs.writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
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
  };

  fs.writeFileSync(identityJsonPath, JSON.stringify(identity, null, 2), { mode: 0o644 });

  return identity;
}

/**
 * Load an existing creator identity from disk.
 * Returns null if no identity has been initialized.
 */
function loadIdentity(identityDir = null) {
  const dir = identityDir || DEFAULT_IDENTITY_DIR;
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
 */
function signPayload(payload, identityDir = null) {
  const dir = identityDir || DEFAULT_IDENTITY_DIR;
  const privateKeyPath = path.join(dir, PRIVATE_KEY_FILE);

  if (!fs.existsSync(privateKeyPath)) {
    throw new Error(
      `No private key found at ${privateKeyPath}. Run identity init first.`,
    );
  }

  const privateKeyPem = fs.readFileSync(privateKeyPath, 'utf8');
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const sig = crypto.sign(null, data, privateKeyPem);
  return `ed25519:${sig.toString('hex')}`;
}

/**
 * Sign a Human Lock payload — creates a deterministic signable string from
 * the lock context and returns the signature.
 *
 * Payload: `${cardId}\n${statement}\n${judgmentFingerprint}`
 */
function signHumanLock(cardId, statement, judgmentFingerprint, identityDir = null) {
  const lockPayload = [cardId, statement, judgmentFingerprint].join('\n');
  return signPayload(lockPayload, identityDir);
}

/**
 * Get the public key PEM for the creator identity.
 */
function loadPublicKey(identityDir = null) {
  const dir = identityDir || DEFAULT_IDENTITY_DIR;
  const publicKeyPath = path.join(dir, PUBLIC_KEY_FILE);
  if (!fs.existsSync(publicKeyPath)) return null;
  return fs.readFileSync(publicKeyPath, 'utf8');
}

/**
 * Get the private key path. Used by consumers that need direct key access.
 */
function privateKeyPath(identityDir = null) {
  return path.join(identityDir || DEFAULT_IDENTITY_DIR, PRIVATE_KEY_FILE);
}

module.exports = {
  initIdentity,
  loadIdentity,
  signPayload,
  signHumanLock,
  creatorFingerprint,
  loadPublicKey,
  privateKeyPath,
  CREATOR_ID_PREFIX,
  DEFAULT_IDENTITY_DIR,
};
