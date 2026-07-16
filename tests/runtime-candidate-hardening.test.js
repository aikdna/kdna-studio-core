'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const {
  acquire,
  destinationFromArguments,
} = require('../scripts/acquire-trusted-npm-release');
const {
  BINDING_PATH,
  resolveTrustedNpmInvocation,
  strictRegistryLookup,
  verifyCandidateBinding,
  verifyInstalledAikdnaGraph,
} = require('../scripts/runtime-candidate-binding');
const {
  CANDIDATE_AUTHORITIES,
  CANDIDATE_WORKFLOW_PATH,
} = require('../scripts/runtime-candidate-authority');
const {
  assertCleanPinnedRepository,
  extractCommitPackage,
  packOnce,
} = require('../scripts/verify-runtime-candidate-sources');
const {
  trustedTarballPath,
  verifyTrustedNpmTarball,
} = require('../scripts/trusted-npm-release');

const ROOT = path.resolve(__dirname, '..');
const CORE = '@aikdna/kdna-core';

function copyAuthorityRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-core-candidate-hardening-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = [
    'package.json',
    'package-lock.json',
    BINDING_PATH,
    CANDIDATE_WORKFLOW_PATH,
    ...CANDIDATE_AUTHORITIES.map((authority) => authority.evidencePath),
  ];
  const binding = JSON.parse(fs.readFileSync(path.join(ROOT, BINDING_PATH), 'utf8'));
  files.push(...binding.packages.map((entry) => entry.artifact));
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
  }
  return root;
}

function mutateJson(root, relativePath, mutation) {
  const target = path.join(root, relativePath);
  const value = JSON.parse(fs.readFileSync(target, 'utf8'));
  mutation(value);
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function writeInstalledPackage(root, installPath, name, version) {
  const directory = path.join(root, 'node_modules', ...installPath.split('/'));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    `${JSON.stringify({ name, version }, null, 2)}\n`,
  );
  return directory;
}

function git(repository, args) {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8', shell: false });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function createSourceRepository(t, packageJson = { name: CORE, version: '0.19.0' }) {
  const repository = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studio-core-source-repo-'));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  git(repository, ['init', '--quiet']);
  git(repository, ['config', 'user.name', 'KDNA Test']);
  git(repository, ['config', 'user.email', 'test@example.invalid']);
  const source = path.join(repository, 'packages', 'kdna-core');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  fs.writeFileSync(path.join(source, 'index.js'), "'use strict';\nmodule.exports = true;\n");
  git(repository, ['add', '.']);
  git(repository, ['commit', '--quiet', '-m', 'fixture']);
  return { repository, source, commit: git(repository, ['rev-parse', 'HEAD']) };
}

test('static graph rejects the reproduced npm alias even when locked.name is omitted', (t) => {
  const root = copyAuthorityRoot(t);
  mutateJson(root, 'package.json', (pkg) => {
    pkg.dependencies['shadow-core'] = 'npm:@aikdna/kdna-core@0.18.0';
  });
  mutateJson(root, 'package-lock.json', (lock) => {
    lock.packages[''].dependencies['shadow-core'] = 'npm:@aikdna/kdna-core@0.18.0';
    lock.packages['node_modules/shadow-core'] = {
      version: '0.18.0',
      resolved: 'https://registry.npmjs.org/@aikdna/kdna-core/-/kdna-core-0.18.0.tgz',
      integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
    };
  });
  assert.throws(() => verifyCandidateBinding(root), /alias or encoded dependency spec/);
});

test('static graph rejects hidden identities in lock names, resolutions, and dependency maps', (t) => {
  const cases = [
    (lock) => {
      lock.packages['node_modules/shadow-core'] = {
        name: CORE,
        version: '0.18.0',
        resolved: 'https://registry.npmjs.org/@aikdna/kdna-core/-/kdna-core-0.18.0.tgz',
        integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
      };
    },
    (lock) => {
      lock.packages['node_modules/foreign'] = {
        version: '1.0.0',
        dependencies: { 'shadow-core': 'npm:%2540aikdna%252fkdna-core@0.18.0' },
      };
    },
    (lock) => {
      lock.packages['node_modules/shadow-core'] = {
        version: '0.18.0',
        resolved: 'https://registry.npmjs.org/%40aikdna%2fkdna-core/-/kdna-core-0.18.0.tgz',
        integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
      };
    },
  ];
  for (const mutation of cases) {
    const root = copyAuthorityRoot(t);
    mutateJson(root, 'package-lock.json', mutation);
    assert.throws(() => verifyCandidateBinding(root), /AIKDNA|alias|resolution/);
  }
});

