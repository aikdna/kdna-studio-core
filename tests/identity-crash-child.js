'use strict';

// Crash harness for tests/creator-identity.test.js. Not a test file.
//
// Usage: node tests/identity-crash-child.js <baseDir> <phase>
//
// Runs the real initIdentity() export in a loop (each iteration against a
// fresh attempt-N/identity directory) while a worker thread watches the
// real filesystem and SIGKILLs this process the moment the requested commit
// phase becomes observable. Nothing in the module under test is patched or
// recompiled; the crash is a real process kill at a real commit boundary,
// and the loop simply offers the watcher hundreds of millisecond-wide
// windows per run so the phase is caught deterministically.
//
// Phases:
//   key         staging holds kdna.key only            (pre-commit)
//   pub         staging holds kdna.key + kdna.pub      (pre-commit)
//   json        staging holds all three files          (pre-commit, pre-rename)
//   post-commit canonical directory holds creator.json (just after rename)
//
// Before dying, the worker writes a `.crash-marker` file in baseDir whose
// content is the attempt parent directory of the interrupted transaction,
// so the parent test can locate the crashed identity dir and distinguish
// "killed at the requested phase" from "window missed" across platforms.

const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');

const IDENTITY_FILES = ['kdna.key', 'kdna.pub', 'creator.json'];
const PHASES = ['key', 'pub', 'json', 'post-commit'];
const MAX_ATTEMPTS = 400;

if (isMainThread) {
  const [baseDir, phase] = process.argv.slice(2);
  if (!baseDir || !PHASES.includes(phase)) {
    process.stderr.write(`usage: identity-crash-child.js <baseDir> <${PHASES.join('|')}>\n`);
    process.exit(2);
  }
  const worker = new Worker(__filename, { workerData: { baseDir, phase } });
  worker.once('message', (message) => {
    if (message !== 'ready') return;
    try {
      // The real export path: this is the only code under test here.
      const { initIdentity } = require(path.join(__dirname, '..', 'src', 'creator-identity.js'));
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const attemptParent = path.join(baseDir, `attempt-${attempt}`);
        fs.mkdirSync(attemptParent);
        initIdentity('crasher', path.join(attemptParent, 'identity'));
      }
    } finally {
      worker.terminate();
    }
  });
} else {
  const { baseDir, phase } = workerData;
  const wanted = phase === 'post-commit' ? null : IDENTITY_FILES.slice(0, PHASES.indexOf(phase) + 1).sort();

  function scan() {
    let attempts;
    try {
      attempts = fs.readdirSync(baseDir);
    } catch {
      return null;
    }
    for (const name of attempts) {
      if (!name.startsWith('attempt-')) continue;
      const attemptParent = path.join(baseDir, name);
      if (phase === 'post-commit') {
        try {
          if (fs.readdirSync(path.join(attemptParent, 'identity')).includes('creator.json')) {
            return attemptParent;
          }
        } catch {
          // identity dir not published yet
        }
        continue;
      }
      let inner;
      try {
        inner = fs.readdirSync(attemptParent);
      } catch {
        continue;
      }
      for (const entry of inner) {
        if (!entry.startsWith('.kdna-init-') || !entry.endsWith('.staging.d')) continue;
        let staged;
        try {
          staged = fs.readdirSync(path.join(attemptParent, entry))
            .filter((file) => IDENTITY_FILES.includes(file))
            .sort();
        } catch {
          continue;
        }
        if (staged.length === wanted.length && staged.every((file, i) => file === wanted[i])) {
          return attemptParent;
        }
      }
    }
    return null;
  }

  parentPort.postMessage('ready');
  // Tight poll on a separate thread: the main thread is blocked in
  // synchronous fs/crypto work, so only a thread can interrupt it. The loop
  // is bounded — the main thread terminates this worker once init returns.
  for (;;) {
    const hit = scan();
    if (hit) {
      try {
        fs.writeFileSync(path.join(baseDir, '.crash-marker'), hit);
      } catch {
        // best effort; the kill still proves the crash
      }
      process.kill(process.pid, 'SIGKILL');
    }
  }
}
