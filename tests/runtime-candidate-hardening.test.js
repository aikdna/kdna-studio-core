'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const zlib = require('node:zlib');
const {
  acquire,
  destinationFromArguments,
} = require('../scripts/acquire-trusted-npm-release');
const {
  BINDING_PATH,
  STRICT_PACKAGE_INSTALL_EQUIVALENCE,
  assertPackageTarInstallEquivalent,
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
  main: verifyCandidateSourcesMain,
  materializeCommitPackage,
  packOnce,
} = require('../scripts/verify-runtime-candidate-sources');
const {
  trustedTarballPath,
  verifyTrustedNpmTarball,
} = require('../scripts/trusted-npm-release');

const ROOT = path.resolve(__dirname, '..');
const CORE = '@aikdna/kdna-core';

function writeTarString(header, offset, length, value) {
  const bytes = Buffer.from(value);
  assert.ok(bytes.length <= length, `tar field is too long: ${value}`);
  bytes.copy(header, offset);
}

function writeTarOctal(header, offset, length, value) {
  const octal = value.toString(8).padStart(length - 1, '0');
  assert.ok(octal.length < length, `tar numeric field is too large: ${value}`);
  header.write(octal, offset, length - 1, 'ascii');
  header[offset + length - 1] = 0;
}

function rewriteTarChecksum(header) {
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
}

function syntheticTarEntry({
  name,
  content = Buffer.alloc(0),
  type = '0',
  mode = 0o644,
  uid = 0,
  gid = 0,
  mtime = 0,
}) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, name);
  writeTarOctal(header, 100, 8, mode);
  writeTarOctal(header, 108, 8, uid);
  writeTarOctal(header, 116, 8, gid);
  writeTarOctal(header, 124, 12, bytes.length);
  writeTarOctal(header, 136, 12, mtime);
  header[156] = type.charCodeAt(0);
  writeTarString(header, 257, 6, 'ustar');
  writeTarString(header, 263, 2, '00');
  rewriteTarChecksum(header);
  return Buffer.concat([
    header,
    bytes,
    Buffer.alloc((512 - (bytes.length % 512)) % 512),
  ]);
}

function syntheticTarGzip(entries, options = {}) {
  const archive = Buffer.concat([
    ...entries.map((entry) => syntheticTarEntry(entry)),
    Buffer.alloc(1024),
  ]);
  return zlib.gzipSync(archive, options);
}

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

function createSourceRepository(t, packageJson = { name: CORE, version: '0.20.0' }) {
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

  const policyRoot = copyAuthorityRoot(t);
  mutateJson(policyRoot, CANDIDATE_AUTHORITIES[0].evidencePath, (evidence) => {
    evidence.pack.source_equivalence.excluded_non_install_metadata.push('tar_mode');
  });
  assert.throws(() => verifyCandidateBinding(policyRoot), /candidate pack evidence mismatch/);

  const evidence = JSON.parse(
    fs.readFileSync(path.join(ROOT, CANDIDATE_AUTHORITIES[0].evidencePath), 'utf8'),
  );
  assert.equal(evidence.pack.reproducible_runs, 2);
  assert.deepEqual(evidence.pack.source_equivalence, STRICT_PACKAGE_INSTALL_EQUIVALENCE);
});

