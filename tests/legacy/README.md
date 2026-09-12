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
  node_modules/@aikdna/kdna-read`;
- the retired stable-release coordinate policy, which the committed release
  candidate version cannot satisfy.

The machine-readable retirement registry is `tests/retired.json`; the gate prints
one `KDNA-CI-NOT-RUN:` receipt line per registered entry. Re-activating an entry
starts by re-pointing the file at current objects, not by deleting the receipt.

The current verification surface lives in `test/` (driven by `npm test`).
