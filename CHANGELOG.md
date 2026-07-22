# Changelog

## Unreleased

### Corrections

- Retract the identity-rotation claims made above and in the `1.4.0` entry
  below. `rotateIdentity` was never part of the module's exports and had no
  caller anywhere; it was only reachable because the test suite compiled the
  module source with the internal binding exposed. The previous "crash-safe
  rotation" fix therefore hardened dead code, and the dead implementation,
  its `kdna.key.previous` backup machinery, and the source-injection tests
  are now removed. **Studio Core 3.0.0 does not provide identity key
  rotation.** An identity is replaced by removing the identity directory and
  running init again.
- Correct the identity transaction record above. The hard-link commit-record
  transaction described there did **not** provide crash recovery: a process
  killed after the first file write left remnant key files in the canonical
  directory that blocked the next init, and the test suite only simulated
  recovery by deleting those remnants by hand. The transaction is now a
  staging directory plus a single atomic directory rename (see Fixed), and
  the crash tests are real SIGKILLed subprocesses whose recovery path
  deletes nothing manually.
- Correct the identity consistency model above. `loadIdentity` trusted
  `creator.json.public_key` without comparing it to `kdna.pub`, and
  `loadPublicKey` returned the raw file with no verification at all, so one
  identity directory could present two different public keys to different
  callers. The canonical identity is now exactly the three-file set
  (`kdna.key` + `kdna.pub` + `creator.json`) and every read path verifies it.
- Correct the envelope iteration contract above. The previous
  `[1, 4000000]` clamp accepted arbitrary positive iteration counts and
  justified the upper bound as headroom for future increases. A
  self-describing envelope is a compatibility mechanism for the counts that
  were actually written — exactly 100000 (historical) and 600000 (current) —
  and every other value is now rejected before the KDF runs. The headroom
  rationale is retracted.

### Fixed

- Make `initIdentity` a single atomic directory transaction. The three
  identity files are written and fsynced inside a mode-0700 sibling staging
  directory on the same filesystem, the staging directory is fsynced, and
  the identity is published by one atomic directory rename onto the
  canonical path (followed by a parent-directory fsync). The canonical
  directory never holds a subset of the identity files: before the rename
  it holds none of them, after the rename it holds all three. A process
  killed at any point leaves either a complete, mutually consistent
  identity or no valid identity, and the next init recovers without manual
  cleanup: staging remnants are removed only when they are provably
  transaction-owned (transaction naming shape, identity-files-only content)
  and their owner process is provably dead, and anything not provably owned
  by the transaction is never touched.
  Concurrent inits have exactly one winner — the first rename creates a
  non-empty directory and later renames fail instead of replacing it — and
  losers remove only their own staging, never the winner's identity. An
  existing complete identity is never overwritten.
- Reclaim staging remnants by owner liveness, never by directory age. The
  previous sweep treated any staging directory older than a 60-second grace
  as dead and deleted it even when the owner pid encoded in its name was
  still alive, so a slow or long-running init in another process could have
  its in-flight transaction deleted under it. A remnant is now removed only
  when its owner pid parses AND no live process holds it AND its contents
  are provably identity-transaction files; a live owner's staging is left
  untouched at any age, and remnants with unparseable owners or foreign
  files fail safe and are never auto-deleted.
- Give the identity transaction real commit semantics. The atomic directory
  rename is the logical commit point: a failure before it leaves no identity
  and is an ordinary, safely retryable init error. A failure of the
  parent-directory fsync AFTER the rename was previously reported as an
  ordinary init failure even though the complete identity already existed on
  disk — the API said failure while the disk said success. That post-commit
  durability failure now throws a stable machine-readable result instead:
  `code: 'IDENTITY_COMMITTED_DURABILITY_UNCONFIRMED'`, `committed: true`,
  `durabilityConfirmed: false`, plus `identity_dir` and the re-verified
  `creator_id`. The committed identity is re-checked through the full
  three-file consistency verification before the result claims it, the
  identity is never deleted or rolled back, a retry correctly reports that
  the identity already exists, and the error carries no private key
  material. These diagnostic fields are optional caller diagnostics, not
  part of any protocol schema. The successful return value of
  `initIdentity` is unchanged.
