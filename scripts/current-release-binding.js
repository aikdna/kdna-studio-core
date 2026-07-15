'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { validateEvidence } = require('./release-evidence');
const { validateReleaseContext } = require('./release-policy');

function validateCurrentBinding({ evidence: rawEvidence, pkg, changelog, env, git }) {
  const evidence = validateEvidence(rawEvidence);
  const context = validateReleaseContext({ pkg, changelog, env, git });
  if (evidence.package.name !== context.name) throw new Error('release evidence name is stale');
  if (evidence.package.version !== context.version) throw new Error('release evidence version is stale');
  if (evidence.source.ref !== context.ref) throw new Error('release evidence ref is stale');
  if (evidence.source.commit !== context.commit) throw new Error('release evidence commit is stale');
  return evidence;
}

function readCurrentBinding({ root, evidence, env = process.env }) {
  function git(args) {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const tag = pkg.version;
  return validateCurrentBinding({
    evidence,
    pkg,
    changelog,
    env,
    git: {
      status: git(['status', '--porcelain', '--untracked-files=all']),
      head: git(['rev-parse', 'HEAD']),
      tagCommit: git(['rev-parse', `${tag}^{commit}`]),
    },
  });
}

module.exports = { readCurrentBinding, validateCurrentBinding };
