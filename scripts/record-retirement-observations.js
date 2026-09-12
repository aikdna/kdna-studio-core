#!/usr/bin/env node
'use strict';

// Regenerate the `observed_on_committed_graph` field of tests/retired.json.
//
// That field is a claim about the committed graph, and a claim written by hand
// drifts. The revision before this script still carried four numbers that had
// been measured while the files were at their pre-upgrade paths, so the report
// that cited them was wrong about 4 of 10 rows. Measuring instead of asserting
// makes the table reproducible: this script runs every registered file with the
// same child process the gate uses and prints what it observed.
//
//   node scripts/record-retirement-observations.js           print the table
//   node scripts/record-retirement-observations.js --write   update the registry
//   node scripts/record-retirement-observations.js --check   non-zero on drift
//
// The field is a recorded observation, not a gate: assertion counts can move
// with the Node.js version, and a gate on them would turn a version bump into a
// false failure. `--check` exists so the drift is visible at a chosen checkpoint.
//
// usage: node scripts/record-retirement-observations.js [--root <tree>] [--write|--check]

const fs = require('node:fs');
const path = require('node:path');
const { runTestFile } = require('./verify-retirement-registry.js');

function observation(run) {
  const passed = run.passed === null ? 'UNKNOWN' : run.passed;
  const failed = run.failed === null ? 'UNKNOWN' : run.failed;
  const assertions = failed === 1 ? 'assertion' : 'assertions';
  return `${passed} passing / ${failed} failing ${assertions}`;
}

async function main(argv) {
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex === -1 ? path.resolve(__dirname, '..') : path.resolve(argv[rootIndex + 1]);
  const registryPath = path.join(root, 'tests', 'retired.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));

  let drift = 0;
  console.log(`KDNA-RETIREMENT-OBSERVATIONS: root=${root}`);
  console.log('file\trc\tobserved\trecorded\tagrees');
  for (const entry of registry.entries ?? []) {
    const run = await runTestFile(root, entry.file);
    const observed = observation(run);
    const recorded = entry.observed_on_committed_graph ?? '(none)';
    const agrees = observed === recorded;
    if (!agrees) drift += 1;
    console.log(`${entry.file}\t${run.status}\t${observed}\t${recorded}\t${agrees ? 'yes' : 'no'}`);
    if (write) entry.observed_on_committed_graph = observed;
  }
  console.log(
    `KDNA-RETIREMENT-OBSERVATIONS: entries=${registry.entries?.length ?? 0} agreed=${(registry.entries?.length ?? 0) - drift} drifted=${drift}`,
  );

  if (write) {
    fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    console.log(`KDNA-RETIREMENT-OBSERVATIONS: wrote ${registryPath}`);
  }
  if (check && drift > 0) return 1;
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