- Split post-commit verification failure from verified durability failure.
  A committed identity that re-verifies now reports
  `IDENTITY_COMMITTED_DURABILITY_UNCONFIRMED` with
  `identityVerified: true` and a verified `creator_id`. If the canonical
  three-file set fails re-verification after the rename, init instead reports
  `IDENTITY_COMMITTED_INCONSISTENT` with `committed: true` and
  `identityVerified: false`; it does not claim the identity is complete or
  safe to sign with, never deletes it, and gives a preserve-and-recover
  diagnostic without private key material.
- Give every pre-existing canonical identity state a stable code. Only a
  complete set that passes `loadIdentity` reports `IDENTITY_ALREADY_EXISTS`;
  a partial set reports `IDENTITY_INCOMPLETE`, and a present but inconsistent
  or damaged three-file set reports `IDENTITY_CORRUPT`. Classification never
  overwrites or removes existing files.
- `loadIdentity` now requires the full canonical identity and verifies it:
  `kdna.pub` must be a parseable Ed25519 public key; `creator.json`'s
  `public_key` (when present) must be the same key as `kdna.pub`;
  `creator_id` must equal the SHA-256 fingerprint of the normalized
  `kdna.pub`; and a plaintext `kdna.key` must derive that same public key
  (encrypted envelopes are verified at sign time, after decryption).
  Missing, replaced, tampered, or cross-copied files fail closed on every
  read path.
- `loadPublicKey` no longer returns the raw file. It returns the public key
  only after the same three-file consistency verification, returns null
  only when the directory holds no identity files at all, and rejects
  partial or inconsistent state.
- `signPayload` proves four-way consistency before signing: the public key
  derived from the private key, `kdna.pub`, `creator.json`'s public key,
  and the `creator_id` fingerprint must all be the same Ed25519 key.
- Harden `decryptPrivateKey` against hostile envelopes. Every structural
  check runs before the PBKDF2 derivation: the envelope must be a plain
  object with `encrypted === true`; `kdf` must equal `pbkdf2-sha256`
  exactly (previously an envelope naming a nonexistent KDF was still fed to
  the cipher); `iterations` must be exactly 100000 (historical envelopes)
  or 600000 (current writes) — every other value, including 1, 99999,
  100001, 599999, 600001, and 4000000, is rejected before the KDF runs;
  `salt` (16 bytes), `iv` (12 bytes), and `tag` (16 bytes) must be strict,
  canonical base64 of the exact contract length; `ciphertext` must be
  strict base64 decoding to at most 64 KB. The envelope being
  self-describing is a compatibility mechanism, not a security boundary.
- Raise the PBKDF2 iteration count for newly written private-key envelopes
  from 100000 to 600000 (OWASP recommendation for PBKDF2-HMAC-SHA256;
  supported by the pbkdf2 implementations of Node 18, 22, and 24).
  Historical 100000-iteration envelopes keep decrypting; no migration is
  needed. Those two counts are the complete compatibility range.
- README now states the exact Human Lock signature wiring status: the format
  layer verifies signatures when a manifest carries `author.public_key_pem`,
  but the current Studio pipeline neither attaches signatures to exports nor
  writes the key, so runtime signature verification is inert for Studio
  exports and no signature claim may be made.

### Verification

- `tests/creator-identity.test.js` exercises `src/creator-identity.js`
  through its public exports — no source injection. Crash coverage uses real
  subprocesses running the real `initIdentity` export while a watcher thread
  SIGKILLs the process the moment a commit phase becomes observable on the
  real filesystem:
  - pre-commit kills after the `kdna.key` write, after the `kdna.pub`
    write, and after the `creator.json` write: the canonical directory
    never holds a subset of the identity files, no read path accepts the
    state, and the next init recovers directly with no manual deletion
    (the recovery itself removes the provable staging remnant);
  - a kill immediately after the atomic rename leaves a complete identity
    that loads and signs with no recovery step;
  - four concurrent init subprocesses produce exactly one winner; losers
    fail with an explicit error and never overwrite or delete the winner's
    identity.
- Staging reclamation coverage uses a real two-process fixture: a live child
  process owns a provable staging remnant whose directory age is pushed past
  any age threshold, and another process's init leaves the staging and its
  staged files byte-for-byte intact; after the owner exits, the next sweep
  reclaims the remnant. Remnants with unparseable owner pids or foreign
  files are proven to survive the sweep untouched.
