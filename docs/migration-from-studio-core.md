# Migrating from `@aikdna/studio-core`

The maintained package is `@aikdna/kdna-studio-core`. Migrating from the old
package is a source migration, not a drop-in package rename.

The registry coordinates verified by this repository are:

| Coordinate | Role | Runtime requirement |
|---|---|---|
| `@aikdna/studio-core@1.2.1` | Historical package | Node.js 18 or later; `@aikdna/kdna-core` `^0.3.0`; peer `@aikdna/kdna-cli` 0.16.0 or later |
| `@aikdna/kdna-studio-core@2.0.2` | Maintained package | Node.js 18 or later; exact `@aikdna/kdna-core@0.20.0` |

The old registry tarball does not contain
`studio-schemas/studio.project.schema.json`, although its main entry point
requires that file. As a result, a clean install of
`@aikdna/studio-core@1.2.1` cannot load its package main. The old coordinate
must not be used as executable compatibility evidence for the maintained
package.

## Install the maintained package

Remove the old package and install the maintained coordinate explicitly:

```bash
npm uninstall @aikdna/studio-core
npm install @aikdna/kdna-studio-core@2.0.2
```

Change CommonJS imports:

```diff
-const studio = require('@aikdna/studio-core');
+const studio = require('@aikdna/kdna-studio-core');
```

Do not import `src/*` or other package-internal paths. The supported CommonJS
entry is the package main:

```js
const {
  project,
  cards,
  compile,
  exportRuntime,
} = require('@aikdna/kdna-studio-core');
```

## Required application changes

### Keep returned card objects

The historical card state APIs mutated their input. The current
`transitionCard` and `lockCard` APIs are immutable: they return a new card and
do not update the input object. Assign the return value and replace any card
already stored in a project:

```js
const studioProject = project.createProject('writing_judgment');
let card = cards.createCard('axiom', fields);
card = cards.transitionCard(card, 'revised', { by: 'expert_001' });
card = cards.lockCard(card, {
  by: 'expert_001',
  statement: 'I confirm this judgment.',
  checked: {
    applies_when: true,
    does_not_apply_when: true,
    failure_risk: true,
  },
});
studioProject.cards.push(card);
```

The maintained package also applies card-type-specific field checks before a
card can be locked. Handle validation errors instead of assuming every legacy
record can be locked unchanged.

### Validate stored projects before use

`project.loadProject` validates its input and rejects invalid records. Run
`project.validateProject` when importing stored project JSON and repair or
reconstruct invalid legacy records explicitly:

```js
const result = project.validateProject(storedProject);
if (!result.valid) {
  throw new Error(result.issues.join('\n'));
}

const loaded = project.loadProject(storedProject);
```

`project.upgradeProject` is not a general converter for projects created by
the historical package.

### Separate authoring output from runtime distribution

`compile.compileDomain(project)` produces authoring and review artifacts. It
does not produce the canonical public `.kdna` distribution by itself. Use
`exportRuntime.exportRuntimeAsset` for the current runtime entry set:

```js
const compiled = compile.compileDomain(loaded);
const runtimeAsset = exportRuntime.exportRuntimeAsset(loaded, { compiled });

console.log(Object.keys(runtimeAsset.files).sort());
// [ 'checksums.json', 'kdna.json', 'mimetype', 'payload.kdnab' ]
```

Update snapshots and downstream parsers for the current compile reports,
manifest, CBOR payload, checksums, and runtime-loading contracts. Do not treat
legacy compile JSON as the runtime distribution format.

## Surface comparison

The maintained package keeps the top-level `project`, `cards`, `compile`,
`quality`, `provenance`, `pipeline`, `governance`, and `i18n` responsibility
names. That name overlap does not imply behavioral or serialized-output
compatibility.

The maintained package also exposes `exportRuntime`, `creator`, and
`distillation` as stable top-level responsibilities. Experimental and internal
exports may change independently and are not migration anchors.

## What this migration does not promise

- No alias, compatibility wrapper, or automatic forwarding from
  `@aikdna/studio-core`.
- No automatic conversion of historical project JSON, cards, compiled files,
  snapshots, or test fixtures.
- No byte-for-byte or field-for-field equality with historical compile output.
- No compatibility with the historical Core `^0.3.0` dependency or the old
  Studio/CLI peer relationship.
- No support for package-internal deep imports or experimental/internal API
  stability.
- No claim that a structurally valid export contains good, applicable, or
  expert-approved judgment.
- No UI, hosted service, or command-line application in this package. Use the
  separately published Studio CLI when a command-line authoring workflow is
  required.

This guide documents the replacement coordinate but does not change the npm
registry metadata of the historical package.

This repository's registry smoke installs both exact coordinates into a new
temporary consumer, confirms the historical main-entry failure, and exercises
the maintained package main through project creation, immutable card review,
validation, compile, and canonical runtime export. Run it with:

```bash
npm run test:migration:registry
```