test('candidate commits are bound to canonical CI pins and evidence', (t) => {
  const root = copyAuthorityRoot(t);
  mutateJson(root, BINDING_PATH, (binding) => {
    binding.packages[0].commit = 'b'.repeat(40);
  });
  assert.throws(() => verifyCandidateBinding(root), /does not match the CI pin/);

  const evidenceRoot = copyAuthorityRoot(t);
  mutateJson(evidenceRoot, CANDIDATE_AUTHORITIES[0].evidencePath, (evidence) => {
    evidence.git_head = 'b'.repeat(40);
  });
  assert.throws(() => verifyCandidateBinding(evidenceRoot), /source evidence mismatch/);
});

test('candidate CI acquires verified npm bytes and has no PATH npm downgrade', () => {
  const workflow = fs.readFileSync(path.join(ROOT, CANDIDATE_WORKFLOW_PATH), 'utf8');
  assert.doesNotMatch(workflow, /npm install --global|npm_execpath/);
  assert.match(workflow, /acquire-trusted-npm-release\.js --out/);
  assert.match(workflow, /KDNA_TRUSTED_NPM_TARBALL=/);
  assert.match(workflow, /run-trusted-npm\.js ci --ignore-scripts/);
  assert.match(workflow, /run-trusted-npm\.js run verify:candidate-sources/);
  assert.match(workflow, /run-trusted-npm\.js test/);
});

test('trusted npm wrapper binds execution to the repository root', (t) => {
  const foreign = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studio-core-foreign-cwd-'));
  t.after(() => fs.rmSync(foreign, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'run-trusted-npm.js'), 'prefix'],
    { cwd: foreign, encoding: 'utf8', shell: false },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), ROOT);
});

test('every candidate authority rejects symlinks and hard links', async (t) => {
  const files = [
    ['package.json', 'package manifest'],
    ['package-lock.json', 'package lock'],
    [BINDING_PATH, 'candidate binding'],
    [CANDIDATE_WORKFLOW_PATH, 'candidate source workflow'],
    [CANDIDATE_AUTHORITIES[0].evidencePath, 'candidate source evidence'],
    [JSON.parse(fs.readFileSync(path.join(ROOT, BINDING_PATH), 'utf8')).packages[0].artifact, 'candidate artifact'],
  ];
  for (const [relativePath, label] of files) {
    await t.test(`${label} symlink`, (t) => {
      const root = copyAuthorityRoot(t);
      const file = path.join(root, relativePath);
      const sibling = path.join(root, `outside-${path.basename(file)}`);
      fs.renameSync(file, sibling);
      fs.symlinkSync(sibling, file);
      assert.throws(() => verifyCandidateBinding(root), /regular non-symlink|escapes/);
    });
    await t.test(`${label} hard link`, (t) => {
      const root = copyAuthorityRoot(t);
      const file = path.join(root, relativePath);
      fs.linkSync(file, path.join(root, `hardlink-${path.basename(file)}`));
      assert.throws(() => verifyCandidateBinding(root), /exactly one hard link/);
    });
  }
});

test('installed graph rejects aliases, descendants, vendored identities, symlinks, and hard links', async (t) => {
  const canonical = (root) => writeInstalledPackage(root, CORE, CORE, '0.19.0');
  await t.test('canonical graph', (t) => {
    const root = copyAuthorityRoot(t);
    canonical(root);
    assert.deepEqual(verifyInstalledAikdnaGraph(root), { [CORE]: '0.19.0' });
  });
  for (const [name, mutation, pattern] of [
    ['alias', (root) => writeInstalledPackage(root, 'shadow-core', CORE, '0.18.0'), /canonical top-level/],
    ['descendant', (root) => writeInstalledPackage(root, 'foreign/dist/node_modules/shadow-core', CORE, '0.19.0'), /canonical top-level/],
    ['vendored', (root) => writeInstalledPackage(root, 'foreign/vendor/deep/shadow-core', CORE, '0.19.0'), /canonical top-level/],
    ['bin descendant', (root) => writeInstalledPackage(root, '.bin/node_modules/shadow-core', CORE, '0.19.0'), /\.bin must not contain directories/],
  ]) {
    await t.test(name, (t) => {
      const root = copyAuthorityRoot(t);
      canonical(root);
      mutation(root);
      assert.throws(() => verifyInstalledAikdnaGraph(root), pattern);
    });
  }
  await t.test('package symlink', (t) => {
    const root = copyAuthorityRoot(t);
    canonical(root);
    fs.symlinkSync(path.join(root, 'node_modules', CORE), path.join(root, 'node_modules/shadow-core'));
    assert.throws(() => verifyInstalledAikdnaGraph(root), /package graph contains a symlink/);
  });
  await t.test('manifest hard link', (t) => {
    const root = copyAuthorityRoot(t);
    const core = canonical(root);
    fs.linkSync(path.join(core, 'package.json'), path.join(root, 'installed-core-hardlink.json'));
    assert.throws(() => verifyInstalledAikdnaGraph(root), /exactly one hard link/);
  });
});

