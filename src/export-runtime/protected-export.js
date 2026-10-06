'use strict';

// Narrow, single-file public entry for the protected export of an already
// packed container. This module is exported as
// '@aikdna/kdna-studio-core/protected-export' so consumers (the Studio CLI)
// can reach protectExportedContainer without the export-runtime file-map
// closure. The implementation below is moved verbatim from
// src/export-runtime/index.js; that module re-exports it unchanged.
const crypto = require('node:crypto');

// Password-protected export of an already packed container, on the Core R2
// protection surface. This replaces the retired inline path (B2): the file
// map produced by exportRuntimeAsset is packed by the caller first, then the
// whole container is protected here.
//
// Slots mirror d0 vector-05: a human password (argon2id) plus a
// studio-generated recovery code (scrypt-sha256). The consumer selects a
// slot positionally (slotIndex 0 = password, 1 = recovery) through Core's
// protected admission. The recovery code is returned exactly once; the
// caller (Studio application) owns display-once handling and must not store
// it. Core rejections keep their PROTECTION_* diagnostic codes verbatim on
// the thrown error's `code` and carry the original result on `core`.
const RECOVERY_CODE_PATTERN = /^kdna-recover-(?:[0-9A-F]{4}-){15}[0-9A-F]{4}$/;
const PROTECTED_EXPORT_SLOTS = Object.freeze([
  { slot: 'password', kdf_profile: 'argon2id' },
  { slot: 'recovery', kdf_profile: 'scrypt-sha256' },
]);

function generateRecoveryCode() {
  const hex = crypto.randomBytes(32).toString('hex').toUpperCase();
  return `kdna-recover-${hex.match(/.{4}/g).join('-')}`;
}

function protectedExportError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

async function protectExportedContainer(containerBytes, options = {}) {
  if (typeof options.password !== 'string' || options.password.length === 0) {
    throw protectedExportError(
      'PROTECTED_EXPORT_PASSWORD_REQUIRED',
      'protectExportedContainer requires a non-empty password string.',
    );
  }
  const recoveryCode = options.recoveryCode ?? generateRecoveryCode();
  if (typeof recoveryCode !== 'string' || !RECOVERY_CODE_PATTERN.test(recoveryCode)) {
    throw protectedExportError(
      'PROTECTED_EXPORT_RECOVERY_FORMAT',
      'recoveryCode must match the Studio recovery-code format ' +
      'kdna-recover-<16 groups of 4 uppercase hex digits>.',
    );
  }
  const { openSourceBytes } = require('@aikdna/kdna-core/authoring-node');
  const opened = openSourceBytes(containerBytes);
  if (opened.status !== 'accepted') {
    throw protectedExportError(
      'PROTECTED_EXPORT_SOURCE_INVALID',
      'protectExportedContainer requires an ordinary container that Core accepts.',
      { core: opened },
    );
  }
  const assetUid = options.asset_uid ?? opened.source.manifest.asset_uid;
  if (typeof assetUid !== 'string' || assetUid.length === 0) {
    throw protectedExportError(
      'PROTECTED_EXPORT_ASSET_UID_REQUIRED',
      'the packed manifest carries no asset_uid and no asset_uid option was supplied.',
    );
  }
  const { protectSourceBytes } = require('@aikdna/kdna-core/protection-node');
  const result = await protectSourceBytes(containerBytes, {
    kind: 'password',
    asset_uid: assetUid,
    entitlement: { profile: 'password', offline: true, revocable: false },
    slots: PROTECTED_EXPORT_SLOTS,
    checksums: true,
    signature: 'none',
  }, {
    passwords: [
      { slot: 'password', password: Buffer.from(options.password, 'utf8') },
      { slot: 'recovery', password: Buffer.from(recoveryCode, 'utf8') },
    ],
  });
  if (result.status !== 'produced') {
    const code = (result.diagnostic && result.diagnostic.code) || 'PROTECTED_EXPORT_REJECTED';
    throw protectedExportError(
      code,
      `protected export rejected: ${code}`,
      { core: result },
    );
  }
  return {
    status: 'produced',
    bytes: result.bytes,
    recoveryCode,
    evidence: result.evidence,
  };
}

module.exports = { protectExportedContainer };
