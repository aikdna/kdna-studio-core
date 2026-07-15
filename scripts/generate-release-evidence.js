#!/usr/bin/env node
'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validatePackReport } = require('./release-evidence');

const root = path.resolve(__dirname, '..');

function fail(message) {
  throw new Error(message);
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function main() {
  const outIndex = process.argv.indexOf('--out');
  const artifactIndex = process.argv.indexOf('--artifact');
  if (process.argv.length !== 6 || outIndex < 0 || artifactIndex < 0) {
    fail('usage: generate-release-evidence.js --out <evidence> --artifact <tarball>');
  }
  const output = path.resolve(process.argv[outIndex + 1] || '');
  const artifact = path.resolve(process.argv[artifactIndex + 1] || '');
  for (const destination of [output, artifact]) {
    const relative = path.relative(root, destination);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      fail('release outputs must be outside the repository');
    }
  }
  if (output === artifact) fail('release evidence and artifact paths must differ');
  if (git(['status', '--porcelain', '--untracked-files=all'])) fail('worktree must be clean');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const commit = git(['rev-parse', 'HEAD']);
  if (process.env.GITHUB_SHA !== commit) fail('GITHUB_SHA must equal the packed commit');
  if (git(['rev-parse', `${pkg.version}^{commit}`]) !== commit) fail('release tag must resolve to the packed commit');

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-studio-core-pack-'));
  let complete = false;
  let artifactCreated = false;
  let evidenceCreated = false;
  try {
    const packed = spawnSync(
      'npm',
      ['pack', '--json', '--ignore-scripts', '--pack-destination', temp],
      { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, shell: false },
    );
    if (packed.error) fail(`npm pack failed: ${packed.error.message}`);
    if (packed.status !== 0) fail(`npm pack exited ${String(packed.status)}: ${(packed.stderr || '').trim()}`);
    let reports;
    try {
      reports = JSON.parse(packed.stdout);
    } catch {
      fail('npm pack output was not valid JSON');
    }
    if (!Array.isArray(reports) || reports.length !== 1 || !reports[0].filename) fail('npm pack did not report one filename');
    const sourceArtifact = path.join(temp, reports[0].filename);
    const bytes = fs.readFileSync(sourceArtifact);
    const evidence = validatePackReport({
      reportText: packed.stdout,
      tarball: bytes,
      pkg,
      source: { ref: process.env.GITHUB_REF, commit },
    });
    fs.copyFileSync(sourceArtifact, artifact, fs.constants.COPYFILE_EXCL);
    artifactCreated = true;
    fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    evidenceCreated = true;
    if (!fs.readFileSync(artifact).equals(bytes)) fail('retained artifact differs from npm pack');
    if (git(['status', '--porcelain', '--untracked-files=all'])) fail('npm pack changed the repository');
    complete = true;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    if (!complete) {
      if (evidenceCreated) fs.rmSync(output, { force: true });
      if (artifactCreated) fs.rmSync(artifact, { force: true });
    }
  }
  console.log(`Release evidence written to ${output}; verified artifact retained at ${artifact}`);
}

try {
  main();
} catch (error) {
  console.error(`Release evidence rejected: ${error.message}`);
  process.exitCode = 1;
}
