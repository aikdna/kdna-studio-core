# Changelog

## 1.7.4 (2026-06-28)

Phase 11 audit follow-up. Closes 5 issues filed against the
kdna-studio-core repo (#15, #27, #28, #29, #30).

- **#15 / #28** `exportRuntimeAsset` now threads the project's
  source content (patterns / reasoning / evolution) through to
  `compileDomain` via `options.source`. Prior version passed no
  source, so `compileEvolution.sourceEvolution` was always `null`
  and `evolution.changelog` / `version_notes` were always `[]`. The
  v1 export path now round-trips the source's changelog and
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
silently dropping. Without 1.7.2, a `kdna-studio migrate --format v1`
that includes reasoning / framework / term / banned_term / aesthetic
/ ontology cards still loses them on the way into `payload.kdnab`
even when every card is Human Locked.

- **buildPayload now threads every compile output into the v1 payload.** Prior version only knew the original 6 judgment types and additionally mis-mapped `reasoning.failure_modes` to `reasoning.reasoning_chains`, putting the wrong object shape into a field whose schema is `misunderstanding`. Adds `core.ontology`, `core.frameworks`, `core.aesthetics`; threads `term` and `banned_term` from `patterns.terminology` into the `patterns` array; emits `reasoning_chains` separately from `failure_modes`; renames the field to `self_check` (singular) to match the source KDNA_Patterns and the payload-profile-v1 schema. Backward compatible: legacy readers can read the legacy field name from the same source.
- **compileCore.frameworks is no longer hardcoded `[]`.** A locked framework card is now collected alongside ontology / stances and surfaces in the v1 payload.
- **lockCard schema gate covers boundary / risk / aesthetic.** The prior gate only enforced for axiom and misunderstanding, which let boundary / risk / aesthetic lock with empty fields and produce fingerprints that did not reflect their actual content. Thresholds are conservative (presence, not length) so the gate does not reject reasonable short values like `name: "r1"`.
- **JUDGMENT_FIELDS now includes `name`, `description`, `mitigation`.** The fingerprint is computed across all of these so a Human Lock signature cannot be reused against a card whose only non-axiom fields were silently changed.
- **`compile` / `hasJudgmentContent` use a single shared `JUDGMENT_CARD_TYPES_FOR_COMPILE` set** covering axiom / ontology / misunderstanding / self_check / boundary / risk / aesthetic / scenario / case / stance / pattern / reasoning / framework / term / banned_term / evolution_stage. The two filters previously diverged; domains that contained only `reasoning` or `framework` cards used to fail with "refusing to compile empty domain" even when every card was Human Locked.
- **`buildManifest.load_contract.profiles` is now complete.** Prior version omitted `max_tokens_hint` for scenario and `selection` for full. Mirrors the studio-cli `buildV1Manifest` and the load-profiles spec.
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
  - Manifest declares `encryption.profile: kdna-password-protected-v1-scrypt`
  - Payload `encrypted` flag + load_contract `requires_decryption` dynamic
- Deps: bump @aikdna/kdna-core to ^0.15.0 (B2 scrypt profile)

## 1.6.0 (2026-06-23)
- Feat: RFC-0014 Card v2 fields.
- Feat: Product Runtime module (RFC-0011).

## 1.5.12 (2026-06-22)
- Deps: bump @aikdna/kdna-core to ^0.13.0

## 1.5.11 (2026-06-22)
- Fixed: compilePatterns() now extracts locked pattern cards and maps them to payload patterns field.
- Fixed: buildPayload() merges pattern cards into v1 payload alongside misunderstandings.
- Fixed: compileDomain empty-domain gate includes pattern and stance types.

## 1.5.10 (2026-06-22)
- Fixed: pattern added to CARD_TYPES array in cards/index.js.

## 1.5.9 (2026-06-22)
- compileCore now extracts locked stance cards; stance added to valid judgment content types; buildPayload includes stances field.

## 1.5.8 (2026-06-21)
- (pre-v1 GA cleanup release)
## 1.5.7 (2026-06-21)
- (pre-v1 GA cleanup release)

## 1.5.6 (2026-06-20)
- Align README package matrix with the current local `.kdna` CLI path: inspect, validate, plan-load, pack/unpack, load.
- Depend on `@aikdna/kdna-cli@^0.26.5` for corrected public CLI wording.

## 1.5.5 (2026-06-20)
- Clarify that Human Lock, signatures, and release evidence are optional provenance layers, not KDNA Core v1 format-validity requirements.
- Align README and npm package description with the public `.kdna` file model.

## 1.4.2 (2026-05-30)
- canonicalizeJson: strips authoring.content_digest to prevent self-referencing
- computeContentDigest: excludes reports/ and build-receipt

## 1.4.0 (2026-05-29)
- Creator Identity system: Ed25519 keypair, creator_id, passphrase encryption, key rotation
- Project model: source_mode (blank/kdna_asset/source_folder), creator_identity, lineage
- lockCard: schema gate for axiom full_statement/why, misunderstanding key_distinction
- compileManifest: outputs creator, lineage, source_mode
- provenance: source_mode, lineage tracking
- quality: source_mode trust differentiation

## 1.3.0 (2026-05-25)
- Initial public release