- Commit-semantics coverage injects fsync faults precisely at the two commit
  boundaries: a parent-directory fsync failure after the rename yields the
  machine-readable committed result (canonical three files present,
  `loadIdentity` and `signPayload` succeed, retry reports the existing
  identity, no private key material anywhere in the error), and a
  staging-fsync failure before the rename yields an ordinary error with no
  canonical state and a directly retryable init.
- Cross-tamper matrix: the `kdna.pub` of identity B placed in directory A,
  a `creator.json` naming a different public key than `kdna.pub`, a
  tampered `creator_id`, a deleted `kdna.pub`, a deleted private key, and a
  replaced private key are each rejected by `loadIdentity`,
  `loadPublicKey`, and `signPayload`.
- Add `tests/creator-identity-envelope.test.js` (hostile-envelope coverage
  for `decryptPrivateKey`, runnable standalone): unknown KDF names,
  non-integer iteration counts, and every integer count outside
  {100000, 600000} (1, 99999, 100001, 599999, 600001, 4000000, 2**40),
  malformed and non-canonical base64, wrong salt/iv/tag lengths, and
  oversized ciphertext — all rejected before the KDF runs; 100000 and
  600000 envelopes decrypt.
- CI gains focused identity jobs on macOS and Windows running only the two
  identity suites, so the directory-transaction primitives (rename
  semantics, directory fsync, watcher-thread SIGKILL) are proven on three
  platforms, not just Ubuntu.

### Breaking

- Set the corrective package coordinate to `3.0.0`. The published `2.0.2`
  package exposed `pipeline` as a semver-stable convenience API, so removing
  it cannot be represented by a `2.0.4` patch candidate.
- Remove these 2.x root exports from the 3.x package contract: `quality`,
  `pipeline`, `governance`, `testlab`, `delta`, `feynman`, `contradiction`,
  `validateCards`, `versioning`, `granularity`, and `packaging`.
- Remove these 2.x deep-import paths from the 3.x npm tarball:
  `src/cards/feynman.js`, `src/cli-bridge/`, `src/granularity.js`,
  `src/governance/`, `src/packaging/`, `src/pipeline.js`,
  `src/product-runtime/`, `src/quality/`, `src/testlab/`, and
  `src/versioning/`. Their repository sources may remain for regression and
  historical reference, but are not 3.x compatibility surfaces.

### Changed

- Limit the public package root and release tarball to the supported
  `source -> review -> confirm -> export` authoring path. Test Lab, Feynman,
  Quality, and Governance workshop sources remain in the repository but are
  not part of the package compatibility surface.
- Remove workshop-derived quality/evaluation reports and governance cards from
  the default compile output. Build, provenance, review, and receipt evidence
  remain available.

### Documentation

- Document the verified source-migration boundary from the historical
  `@aikdna/studio-core@1.2.1` package to
  `@aikdna/kdna-studio-core@2.0.2`, including immutable card operations,
  project validation, current Runtime export, and explicit non-promises.
- Correct the Quick Start card-review example so it keeps immutable state
  transition results before adding the card to a project.

The earlier unpublished `2.0.4` candidate coordinate is superseded by the
`3.0.0` breaking candidate. No `2.0.4` package was published and no registry
bytes are changed by this source correction.

### Verification

- Add a public-registry cold-install smoke for both exact package coordinates.
  The smoke records the historical package's missing-schema main-entry failure
  and exercises the maintained package main through project creation, card
  review, validation, compile, and canonical Runtime export.

## 2.0.4 (2026-07-20)

### Added

- Add an explicit `source -> review -> confirm -> export` facade while
  preserving every existing Studio public primitive and the complete project
  Schema.
- Record source type and source label for every facade-authored judgment, and
  require matching subject confirmation before synthesized content can claim
  to represent a person or organization.

### Fixed

- Stop labeling a newly created generic card as AI-authored when its source has
  not been declared.
- Bind the candidate to exact Core commit
  `3676ab0e4b54b83c4193eef3519b19cc6d0cd245`, which is reachable on current
  kdna history with an installable lockfile; the package tree differs from the
  previous pin only in README narrative.

This is an unpublished Development Preview candidate. No existing registry
version or package bytes are changed.

## 2.0.3 (2026-07-20)

### Fixed

- Require an explicit entitlement contract for licensed Runtime export instead
  of silently turning legacy `protected` input into a fabricated local receipt.
  Password export continues to declare the password entitlement explicitly.