test('candidate CI pins immutable actions, exact Node runtimes, and verified npm bytes', () => {
  const workflow = fs.readFileSync(path.join(ROOT, CANDIDATE_WORKFLOW_PATH), 'utf8');
  const codeql = fs.readFileSync(
    path.join(ROOT, '.github/workflows/codeql-js.yml'),
    'utf8',
  );
  const verifier = fs.readFileSync(
    path.join(ROOT, 'scripts/verify-runtime-candidate-sources.js'),
    'utf8',
  );
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  assert.match(workflow, /actions\/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0/);
  assert.equal(
    workflow.match(/actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38/g)?.length,
    2,
  );
  assert.match(workflow, /node:\s*\[18\.20\.8, 22\.23\.1\]/);
  assert.match(workflow, /node-version:\s*22\.23\.1/);
  assert.match(workflow, /node-version:\s*\$\{\{ matrix\.node \}\}/);
  assert.doesNotMatch(workflow, /actions\/(?:checkout|setup-node)@v[0-9]+/);
  assert.match(codeql, /actions\/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0/);
  assert.equal(
    codeql.match(/github\/codeql-action\/(?:init|autobuild|analyze)@99df26d4f13ea111d4ec1a7dddef6063f76b97e9/g)?.length,
    3,
  );
  assert.doesNotMatch(codeql, /@v[0-9]+/);
  assert.doesNotMatch(workflow, /npm install --global|npm_execpath/);
  assert.match(workflow, /acquire-trusted-npm-release\.js --out/);
  assert.match(workflow, /KDNA_TRUSTED_NPM_TARBALL=/);
  assert.match(workflow, /run-trusted-npm\.js ci --ignore-scripts/);
  assert.match(workflow, /run-trusted-npm\.js run verify:candidate-sources\s*$/m);
  assert.match(workflow, /node scripts\/run-test-all\.js/);
  assert.match(workflow, /if: matrix\.node == '18\.20\.8'/);
  assert.match(workflow, /node --test "\$\{tests\[@\]\}"/);
  assert.match(workflow, /candidate_source="\$runner_temp\/kdna-core-candidate"/);
  assert.match(
    workflow,
    /echo "KDNA_CORE_CANDIDATE_SOURCE=\$candidate_source" >> "\$GITHUB_ENV"/,
  );
  assert.match(workflow, /"\$workspace"\/\*\) exit 1 ;;/);
  assert.doesNotMatch(workflow, /KDNA_CORE_CANDIDATE_SOURCE:\s*\$\{\{\s*github\.workspace/);
  assert.doesNotMatch(workflow, /path:\s*\.candidate-sources/);
  assert.equal(
    scripts['verify:candidate-sources'],
    'node scripts/verify-runtime-candidate-sources.js',
  );
  assert.equal(verifier.split('const sourcePack = packOnce(').length - 1, 1);
  assert.match(verifier, /assertPackageTarInstallEquivalent\(/);
  assert.doesNotMatch(verifier, /SOURCE_EQUIVALENCE|equivalence.*environment/i);
  assert.throws(
    () => verifyCandidateSourcesMain(['--ci-source-equivalence']),
    /usage: verify-runtime-candidate-sources\.js/,
  );
  assert.throws(
    () => verifyCandidateSourcesMain(['--unknown']),
    /usage: verify-runtime-candidate-sources\.js/,
  );
});

test('candidate source equivalence excludes only recorded non-install metadata', () => {
  const checked = syntheticTarGzip(
    [{ name: 'package/index.js', content: 'module.exports = true;\n', uid: 0, gid: 0, mtime: 0 }],
    { level: 1 },
  );
  const source = syntheticTarGzip(
    [{ name: 'package/index.js', content: 'module.exports = true;\n', uid: 501, gid: 20, mtime: 123 }],
    { level: 9 },
  );
  assert.notDeepEqual(source, checked);
  assert.deepEqual(assertPackageTarInstallEquivalent(checked, source), {
    ...STRICT_PACKAGE_INSTALL_EQUIVALENCE,
    entry_count: 1,
  });
});

test('candidate source equivalence rejects malformed excluded tar metadata', async (t) => {
  const checked = syntheticTarGzip([{ name: 'package/index.js', content: 'abc' }]);
  for (const [field, offset, length] of [
    ['uid', 108, 8],
    ['gid', 116, 8],
    ['mtime', 136, 12],
  ]) {
    await t.test(field, () => {
      const archive = zlib.gunzipSync(checked);
      const header = archive.subarray(0, 512);
      header.fill(0, offset, offset + length);
      header[offset] = 'x'.charCodeAt(0);
      rewriteTarChecksum(header);
      assert.throws(
        () => assertPackageTarInstallEquivalent(checked, zlib.gzipSync(archive)),
        new RegExp(`${field} is invalid`),
      );
    });
  }
});

test('candidate source equivalence blocks path, set, type, size, mode, and byte drift', async (t) => {
  const checked = syntheticTarGzip([
    { name: 'package/index.js', content: 'abc', mode: 0o644 },
  ]);
  const cases = [
    [
      'canonical path',
      [{ name: 'package/../index.js', content: 'abc', mode: 0o644 }],
      /entry path invalid/,
    ],
    [
      'complete entry set',
      [
        { name: 'package/index.js', content: 'abc', mode: 0o644 },
        { name: 'package/extra.js', content: 'x', mode: 0o644 },
      ],
      /complete entry set differs/,
    ],
    [
      'regular file type',
      [{ name: 'package/index.js', content: 'abc', type: '2', mode: 0o644 }],
      /entry type is unsupported/,
    ],
    [
      'file size',
      [{ name: 'package/index.js', content: 'ab', mode: 0o644 }],
      /file size differs/,
    ],
    [
      'file mode',
      [{ name: 'package/index.js', content: 'abc', mode: 0o755 }],
      /file mode differs/,
    ],
    [
      'file bytes',
      [{ name: 'package/index.js', content: 'abd', mode: 0o644 }],
      /file bytes differ/,
    ],
  ];
  for (const [label, entries, pattern] of cases) {
    await t.test(label, () => {
      assert.throws(
        () => assertPackageTarInstallEquivalent(checked, syntheticTarGzip(entries)),
        pattern,
      );
    });
  }
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

test('trusted npm lifecycle resolves node from the current process executable', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX fake executable fixture');
    return;
  }
  const temporary = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'studio-core-node-lifecycle-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const hostileBin = path.join(temporary, 'hostile-bin');
  const project = path.join(temporary, 'project');
  fs.mkdirSync(hostileBin);
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(hostileBin, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.writeFileSync(
    path.join(project, 'package.json'),
    `${JSON.stringify(
      {
        name: 'trusted-node-lifecycle-fixture',
        version: '1.0.0',
        scripts: { 'must-fail': 'node -e "process.exit(23)"' },
      },
      null,
      2,
    )}\n`,
  );
  const invocation = resolveTrustedNpmInvocation(ROOT, {
    environment: {
      ...process.env,
      PATH: `${hostileBin}${path.delimiter}${process.env.PATH}`,
      NODE_OPTIONS: '--invalid-hostile-option',
      npm_config_script_shell: path.join(hostileBin, 'node'),
      npm_execpath: path.join(hostileBin, 'fake-npm'),
      npm_lifecycle_event: 'forged',
    },
  });
  t.after(() => invocation.cleanup());
  const controlledNode = path.join(
    invocation.environment.PATH.split(path.delimiter)[0],
    'node',
  );
  assert.equal(fs.realpathSync(controlledNode), process.execPath);
  assert.equal(invocation.environment.NODE, process.execPath);
  assert.equal(invocation.environment.npm_node_execpath, process.execPath);
  assert.equal(invocation.environment.npm_execpath, invocation.prefixArgs[0]);
  assert.equal(invocation.environment.NODE_OPTIONS, undefined);
  assert.equal(invocation.environment.npm_config_script_shell, undefined);
  assert.equal(invocation.environment.npm_lifecycle_event, undefined);
  const result = spawnSync(
    invocation.command,
    [...invocation.prefixArgs, 'run', 'must-fail'],
    {
      cwd: project,
      encoding: 'utf8',
      env: invocation.environment,
      shell: false,
    },
  );
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /node -e "process\.exit\(23\)"/);
});

test('trusted npm wrapper forwards the controlled lifecycle environment', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX fake executable fixture');
    return;
  }
  const hostileBin = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'studio-core-wrapper-hostile-path-'),
  );
  t.after(() => fs.rmSync(hostileBin, { recursive: true, force: true }));
  fs.writeFileSync(path.join(hostileBin, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'run-trusted-npm.js'), 'run', 'release:check'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${hostileBin}${path.delimiter}${process.env.PATH}`,
        GITHUB_EVENT_NAME: 'not-a-release',
        npm_execpath: path.join(hostileBin, 'fake-npm'),
        npm_lifecycle_event: 'forged',
      },
      shell: false,
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Release context rejected:/);
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
  const canonical = (root) => writeInstalledPackage(root, CORE, CORE, '0.20.0');
  await t.test('canonical graph', (t) => {
    const root = copyAuthorityRoot(t);
    canonical(root);
    assert.deepEqual(verifyInstalledAikdnaGraph(root), { [CORE]: '0.20.0' });
  });
  for (const [name, mutation, pattern] of [
    ['alias', (root) => writeInstalledPackage(root, 'shadow-core', CORE, '0.18.0'), /canonical top-level/],
    ['descendant', (root) => writeInstalledPackage(root, 'foreign/dist/node_modules/shadow-core', CORE, '0.20.0'), /canonical top-level/],
    ['vendored', (root) => writeInstalledPackage(root, 'foreign/vendor/deep/shadow-core', CORE, '0.20.0'), /canonical top-level/],
    ['bin descendant', (root) => writeInstalledPackage(root, '.bin/node_modules/shadow-core', CORE, '0.20.0'), /\.bin must not contain directories/],
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
  const metadata = strictRegistryLookup(CORE, '0.20.0', {
    root: ROOT,
    runner: (command, args, options) => {
      invocation = { command, args, options };
      return {
        status: 0,
        signal: null,
        stdout: JSON.stringify({ name: CORE, version: '0.20.0', 'dist.integrity': integrity }),
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
  assert.equal(invocation.options.env.NODE, process.execPath);
  assert.equal(invocation.options.env.npm_node_execpath, process.execPath);
  assert.equal(invocation.options.env.npm_execpath, invocation.args[0]);
  const falseTar = path.join(fakeRoot, 'npm-11.17.0.tgz');
  fs.writeFileSync(falseTar, fs.readFileSync(path.join(ROOT, BINDING_PATH.replace('binding.json', 'kdna-core-0.20.0.tgz'))));
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
        /index contains assume-unchanged, skip-worktree, or non-ordinary entries/,
      );
    });
  }
});

test('candidate source authority rejects replace refs and archives the original commit', (t) => {
  const fixture = createSourceRepository(t);
  fs.writeFileSync(
    path.join(fixture.source, 'index.js'),
    "'use strict';\nmodule.exports = 'replacement-content';\n",
  );
  git(fixture.repository, ['add', 'packages/kdna-core/index.js']);
  git(fixture.repository, ['commit', '--quiet', '-m', 'replacement']);
  const replacement = git(fixture.repository, ['rev-parse', 'HEAD']);
  git(fixture.repository, ['checkout', '--quiet', '--detach', fixture.commit]);
  git(fixture.repository, ['replace', fixture.commit, replacement]);

  const oldArchive = spawnSync(
    'git',
    ['-C', fixture.repository, 'archive', '--format=tar', fixture.commit, '--', 'packages/kdna-core'],
    { encoding: null, maxBuffer: 16 * 1024 * 1024, shell: false },
  );
  assert.equal(oldArchive.status, 0, oldArchive.stderr?.toString('utf8'));
  assert.ok(oldArchive.stdout.includes(Buffer.from('replacement-content')));
  assert.throws(
    () => assertCleanPinnedRepository(
      fixture.repository,
      fixture.commit,
      path.join('packages', 'kdna-core'),
    ),
    /contains Git replacement refs/,
  );

  const isolated = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studio-core-no-replace-'));
  t.after(() => fs.rmSync(isolated, { recursive: true, force: true }));
  materializeCommitPackage(
    fixture.repository,
    fixture.commit,
    path.join('packages', 'kdna-core'),
    isolated,
  );
  assert.equal(
    fs.readFileSync(path.join(isolated, 'index.js'), 'utf8'),
    "'use strict';\nmodule.exports = true;\n",
  );

  git(fixture.repository, ['replace', '--delete', fixture.commit]);
  git(fixture.repository, ['update-ref', `refs/alternate-replacements/${fixture.commit}`, replacement]);
  const prior = Object.fromEntries(
    ['GIT_REPLACE_REF_BASE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']
      .map((key) => [key, process.env[key]]),
  );
  process.env.GIT_REPLACE_REF_BASE = 'refs/alternate-replacements/';
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'core.useReplaceRefs';
  process.env.GIT_CONFIG_VALUE_0 = 'true';
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const rewrittenArchive = spawnSync(
    'git',
    ['-C', fixture.repository, 'archive', '--format=tar', fixture.commit, '--', 'packages/kdna-core'],
    {
      encoding: null,
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
    },
  );
  assert.equal(rewrittenArchive.status, 0, rewrittenArchive.stderr?.toString('utf8'));
  assert.ok(rewrittenArchive.stdout.includes(Buffer.from('replacement-content')));

  const sanitized = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studio-core-sanitized-git-'));
  t.after(() => fs.rmSync(sanitized, { recursive: true, force: true }));
  materializeCommitPackage(
    fixture.repository,
    fixture.commit,
    path.join('packages', 'kdna-core'),
    sanitized,
  );
  assert.equal(
    fs.readFileSync(path.join(sanitized, 'index.js'), 'utf8'),
    "'use strict';\nmodule.exports = true;\n",
  );
  assert.doesNotThrow(() => assertCleanPinnedRepository(
    fixture.repository,
    fixture.commit,
    path.join('packages', 'kdna-core'),
  ));
});

test('commit-object materialization ignores private export attributes', (t) => {
  const fixture = createSourceRepository(t);
  const substitutedSource = 'literal-$Format:%H$-value\n';
  fs.writeFileSync(path.join(fixture.source, 'substituted.txt'), substitutedSource);
  git(fixture.repository, ['add', 'packages/kdna-core/substituted.txt']);
  git(fixture.repository, ['commit', '--quiet', '-m', 'substitution fixture']);
  const commit = git(fixture.repository, ['rev-parse', 'HEAD']);
  fs.writeFileSync(
    path.join(fixture.repository, '.git', 'info', 'attributes'),
    [
      'packages/kdna-core/index.js export-ignore',
      'packages/kdna-core/substituted.txt export-subst',
      '',
    ].join('\n'),
  );
  assert.equal(git(fixture.repository, ['status', '--porcelain', '--untracked-files=all']), '');
  assert.doesNotThrow(() => assertCleanPinnedRepository(
    fixture.repository,
    commit,
    path.join('packages', 'kdna-core'),
  ));

  const oldArchive = spawnSync(
    'git',
    ['-C', fixture.repository, 'archive', '--format=tar', commit, '--', 'packages/kdna-core'],
    { encoding: null, maxBuffer: 16 * 1024 * 1024, shell: false },
  );
  assert.equal(oldArchive.status, 0, oldArchive.stderr?.toString('utf8'));
  assert.equal(oldArchive.stdout.includes(Buffer.from('module.exports = true')), false);
  assert.equal(oldArchive.stdout.includes(Buffer.from(substitutedSource)), false);
  assert.ok(oldArchive.stdout.includes(Buffer.from(commit)));

  const materialized = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'studio-core-raw-commit-'),
  );
  t.after(() => fs.rmSync(materialized, { recursive: true, force: true }));
  materializeCommitPackage(
    fixture.repository,
    commit,
    path.join('packages', 'kdna-core'),
    materialized,
  );
  assert.equal(
    fs.readFileSync(path.join(materialized, 'index.js'), 'utf8'),
    "'use strict';\nmodule.exports = true;\n",
  );
  assert.equal(fs.readFileSync(path.join(materialized, 'substituted.txt'), 'utf8'), substitutedSource);
});

test('commit-object materialization accepts executable blobs and rejects special modes', async (t) => {
  await t.test('executable blob', (t) => {
    const fixture = createSourceRepository(t);
    fs.chmodSync(path.join(fixture.source, 'index.js'), 0o755);
    git(fixture.repository, ['add', 'packages/kdna-core/index.js']);
    git(fixture.repository, ['commit', '--quiet', '-m', 'executable fixture']);
    const commit = git(fixture.repository, ['rev-parse', 'HEAD']);
    const materialized = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), 'studio-core-executable-'),
    );
    t.after(() => fs.rmSync(materialized, { recursive: true, force: true }));
    materializeCommitPackage(
      fixture.repository,
      commit,
      path.join('packages', 'kdna-core'),
      materialized,
    );
    assert.equal(fs.statSync(path.join(materialized, 'index.js')).mode & 0o777, 0o755);
  });

  for (const [label, mode, object] of [
    ['symlink', '120000', 'blob'],
    ['gitlink', '160000', 'commit'],
  ]) {
    await t.test(label, (t) => {
      const fixture = createSourceRepository(t);
      let objectId = fixture.commit;
      if (object === 'blob') {
        const source = path.join(fixture.repository, 'special-mode-source');
        fs.writeFileSync(source, 'target');
        objectId = git(fixture.repository, ['hash-object', '-w', source]);
        fs.rmSync(source);
      }
      git(fixture.repository, [
        'update-index',
        '--add',
        '--cacheinfo',
        mode,
        objectId,
        `packages/kdna-core/${label}`,
      ]);
      git(fixture.repository, ['commit', '--quiet', '-m', `${label} fixture`]);
      const commit = git(fixture.repository, ['rev-parse', 'HEAD']);
      const materialized = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), `studio-core-${label}-`),
      );
      t.after(() => fs.rmSync(materialized, { recursive: true, force: true }));
      assert.throws(
        () => materializeCommitPackage(
          fixture.repository,
          commit,
          path.join('packages', 'kdna-core'),
          materialized,
        ),
        /contains a symlink, gitlink, or unsupported mode/,
      );
    });
  }
});

test('formal candidate evidence keeps two byte-identical trusted npm packs', (t) => {
  const marker = path.join(fs.realpathSync(os.tmpdir()), `studio-core-lifecycle-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(marker, { force: true }));
  const packageJson = {
    name: CORE,
    version: '0.20.0',
    files: ['index.js'],
    scripts: {
      prepack: "node -e \"require('node:fs').writeFileSync(process.env.FAKE_NPM_MARKER,'ran')\"",
    },
  };
  const fixture = createSourceRepository(t, packageJson);
  const isolated = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studio-core-commit-tree-'));
  t.after(() => fs.rmSync(isolated, { recursive: true, force: true }));
  materializeCommitPackage(
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
      "const filename = 'aikdna-kdna-core-0.20.0.tgz';",
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
    'fixtures/runtime-candidates/kdna-core-0.20.0.tgz',
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
    fs.readFileSync(path.join(ROOT, 'fixtures/runtime-candidates/kdna-core-0.20.0.tgz')),
  );
});

test('published package contains no candidate tar, binding, or evidence files', (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-core-public-pack-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const invocation = resolveTrustedNpmInvocation(ROOT);
  t.after(() => invocation.cleanup());
  const result = spawnSync(
    invocation.command,
    [
      ...invocation.prefixArgs,
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      output,
      '--registry=https://registry.npmjs.org/',
      '--@aikdna:registry=https://registry.npmjs.org/',
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: invocation.environment,
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const [report] = JSON.parse(result.stdout);
  assert.deepEqual(
    report.files.filter((file) => /runtime-candidates|\.tgz$|evidence\.json$/.test(file.path)),
    [],
  );
});