test('registry lookup uses only the integrity-anchored npm release and canonical registries', (t) => {
  const fakeRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studio-core-fake-npm-'));
  t.after(() => fs.rmSync(fakeRoot, { recursive: true, force: true }));
  const fakeExecPath = path.join(fakeRoot, 'npm', 'bin', 'npm-cli.js');
  fs.mkdirSync(path.dirname(fakeExecPath), { recursive: true });
  fs.writeFileSync(fakeExecPath, "require('node:fs').writeFileSync(process.env.FAKE_NPM_MARKER, 'ran');\n");
  fs.writeFileSync(
    path.join(fakeRoot, 'npm', 'package.json'),
    `${JSON.stringify({ name: 'npm', version: '11.17.0' })}\n`,
  );
  const previousNpmExecPath = process.env.npm_execpath;
  process.env.npm_execpath = fakeExecPath;
  t.after(() => {
    if (previousNpmExecPath === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previousNpmExecPath;
  });
  let invocation;
  const integrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
  const metadata = strictRegistryLookup(CORE, '0.19.0', {
    root: ROOT,
    runner: (command, args, options) => {
      invocation = { command, args, options };
      return {
        status: 0,
        signal: null,
        stdout: JSON.stringify({ name: CORE, version: '0.19.0', 'dist.integrity': integrity }),
        stderr: '',
      };
    },
  });
  assert.equal(metadata.name, CORE);
  assert.equal(invocation.command, process.execPath);
  assert.notEqual(invocation.args[0], fakeExecPath);
  assert.equal(path.basename(invocation.args[0]), 'npm-cli.js');
  assert.ok(invocation.args.includes('--registry=https://registry.npmjs.org/'));
  assert.ok(invocation.args.includes('--@aikdna:registry=https://registry.npmjs.org/'));
  assert.equal(invocation.options.shell, false);
  const falseTar = path.join(fakeRoot, 'npm-11.17.0.tgz');
  fs.writeFileSync(falseTar, fs.readFileSync(path.join(ROOT, BINDING_PATH.replace('binding.json', 'kdna-core-0.19.0.tgz'))));
  assert.throws(
    () => resolveTrustedNpmInvocation(ROOT, { tarballPath: falseTar }),
    /integrity must equal the audited npm 11\.17\.0 release/,
  );
});

test('trusted npm cache paths canonicalize parent aliases and replace invalid bytes', async (t) => {
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studio-core-npm-path-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const realParent = path.join(temporary, 'real');
  const aliasParent = path.join(temporary, 'alias');
  fs.mkdirSync(realParent);
  fs.symlinkSync(realParent, aliasParent, 'dir');
  const requested = path.join(aliasParent, 'cache', 'npm-11.17.0.tgz');
  const canonical = trustedTarballPath(requested);
  assert.equal(canonical, path.join(realParent, 'cache', 'npm-11.17.0.tgz'));
  assert.equal(destinationFromArguments(['--out', requested]), canonical);
  fs.mkdirSync(path.dirname(canonical), { recursive: true });
  fs.writeFileSync(canonical, 'invalid-cache');
  const officialBytes = fs.readFileSync(trustedTarballPath());
  await acquire(canonical, { download: async () => officialBytes });
  assert.deepEqual(verifyTrustedNpmTarball(canonical), officialBytes);

  const symlinkTar = path.join(realParent, 'npm-symlink.tgz');
  fs.symlinkSync(canonical, symlinkTar);
  assert.throws(() => verifyTrustedNpmTarball(symlinkTar), /regular non-symlink/);
});

test('candidate source inspection rejects status-hidden index changes', async (t) => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    await t.test(flag, (t) => {
      const fixture = createSourceRepository(t);
      fs.appendFileSync(path.join(fixture.source, 'package.json'), ' ');
      git(fixture.repository, ['update-index', flag, 'packages/kdna-core/package.json']);
      assert.equal(git(fixture.repository, ['status', '--porcelain', '--untracked-files=all']), '');
      assert.throws(
        () => assertCleanPinnedRepository(
          fixture.repository,
          fixture.commit,
          path.join('packages', 'kdna-core'),
        ),
        /index contains assume-unchanged or skip-worktree flags/,
      );
    });
  }
});

