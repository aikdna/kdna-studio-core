# Changelog

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