This is an unpublished Development Preview candidate. No existing registry
version or package bytes are changed.

## 2.0.2 (2026-07-18)

### Fixed

- Preserve every authored axiom, relation, pattern, scenario, case, reasoning,
  and source-evolution field through Studio compile and Runtime export instead
  of projecting judgment through incomplete field allow-lists.
- Preserve `core_structure` relations and the public reasoning extensions
  `tradeoffs`, `conflict_resolution`, `when_not_to_use`,
  `evidence_required`, and `uncertainty_handling` in the Runtime payload.
- Treat Studio card-lock audit events as authoring provenance only. Runtime
  evolution now contains source-authored stages, layers, and measurements,
  without synthesizing one judgment-evolution stage per locked card.
- Bind Human Lock fingerprints to the complete, recursively canonicalized
  `card.fields` object. Changes to source references, relations, nested
  extensions, or future judgment fields now invalidate the prior lock.
- Preserve imported public manifest semantics such as summary, language,
  license, and keywords when a project is exported again.

## 2.0.1 (2026-07-17)

### Fixed

- Restore the npm auth chain for the release-publish step so the
  `setup-node` NPM_CONFIG_USERCONFIG reaches the publish command.
  Version 2.0.0 never formed a Registry artifact because the
  trusted-npm environment scrubbed the custom userconfig file injected
  by `actions/setup-node`; the publish now inherits the workflow step
  environment as the sibling CLI, MCP, and Remote Server publisher
  already do. No product content changed relative to 2.0.0.

## 2.0.0 (2026-07-16) — NOT PUBLISHED TO npm

- Bind the Core 0.20.0 dependency to the published registry artifact
  `@aikdna/kdna-core@0.20.0` (registry tarball SHA-256
  `b1614d14b77d6b8eac1c0a3902e2270a46cb0f52708e524b12b3990256ff8dee`,
  uncompressed tar byte-identical to the accepted source candidate). The
  package lock, runtime-candidate binding, and candidate evidence now point
  to the official registry tarball and its verified integrity; the registry
  release gate is open.
- Emit current responsibility-specific report types with independent `0.1.0`
  schema coordinates and ship schemas for all five report contracts.
- Emit the current manifest, payload, digest, encryption, LoadPlan, and Runtime
  Capsule names defined by KDNA Core 0.20.0; remove compatibility aliases and
  combined generation labels from producer output.
- Preserve declared judgment-core and card fields exactly through authoring
  JSON and CBOR export while validating the produced runtime package against
  the current Core.
- Depend directly on KDNA Core 0.20.0. The authoring library no longer installs
  the separate Runtime CLI as a transitive application dependency.
- Bind the published Core 0.20.0 artifact to its exact registry tar digests
  and require exactly one top-level Core copy across the complete lock graph.
  The recorded commit remains an audit source reference, not a cryptographic
  identity claim; the registry tar integrity and SHA-256 digest are
  authoritative. Clean installs now fetch the published artifact from the
  official registry, and the release gate accepts that registry resolution.
- Make the shipped Studio project Schema the single card-type authority for
  all 16 authoring card types; both project validation and card creation read
  that exact packaged schema instead of maintaining parallel enums.
- Normalize every Runtime manifest timestamp to a valid ISO date-time and
  reject malformed explicit timestamp input before an invalid asset can be
  returned.

This is a major package release because the emitted Runtime container,
responsibility-specific report contracts, and public project-schema contract
replace the output contract shipped by the 1.x line.

## 1.9.1 (2026-07-15)

- Require the exact released Runtime pair: KDNA CLI 0.33.0 and KDNA Core
  0.18.0, while preserving the existing Studio authoring compile/export
  behavior and default Runtime boundary.

## 1.9.0 (2026-07-14)

- Require the exact released Runtime pair: KDNA CLI 0.32.0 and KDNA Core
  0.17.0.

- Omit optional Runtime `creator` provenance when no real creator name is
  declared, instead of fabricating an `Unknown` identity; preserve declared
  creator names and IDs.
- Preserve explicitly declared `judgment_core` values from Studio project
  source through `KDNA_Core.json` and the CBOR runtime payload without
  substitution or reordering.
- Add a synthetic Golden Single-Asset fixture and fail-closed export checks for
  source-to-payload value loss. This is infrastructure fidelity evidence, not
  an author-quality, applicability, consumption, or conformance claim.

## 1.8.0 (2026-07-13)

