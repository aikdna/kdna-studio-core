'use strict';

// Live staging-owner fixture for tests/creator-identity.test.js. Not a test.
//
// Usage: node tests/identity-staging-holder-child.js <parentDir>
//
// Creates a staging directory shaped exactly like an interrupted identity
// transaction owned by THIS process (its pid is encoded in the name), writes
// a provable subset of staged identity files into it, signals readiness via a
// marker file, and then stays alive. The parent test proves that another
// process's initIdentity never reclaims this staging while the owner lives —
// no matter how old the directory is made to look — and that it is reclaimed
// once the owner is dead.

const fs = require('fs');
const path = require('path');

const parentDir = process.argv[2];
if (!parentDir) {
  process.stderr.write('usage: identity-staging-holder-child.js <parentDir>\n');
  process.exit(2);
}

const stagingName = `.kdna-init-${process.pid}-hold${Date.now().toString(36)}.staging.d`;
const stagingDir = path.join(parentDir, stagingName);
fs.mkdirSync(stagingDir, { mode: 0o700 });
// A provable transaction remnant: only identity-file names, a subset of the
// canonical three-file set.
fs.writeFileSync(path.join(stagingDir, 'kdna.key'), 'held-private-key-placeholder', { mode: 0o600 });
fs.writeFileSync(path.join(stagingDir, 'kdna.pub'), 'held-public-key-placeholder', { mode: 0o644 });
fs.writeFileSync(path.join(parentDir, '.holder-ready'), stagingName, { mode: 0o644 });

// Stay alive until the parent kills us.
setInterval(() => {}, 1 << 30);
