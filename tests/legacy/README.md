# Retired test material (not part of the current verification surface)

Everything in this directory is **retired**. None of it runs in `npm test`,
`npm run test:all`, `.github/workflows/ci.yml`, or `.github/workflows/publish.yml`.

These files are retained as historical material only. They exercise objects that
the committed graph no longer ships:

- the retired public Core API surface (`createProject`, `validate`, `pack`,
  `encryptProtectedEntry`) that belonged to the pre-component-semantics graph;
  the current graph exposes `admitNode` / `inspectSnapshot` / `readNode` and
  `createSession` / `verifyCreationEvidence`;
- the retired packed member list (e.g. `src/authoring/index.js`);
- the retired runtime-candidate authority binding for the 3.0.0 / 0.21.0 graph,
  whose verifier now stops on `unbound file lock package:
  node_modules/@aikdna/kdna-read`. Its completeness suite is **not** retired any
  more: it was re-pointed at the committed candidate fixture and moved back to
  `tests/runtime-candidate-binding-completeness.test.js`, because the coverage it
  carried (the binding rejects hostile lock graphs) still applies to the current
  script;
- the retired stable-release coordinate policy, which the committed release
  candidate version cannot satisfy.

The machine-readable retirement registry is `tests/retired.json`; the gate prints
one `KDNA-CI-NOT-RUN:` receipt line per registered entry. Re-activating an entry
starts by re-pointing the file at current objects, not by deleting the receipt.

Being red is not by itself a reason to be here. The gate accepts an entry only
while its failure output explicitly names an object the entry declares absent.
That is the criterion's only sufficient leg, and it is checked against the run
in the file's registered location. A match counts only when the run printed it
about the failure: not on a passing test's line, not inside the specifier of a
`Cannot find module` failure, and not inside a file path - a path is the judged
artifact naming itself.

Re-running the retired bytes from the path they were retired from is still
reported, but only as an **auxiliary** observation that never accepts an entry
on its own: the retirement rewrites the file's relative requires to the new
depth, so the bytes re-run from the old path die on a `Cannot find module` the
move itself created. `scripts/retirement-resolution.js` reports that fact
independently, and a file whose relative requires no longer resolve from the path
it was retired from makes the auxiliary leg inadmissible.

A file that only turns red because `git mv` broke its relative `require` - with
every require untouched, or with one of them rewritten to the new depth - names
nothing it declares absent and is refused.

The current verification surface lives in `test/` (driven by `npm test`).
