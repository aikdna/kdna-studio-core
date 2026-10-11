# KDNA Studio Core — current typed creation

Studio Core `4.0.0`: ordinary and component-rich authoring share one public Core/Read graph and one private creation evidence format2. Public exports are `createSession` and `verifyCreationEvidence`; see [the contract](docs/CURRENT-CREATION-CONTRACT.md) and `src/index.d.ts` for complete inputs and state rules. The historical `3.0.0` project/card API has a separate compatibility contract.

Record materials, propose at least two real alternatives, obtain a channel-bound selection, review the current pre-compiler mapping and obtain a fresh final adoption reply. `exportAsset()` is pending until the embedding saves and reads back the file and calls `completeSave(bytes)`. Static reopening checks bindings and public observations, and never restores that live acceptance capability.

Human claims and authorized Agent editorial decisions are distinct recorded channels. Neither implies verified identity or permission to act. Private source text, alternatives and dialogues stay in private evidence; only explicit public notices/source declarations enter the runtime.

Legacy format1 evidence is rejected as noncurrent and remains usable only within its historically accepted release. This package does not load a second interpreter or silently convert old evidence.

## Dependency coordinates and publication

The package declares exact registry dependencies on Core `0.37.2`, Read `0.11.3` and `cbor-x` `1.6.5`; it has no `private` field or `file:` dependency. Required peers are bound to the same root coordinates through `overrides`. The committed vendor archives anchor the complete installed member receipt, while the lock records exact registry URLs and integrity values.

`npm run check:publish-coordinates` rejects local dependency declarations in a publishable package. Release publication also requires the real registry to serve every required dependency with the locked integrity; a locally built archive alone does not satisfy that gate.


## Source and release verification

The dependency graph binds Core `0.37.2`, Read
`0.11.3` and `fast-uri` `3.1.8`. The current source ledger is
`fixtures/runtime-candidates/current-sources.json`; `npm run verify:candidate-sources`
rebuilds its exact Git package trees and compares every installed tar member.
`npm run check:current-bindings` independently recomputes the complete dependency
member receipt. These checks execute for the current graph; historical
registry fixtures and their retired API remain separate test material.

In the stable release context, `npm run release:generate-evidence -- --out
<outside-repository-evidence.json> --artifact <outside-repository-package.tgz>`
creates two byte-identical packs from exact committed blobs and validates their
independently parsed contents. It requires a clean checkout, the exact version
tag and the matching release commit. The stable publisher also requires a
published, non-draft, non-prerelease event and exact registry dependency
integrities. Prerelease evidence cannot enter that publisher. Local checks do
not establish registry availability, verified editorial identity, real human
acceptance or permission to publish.
