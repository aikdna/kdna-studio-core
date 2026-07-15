#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { readCurrentBinding } = require('./current-release-binding');
const { validateArtifact } = require('./release-evidence');
const { evaluateRegistryResult } = require('./registry-policy');

const REGISTRY = 'https://registry.npmjs.org/';

function publishArguments(artifactPath) {
  return [
    'publish',
    artifactPath,
    '--ignore-scripts',
    '--provenance',
    '--access',
    'public',
    `--registry=${REGISTRY}`,
  ];
}

function lookupArguments(spec) {
  return [
    'view',
    spec,
    'name',
    'version',
    'dist.integrity',
    'dist.shasum',
    '--json',
    '--loglevel=silent',
    `--registry=${REGISTRY}`,
  ];
}

function releaseDecision({ evidence, tarball, bindCurrent, lookup }) {
  bindCurrent(evidence);
  validateArtifact(evidence, tarball);
  const spec = `${evidence.package.name}@${evidence.package.version}`;
  return evaluateRegistryResult(lookup(lookupArguments(spec)), evidence);
}

function main() {
  const evidenceIndex = process.argv.indexOf('--evidence');
  const artifactIndex = process.argv.indexOf('--artifact');
  if (process.argv.length !== 6 || evidenceIndex < 0 || artifactIndex < 0) {
    throw new Error('usage: publish-verified-artifact.js --evidence <json> --artifact <tgz>');
  }
  const root = path.resolve(__dirname, '..');
  const evidencePath = path.resolve(process.argv[evidenceIndex + 1] || '');
  const artifactPath = path.resolve(process.argv[artifactIndex + 1] || '');
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const bindCurrent = (candidate) => readCurrentBinding({ root, evidence: candidate });
  const decision = releaseDecision({
    evidence,
    tarball: fs.readFileSync(artifactPath),
    bindCurrent,
    lookup: (args) =>
      spawnSync('npm', args, {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        shell: false,
        timeout: 30_000,
      }),
  });
  if (!decision.shouldPublish) {
    console.log(`Registry publication policy: ${decision.decision}`);
    return;
  }

  bindCurrent(evidence);
  validateArtifact(evidence, fs.readFileSync(artifactPath));
  const published = spawnSync('npm', publishArguments(artifactPath), {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    stdio: 'inherit',
  });
  if (published.error) throw new Error(`npm publish failed: ${published.error.message}`);
  if (published.status !== 0) throw new Error(`npm publish exited ${String(published.status)}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Verified artifact publication rejected: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { lookupArguments, publishArguments, releaseDecision };
