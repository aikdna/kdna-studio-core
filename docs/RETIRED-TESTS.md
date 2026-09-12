# Retired test material (not part of the current verification surface)

The registry of retired material is `tests/retired.json` and the bytes
themselves live under `tests/legacy/`. None of it runs in `npm test`,
`npm run test:all`, `.github/workflows/ci.yml`, or
`.github/workflows/publish.yml`.

**The registry is empty.** Nine suites were registered here; all nine are current
tests again, byte for byte:

- `tests/authoring-path.test.js`
- `tests/creation-engine-persistence.test.js`
- `tests/creation-engine.test.js`
- `tests/e2e.test.js`
- `tests/golden-single-asset.test.js`
- `tests/public-package-surface.test.js`
- `tests/runtime-candidate-hardening.test.js`
- `tests/runtime-export.test.js`
- `tests/runtime-release-pair.test.js`

They exercise objects the committed graph no longer ships - the retired public
Core API surface (`createProject`, `validate`, `pack`, `encryptProtectedEntry`)
that belonged to the pre-component-semantics graph, the retired packed member
list (e.g. `src/authoring/index.js`), the retired runtime-candidate authority
binding for the 3.0.0 / 0.21.0 graph (whose verifier now stops on
`unbound file lock package: node_modules/@aikdna/kdna-read`), and the retired
stable-release coordinate policy - but "this suite is red" is not what retires a
suite. A retirement is a byte-preserving move, and the move that put these nine
under `tests/legacy/` re-pointed their relative requires to the new depth.
Criterion (e) below refuses exactly that, so the retirement does not hold: the
files go back to the paths they were retired from, unchanged, as current tests. A
suite that only fits the retired directory after being adapted is not retired at
all.

The completeness suite that was once here is **not** retired either: it was
re-pointed at the committed candidate fixture and moved back to
`tests/runtime-candidate-binding-completeness.test.js`, because the coverage it
carried (the binding rejects hostile lock graphs) still applies to the current
script.

## What a retirement has to register

A retirement is a **preservation** claim, not a story about a red run. Every
entry registers the retired path (`file`), the original path it was retired from
(`original_path`), the `sha256` of the preserved bytes (the retirement's
`retired_sha256`), the commit those bytes are claimed to come from
(`retired_from_commit`), a free-text `reason`, the registration date
(`retired_on`) and the review that accepted it (`review_reference`).

`scripts/verify-retirement-registry.js` reads **no test output**. Earlier
revisions tried to decide, from the judged artifact's own output, whether a run
failed *because* the retired object is gone. That is not decidable that way: a
failing test's title, a `console.log` the test itself prints, a stack frame
naming its own file, and a specifier the move rewrote can each be made to name
any object at all, and each was in turn accepted as proof. The gate checks five
things from files, hashes and the object store:

- **(a) preserved** - the file at the registered path hashes to the registered
  `sha256`, so a retirement can never quietly delete or rewrite the bytes it
  claims to keep;
- **(b) complete** - every file under `tests/legacy/` is registered, so nothing
  can be dropped into the retired directory without a receipt;
- **(c) not a fake retirement** - the original path does not still carry the
  registered bytes, so the file really is out of the current surface rather than
  being registered while it keeps running;
- **(d) re-evaluable** - the registered bytes are put back at the original path
  and run. A passing run is printed as `KDNA-RETIREMENT-RESTORABLE: <file>`: the
  entry is not stale, so restore it or record why it stays retired. (d) is a
  receipt, never an acceptance condition;
- **(e) zero rewrite** - the registered `sha256` is the `sha256` of the bytes the
  file carried at `original_path` in `retired_from_commit`, read out of the
  object store (`git rev-parse <commit>:<path>`, `git cat-file blob`, sha256 of
  those bytes) rather than out of the working tree, so editing the copy under
  `tests/legacy/` after the fact cannot make the claim true. A move that rewrote
  the file registers bytes that are not the test that was there, and the record
  would describe a test that never ran. An entry that fails (e) is refused and
  the file goes back to its original path, unchanged, as a current test. The
  commit has to be an ancestor of `HEAD`, so an entry cannot name bytes that no
  tree under `HEAD` ever carried.

The exit code is about (a)-(c) and (e). (e) reads git history, so the checkout
that runs the gate has to carry it: `.github/workflows/ci.yml` fetches the full
history (`fetch-depth: 0`) rather than the default shallow clone.

`scripts/run-test-all.js` prints one `KDNA-CI-NOT-RUN:` receipt per registered
entry and fails the run if the registry does not hold. Re-activating an entry
starts by re-pointing the file at current objects and registering the move, not
by deleting the receipt.

The current verification surface lives in `test/` (driven by `npm test`) and in
the top-level `tests/*.test.js` suites (driven by `npm run test:all`).