- Compile and export complete judgment cards without treating Human Lock as a
  creation or loading permission.
- Keep Human Lock as optional provenance/review evidence, and retain an
  explicit `requireHumanLock` policy for workflows that choose to enforce it.
- Block empty projects based on the absence of complete judgment cards rather
  than the absence of approval records.
- Replace skip-on-error legacy CLI E2E checks with real runtime export, pack,
  validate, and inspect assertions; harden the release tag/cleanliness gate.
- Align runtime export and validation with KDNA Core 0.16.0 and CLI 0.31.0,
  including account/device entitlement support in the shared runtime.

## 1.7.13 (2026-07-13)

- Identify the intermediate Studio compile manifest and CBOR payload as
  Studio authoring artifacts instead of advertising a second KDNA container
  generation. Runtime export continues to emit the single current KDNA Asset
  Container through `exportRuntime`.

## 1.7.12 (2026-07-13)

- Make Argon2id the password-protected export profile so JavaScript and Swift
  runtimes consume the same newly written encrypted assets.
- Keep the scrypt profile readable in JavaScript Core for compatibility; new
  Studio exports no longer write it.

## 1.7.11 (2026-07-13)

- Emit the single current KDNA runtime contract: CBOR payloads and CBOR
  password envelopes with `payload.encoding: "cbor"`.
- Replace the versioned runtime MIME constant with the unversioned public
  `MIMETYPE` export.
- Align runtime conformance metadata and dependencies with KDNA Core 0.15.12
  and KDNA CLI 0.30.0.
- Update public documentation to distinguish authoring compile artifacts from
  the canonical runtime export.

## 1.7.10 (2026-07-03)

- Add NOTICE file for Apache 2.0 attribution
- Expand SECURITY.md with private vulnerability reporting, supported versions, and governance link
- Add bugs/homepage metadata to package.json
- Include LICENSE and NOTICE in published tarball


## 1.7.9 (2026-07-01)

- Preserve locked `evolution_stage` cards in `KDNA_Evolution.json` as
  `source_authored: true` stages. This prevents
  source-folder import → canonical export → asset re-import
  from silently dropping source-authored evolution stages.

## 1.7.8 (2026-07-01)

