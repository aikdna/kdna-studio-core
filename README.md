# KDNA Studio Core — current typed creation

Current release candidate: ordinary and component-rich authoring share one public Core/Read graph and one private creation evidence format2. Public exports are `createSession` and `verifyCreationEvidence`; see [the contract](docs/CURRENT-CREATION-CONTRACT.md) and `src/index.d.ts` for complete inputs and state rules.

Record materials, propose at least two real alternatives, obtain a channel-bound selection, review the current pre-compiler mapping and obtain a fresh final adoption reply. `exportAsset()` is pending until the embedding saves and reads back the file and calls `completeSave(bytes)`. Static reopening checks bindings and public observations, and never restores that live acceptance capability.

Human claims and authorized Agent editorial decisions are distinct recorded channels. Neither implies verified identity or permission to act. Private source text, alternatives and dialogues stay in private evidence; only explicit public notices/source declarations enter the runtime.

Legacy format1 evidence is rejected as noncurrent and remains usable only within its historically accepted release. This package does not load a second interpreter or silently convert old evidence.

## Dependency coordinates and publication

A direct declaration is either an exact SemVer or an integrity-locked `file:` coordinate. Placement follows what the documented entry needs: the vendored `@aikdna/kdna-core` and `@aikdna/kdna-read` pins belong in `dependencies`, because `npm ci --omit=dev --omit=optional` followed by `npm test` still passes with the development graph omitted. The package is `private`, and the peer that a vendored member declares is bound to this repository's own coordinate through `overrides`, so an unreadable vendor archive fails locally instead of sending npm to the registry.

Before publishing a release from this repository every `file:` coordinate must be replaced by the **exact registry version**, because a consumer that installs the packed artifact from a registry has no `vendor/` directory next to it. `npm run check:publish-coordinates` reports the coordinates that are still local (it is green here because the package is `private`).


## Current candidate preflight

The checked dependency graph binds Core `0.37.1-rc.browser.1`, Read
`0.11.2-rc.browser.1` and `fast-uri` `3.1.8`. The current source ledger is
`fixtures/runtime-candidates/current-sources.json`; `npm run verify:candidate-sources`
rebuilds its exact Git package trees and compares every installed tar member.
`npm run check:current-bindings` independently recomputes the complete dependency
member receipt. These checks execute for the current candidate; historical
registry fixtures and their retired API remain separate test material.

From a clean source checkpoint, `npm run candidate:generate-evidence -- --out
<outside-repository-evidence.json> --artifact <outside-repository-package.tgz>`
creates two byte-identical packs from exact committed blobs and validates their
independently parsed contents. Its candidate evidence schema cannot enter the
stable publisher. Candidate preflight does not establish registry availability,
verified editorial identity, real human acceptance or permission to publish.
The stable release event/tag policy and exact registry-coordinate gate remain
required before publication.