test('commit-tree packing ignores fake npm_execpath and never runs lifecycle scripts', (t) => {
  const marker = path.join(fs.realpathSync(os.tmpdir()), `studio-core-lifecycle-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(marker, { force: true }));
  const packageJson = {
    name: CORE,
    version: '0.19.0',
    files: ['index.js'],
    scripts: {
      prepack: "node -e \"require('node:fs').writeFileSync(process.env.FAKE_NPM_MARKER,'ran')\"",
    },
  };
  const fixture = createSourceRepository(t, packageJson);
  const isolated = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studio-core-commit-tree-'));
  t.after(() => fs.rmSync(isolated, { recursive: true, force: true }));
  extractCommitPackage(
    fixture.repository,
    fixture.commit,
    path.join('packages', 'kdna-core'),
    isolated,
  );

  const fakeRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studio-core-copy-npm-'));
  t.after(() => fs.rmSync(fakeRoot, { recursive: true, force: true }));
  const fakeExec = path.join(fakeRoot, 'npm', 'bin', 'npm-cli.js');
  fs.mkdirSync(path.dirname(fakeExec), { recursive: true });
  fs.writeFileSync(
    fakeExec,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.writeFileSync(process.env.FAKE_NPM_MARKER, 'copy-tar-ran');",
      "const destination = process.argv[process.argv.indexOf('--pack-destination') + 1];",
      "const filename = 'aikdna-kdna-core-0.19.0.tgz';",
      "fs.copyFileSync(process.env.FAKE_COPY_ARTIFACT, path.join(destination, filename));",
      "process.stdout.write(JSON.stringify([{ filename }]));",
    ].join('\n'),
  );
  fs.writeFileSync(path.join(fakeRoot, 'npm', 'package.json'), JSON.stringify({ name: 'npm', version: '11.17.0' }));
  const priorNpmExecPath = process.env.npm_execpath;
  const priorMarker = process.env.FAKE_NPM_MARKER;
  const priorCopyArtifact = process.env.FAKE_COPY_ARTIFACT;
  process.env.npm_execpath = fakeExec;
  process.env.FAKE_NPM_MARKER = marker;
  process.env.FAKE_COPY_ARTIFACT = path.join(
    ROOT,
    'fixtures/runtime-candidates/kdna-core-0.19.0.tgz',
  );
  t.after(() => {
    if (priorNpmExecPath === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = priorNpmExecPath;
    if (priorMarker === undefined) delete process.env.FAKE_NPM_MARKER;
    else process.env.FAKE_NPM_MARKER = priorMarker;
    if (priorCopyArtifact === undefined) delete process.env.FAKE_COPY_ARTIFACT;
    else process.env.FAKE_COPY_ARTIFACT = priorCopyArtifact;
  });

  const invocation = resolveTrustedNpmInvocation(ROOT);
  t.after(() => invocation.cleanup());
  assert.notEqual(invocation.prefixArgs[0], fakeExec);
  const first = path.join(isolated, '..', `pack-first-${Date.now()}`);
  const second = path.join(isolated, '..', `pack-second-${Date.now()}`);
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  t.after(() => fs.rmSync(first, { recursive: true, force: true }));
  t.after(() => fs.rmSync(second, { recursive: true, force: true }));
  const firstBytes = packOnce(invocation, isolated, first);
  const secondBytes = packOnce(invocation, isolated, second);
  assert.deepEqual(firstBytes, secondBytes);
  assert.equal(fs.existsSync(marker), false);
  assert.notDeepEqual(
    firstBytes,
    fs.readFileSync(path.join(ROOT, 'fixtures/runtime-candidates/kdna-core-0.19.0.tgz')),
  );
});

test('published package contains no candidate tar, binding, or evidence files', (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-core-public-pack-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const invocation = resolveTrustedNpmInvocation(ROOT);
  t.after(() => invocation.cleanup());
  const result = spawnSync(invocation.command, [
    ...invocation.prefixArgs,
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    output,
    '--registry=https://registry.npmjs.org/',
    '--@aikdna:registry=https://registry.npmjs.org/',
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, shell: false });
  assert.equal(result.status, 0, result.stderr);
  const [report] = JSON.parse(result.stdout);
  assert.deepEqual(
    report.files.filter((file) => /runtime-candidates|\.tgz$|evidence\.json$/.test(file.path)),
    [],
  );
});