Normalize runtime routing fields — stringList helper ensures applies_when / does_not_apply_when / acceptable_exceptions always emit as arrays from Studio card fields (#34).


## 1.7.7 (2026-06-28)

UX pass — fix the #4 entry-point inconsistency.

- `compileReasoning` now tags axiom-synthesised reasoning chains
  with `source_authored: false`. The canonical Studio CLI importer
  skips these on round-trip so a
  project with 1 axiom + 1 misunderstanding + 1 self_check stays
  at 3 cards after canonical export plus `create --from-kdna`,
  not 4 or 5.

## 1.7.6 (2026-06-28)

Phase 12 audit follow-up. Closes the residual half of #145.

- **#145** (residual) `buildPayload` now copies
  `failure_risk` / `applies_when` / `does_not_apply_when` from each
  misunderstanding card into the published `failure_modes` entry.
  Prior version dropped these three fields even though
  `compilePatterns` wrote them on the producer side, so a
  misunderstanding card round-trip through canonical export
  lost them. End-to-end verified: a Studio project with
  `failure_risk='risk!'`, `applies_when=['a1','a2']`,
  `does_not_apply_when=['d1']` now round-trips all three fields
  through `migrate` → `kdna load`.

## 1.7.5 (2026-06-28)

Phase 12 audit follow-up. Closes #66 (cross-repo).

- **#66** `addEvidence` now writes to BOTH `project.evidence` and
  `project.evidence_materials`. Prior version wrote only to
  `project.evidence`, which made every consumer that read
  `evidence_materials` (cmdFilter, cmdSourceClassify, cmdDistill)
  see an empty list. The dual-write keeps the legacy `project.evidence`
  field working (still used by the studio UI's evidence_room
  display) and makes the canonical `evidence_materials` field stay
  in sync.

## 1.7.4 (2026-06-28)

Phase 11 audit follow-up. Closes 5 issues filed against the
kdna-studio-core repo (#15, #27, #28, #29, #30).

- **#15 / #28** `exportRuntimeAsset` now threads the project's
  source content (patterns / reasoning / evolution) through to
  `compileDomain` via `options.source`. Prior version passed no
  source, so `compileEvolution.sourceEvolution` was always `null`
  and `evolution.changelog` / `version_notes` were always `[]`. The
  canonical export path now round-trips the source's changelog and
  version_notes when the project was created via `create --from-kdna`
  (which now stores `source_patterns` / `source_reasoning` /
  `source_evolution` on the project).
- **#27** `buildPayload` now forwards `core.core_structure` to the
  payload. The compile side already produced the field; the export
  side silently dropped it.
- **#29** Documented the intent of `buildPayload`: source-KDNA_*
  meta fields (version / domain / created / purpose / load_condition)
  are compile-time metadata, not part of the runtime payload
  contract. The payload's own top-level `meta` is built from
  `project.release` instead.
- **#30** `parseJsonFile` now guards against a non-object `files`
  argument. A caller that passes a partially-constructed `compiled`
  gets the configured fallback rather than a TypeError.

## 1.7.3 (2026-06-28)

Phase 10 audit follow-up. Closes 4 issues filed against the
kdna-studio-core repo (#23, #24, #25, #26).

- **#23 Human Lock gate now covers all 16 judgment card types.**
  `JUDGMENT_CARD_TYPES` was expanded from 4 types to all 16 entries
  in `CARD_TYPES`. The 12 previously-uncovered types (ontology,
  misunderstanding, self_check, scenario, case, stance, pattern,
  reasoning, framework, term, banned_term, evolution_stage) now
  trigger the gate on export the same way axioms do.
- **#24 `compileEvolution` preserves the source's evolution_layers
  / measurement / changelog / version_notes.** Prior version
  hard-coded the synthesised arrays and dropped the source's own
  entries; now they pass through marked `source_authored: true`.
- **#25 `compileReasoning` honours `sourceReasoning.reasoning_chains`
  as a fallback.** The parameter was previously dead code — a
  function never read it. The new code path activates when no
  `reasoning` Studio card was authored but the source's
  KDNA_Reasoning.json carries chains, so the source's identity
  reaches the structured payload.
- **#26 The "refusing to compile empty domain" error message
  derives the type list from `JUDGMENT_CARD_TYPES_FOR_COMPILE`
  instead of hard-coding 9 stale names.**

Test update: `tests/human-lock-gate.test.js` was rewritten to
exercise all 16 types as judgment-bearing.

## 1.7.2 (2026-06-28)

Audit follow-ups (2026-06-28 round-trip verification). This release is
required to keep the round-trip path intact for the eight card types
that compile/index.js was tracking but export-runtime/index.js was
silently dropping. Without 1.7.2, the former explicit-format migration path
that includes reasoning / framework / term / banned_term / aesthetic
/ ontology cards still loses them on the way into `payload.kdnab`
even when every card is Human Locked.

- **buildPayload now threads every compile output into the canonical payload.** Prior version only knew the original 6 judgment types and additionally mis-mapped `reasoning.failure_modes` to `reasoning.reasoning_chains`, putting the wrong object shape into a field whose schema is `misunderstanding`. Adds `core.ontology`, `core.frameworks`, `core.aesthetics`; threads `term` and `banned_term` from `patterns.terminology` into the `patterns` array; emits `reasoning_chains` separately from `failure_modes`; renames the field to `self_check` (singular) to match the source KDNA_Patterns and the current payload-profile schema.
- **compileCore.frameworks is no longer hardcoded `[]`.** A locked framework card is now collected alongside ontology / stances and surfaces in the canonical payload.
- **lockCard schema gate covers boundary / risk / aesthetic.** The prior gate only enforced for axiom and misunderstanding, which let boundary / risk / aesthetic lock with empty fields and produce fingerprints that did not reflect their actual content. Thresholds are conservative (presence, not length) so the gate does not reject reasonable short values like `name: "r1"`.
- **JUDGMENT_FIELDS now includes `name`, `description`, `mitigation`.** The fingerprint is computed across all of these so a Human Lock signature cannot be reused against a card whose only non-axiom fields were silently changed.
- **`compile` / `hasJudgmentContent` use a single shared `JUDGMENT_CARD_TYPES_FOR_COMPILE` set** covering axiom / ontology / misunderstanding / self_check / boundary / risk / aesthetic / scenario / case / stance / pattern / reasoning / framework / term / banned_term / evolution_stage. The two filters previously diverged; domains that contained only `reasoning` or `framework` cards used to fail with "refusing to compile empty domain" even when every card was Human Locked.
- **`buildManifest.load_contract.profiles` is now complete.** Prior version omitted `max_tokens_hint` for scenario and `selection` for full. Mirrors the Studio CLI runtime manifest builder and the load-profiles spec.
- `tests/empty-domain-gate.test.js` updated to exercise the empty-domain guard with a genuinely non-judgment card type, since `term` is now judgment-bearing.

## 1.7.1 (2026-06-27)
- Fix (PC-3): `exportRuntimeAsset` no longer injects the legacy
  placeholder ("Load when the task matches applies_when on domain
  axioms.") into `core.highest_question` as if it were a real
  question. The placeholder is detected as "unset" and the
  fallback chain runs: author's real `load_condition` (if they
  overrode the default) → first axiom's `one_sentence` (a domain
  with axioms has a question) → explicit
  `(unset — author should set load_condition in project meta)`.
  Consumers of the published asset can now distinguish "no question
  set" from "domain about axiom loading". No code path changed for
  assets that have a real `load_condition` set; only the
  misleading default is gone. `compile/index.js` `makeMeta` default
  is unchanged (schema requires non-empty), but now has a
  comment pointing to the export-runtime detection.
- CI: `package-lock.json` regenerated to resolve `@aikdna/kdna-core`
  from registry at 0.15.2 (the latest with PC-2 boundary render
  fix). The pre-1.7.1 lockfile was resolving kdna-studio-cli's
  transitive `@aikdna/kdna-core` at 0.12.6, which broke the new
  boundary test in `tests/runtime-export.test.js` on CI.

## 1.7.0 (2026-06-27)
- B2: encrypt payload via scrypt profile when password is provided
  - `exportRuntimeAsset` encrypts `payload.kdnab` with `encryptProtectedEntryScrypt`
  - Forces `access: licensed` + `entitlement.profile: password` for encrypted exports
  - Manifest declares the password-protected encryption profile
  - Payload `encrypted` flag + load_contract `requires_decryption` dynamic
- Deps: bump @aikdna/kdna-core to ^0.15.0 (B2 scrypt profile)

## 1.6.0 (2026-06-23)
- Feat: RFC-0014 expanded card fields.
- Feat: Product Runtime module (RFC-0011).

## 1.5.12 (2026-06-22)
- Deps: bump @aikdna/kdna-core to ^0.13.0

## 1.5.11 (2026-06-22)
- Fixed: compilePatterns() now extracts locked pattern cards and maps them to payload patterns field.
- Fixed: buildPayload() merges pattern cards into the canonical payload alongside misunderstandings.
- Fixed: compileDomain empty-domain gate includes pattern and stance types.

## 1.5.10 (2026-06-22)
- Fixed: pattern added to CARD_TYPES array in cards/index.js.

## 1.5.9 (2026-06-22)
- compileCore now extracts locked stance cards; stance added to valid judgment content types; buildPayload includes stances field.

## 1.5.8 (2026-06-21)
- (pre-GA cleanup release)
## 1.5.7 (2026-06-21)
- (pre-GA cleanup release)

## 1.5.6 (2026-06-20)
- Align README package matrix with the current local `.kdna` CLI path: inspect, validate, plan-load, pack/unpack, load.
- Depend on `@aikdna/kdna-cli@^0.26.5` for corrected public CLI wording.

## 1.5.5 (2026-06-20)
- Clarify that Human Lock, signatures, and release evidence are optional provenance layers, not KDNA Core format-validity requirements.
- Align README and npm package description with the public `.kdna` file model.

## 1.4.2 (2026-05-30)
- canonicalizeJson: strips authoring.content_digest to prevent self-referencing
- computeContentDigest: excludes reports/ and build-receipt

## 1.4.0 (2026-05-29)
- Creator Identity system: Ed25519 keypair, creator_id, passphrase encryption, key rotation (the "key rotation" claim is retracted: rotation was never exported or reachable — see the Unreleased Corrections entry)
- Project model: source_mode (blank/kdna_asset/source_folder), creator_identity, lineage
- lockCard: schema gate for axiom full_statement/why, misunderstanding key_distinction
- compileManifest: outputs creator, lineage, source_mode
- provenance: source_mode, lineage tracking
- quality: source_mode trust differentiation

## 1.3.0 (2026-05-25)
- Initial public release
