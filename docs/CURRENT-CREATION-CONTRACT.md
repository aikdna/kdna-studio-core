# Current Studio creation contract

This release uses one current Core 0.24.0-rc.component-semantics.2 / Read 0.3.0-rc.component-semantics.2 graph. Component semantics is the public `/components` descriptor with D `sha256:3087cd19542e72322aec19b3015c916d2cfb074fa42e3fd76b3756bb4f097de3`. Studio provides authoring-to-wire mapping and a live creation lifecycle; Core alone interprets component content. No profile, public definition, native protocol ID, arbitrary module, trust provider or compiler callback is accepted from the authoring caller.

## Publication coordinate

| Item | Value |
|---|---|
| Local candidate version | `4.0.0-rc.components.1` |
| Published `latest` of the same package | `3.0.0` |
| Candidate publication state | Unpublished. `package.json` is `private`, and every `file:` coordinate must be replaced by an exact registry version before any release |
| Bound peers | Core `0.24.0-rc.component-semantics.2`, Read `0.3.0-rc.component-semantics.2` |

The candidate deliberately has its own coordinate. It is **not** a compatible
update of `3.0.0`, and describing it as "Studio 3.x" would merge two
incompatible products under one number.

### Breaking changes against the published `3.0.0`

- Root exports are `createSession` and `verifyCreationEvidence`. The published
  `3.0.0` surface (`creationEngine`, Studio project, cards, `compile`) is a
  different API and is documented separately in
  [`creation-contracts.md`](./creation-contracts.md).
- Creation evidence is format2 (`kdna.studio-creation-evidence/2`). Format1 and
  unversioned evidence are rejected with `STUDIO_EVIDENCE_FORMAT_NOT_CURRENT`;
  there is no automatic conversion, relabeling or fallback to an old Core.
- At least two distinct semantic alternatives per judgment group are required,
  and adoption arrives through a separately owned live channel rather than a
  stored approval flag.
- Static reopening cannot restore `accepted_with_live_context`; the saved-byte
  read-back is the only path to that status.

### Minimal example

The callbacks below are owned by the embedding, not by this package. A test
callback executing is synthetic provider execution, never proof of a real
editorial decision.

```js
import { createSession, verifyCreationEvidence } from '@aikdna/kdna-studio-core';

const session = createSession({
  agent: { name: 'example-agent', version: '0.1.0' },
  adoptionInput: {
    kind: 'human_claim_unverified',
    channel: 'terminal',
    receive: askTheReviewer, // embedding-owned live channel
  },
  interpretReply: interpretNaturalLanguage, // embedding-owned
});

session.agent.setBrief({ title: 'Example judgment', scope: 'one bounded topic' });
session.agent.recordMaterial({
  kind: 'text',
  title: 'notes',
  content: '…',
  coordinate: 'material:notes',
});
session.agent.propose({ localKey: 'group-1', alternatives: [/* >= 2 distinct */] });
session.agent.compilePreview();
await session.receiveAdoptionReply();

const { bytes, evidence, binding } = session.exportAsset(); // pending save
// the embedding saves bytes and reads them back, then:
const saved = session.completeSave(readBackBytes); // accepted_with_live_context
verifyCreationEvidence(bytes, evidence, binding);
```

### Support scope

Supported: one current graph, ordinary prose and explicit mechanism authoring,
role-separated adoption channels, export to a new private directory and
saved-byte verification. Not supported in this candidate: the published `3.0.0`
project/card API, importing or converting old evidence, persistent resume of a
previous candidate's workspace, signing or identity services, and any claim of
verified identity, action authorization or storage durability.

Root exports remain `createSession` and `verifyCreationEvidence`. Both ordinary prose and explicit mechanism authoring use this current pipeline. Format1 and unversioned creation evidence receive `STUDIO_EVIDENCE_FORMAT_NOT_CURRENT`; there is no automatic relabeling, conversion or fallback to an old Core. Earlier accepted releases and evidence keep their historical scope separately.

## Typed authoring

`createSession({agent, adoptionInput, interpretReply, syntheticFixture?})` captures Host callback references and immutable JSON options. `adoptionInput` is either `{kind:'human_claim_unverified',channel,receive}` or `{kind:'delegated_agent_editorial',channel,authorization:{coordinate,statement},receive}`. Each callback returns an actual message `{id,role,channel,review_id,text}`; role must be `human` for the first channel and `agent` for the second. Delegation is a recorded claim supplied by the trusted embedding, not an identity credential. A test callback executing is synthetic provider execution, not proof of a real editorial decision.

The Agent sets `{title,scope}`, records text/interview materials `{kind,title,content,coordinate}`, then proposes judgment groups `{localKey,alternatives}`. At least two distinct semantic alternatives per group are required. A candidate carries `{localKey,title,subject,scope,statement,rationale,materialRefs}` and optional `method`, `formationRule`, `publicSources`, `publicNotices`. `revise(localKey,{baseRevision,alternatives,explanation})` replaces the current proposal only with an exact revision match and retains previous alternatives and explanation in the audit.

`method` is optional; absence stays absent. If present, it is `{method:TermRef,components?,bindings?}`. Missing own components/bindings remain undeclared. Explicit arrays, including `[]`, remain declared. Null, owned undefined, extras or local references without targets reject; no missing value is replaced by authored emptiness. A component is `{localKey,type,content,statement?}`. Types are taxonomy, candidate-set, discriminator-set. Content imports the exact shared public item/edge/discriminator types; only discriminator `candidateSetRef` is replaced in authoring input by `candidateSetLocalKey`. Item key/title/meaning are required by the public grammar. Bindings are `{componentLocalKey,role}` and always target the same owning judgment.

If `formationRule:{conditions}` is explicitly present, `statement` becomes the native formation rule statement, conditions are copied exactly, and no fixed result is invented. Only interpreted conditions `{kind:'interpreted',statement}` are authored through this bounded entry. An explicitly empty overall condition set remains empty. If formationRule is absent, statement becomes the ordinary text result. Candidate comparison criteria stay within their respective candidates/contrasts and are never conjoined into an overall premise.

Private material content, file coordinates, dialogue, alternatives and decisions remain only in private creation evidence. The runtime receives only selected judgment content and explicitly authored `publicSources` and `publicNotices`. A public source is `{localKey,identity,version?,digest?,uses:[{localKey,role,componentLocalKey?}]}`. A notice is `{localKey,statement,sourceLocalKeys}`. Explicit notice text becomes a referenced native attachment material. There is no automatic conversion of a private source path into a public source identity.

## Versioned materialization

`ruleId = kdna.studio-materialization/2`. H is SHA-256 over strict canonical JSON UTF-8, with UTF-16 object-key ordering and original array order. Local keys are ASCII `^[a-z][a-z0-9-]{0,63}$`. Judgment id is `judgment:` plus the complete lowercase H hex of `[ruleId,'judgment',asset_id,judgmentLocalKey]`; component id similarly hashes `[ruleId,'component',asset_id,judgmentLocalKey,componentLocalKey]`. Version is bound in the complete context but intentionally not in these stable IDs. Duplicate local keys within the owner or any generated protocol-ID collision reject; there is no truncation, suffix retry or title matching.

The same mint rule applies to `result-contract` and `reason` with `[ruleId,kind,asset_id,judgmentLocalKey]`; `source` with an additional sourceLocalKey; `source-use` with sourceLocalKey and useLocalKey; `material` with noticeLocalKey. Components are bound to their owner; source-use either targets that owner or its explicit local component. All source and notice references resolve before output. The Core regards generated IDs as opaque and validates actual ownership.

Selected input and descriptor determine the entire manifest/payload and expected component map before Compiler runs. Descriptor fields, native components, raw content, statement origin, every role/binding, authored presence, asset identity/version, source/material mapping and proposal/decision digests are captured. Missing component statement is mechanically represented by canonical content JSON and marked as such; it is not invented authored prose. Public component adoption contains complete declaration/proposal sets and the real session decision digest. Presence-only authoring emits no empty adoption record. Public graph grammar/limits and interpretation are checked by the pinned Core before invoking Compiler.

## Lifecycle and saving

A synthetic or real provider reply is a data input, not an authorization grant. Replies are interpreted as select, note, reject or confirm; selection must choose exactly one current alternative per judgment group. `compilePreview()` returns a complete pre-compiler review. Input changes invalidate it. Final confirmation binds the exact current review and full private context, and moves the session to confirmed. There is no second confirmation or mutation of confirmed state; abort is terminal.

A module-private WeakMap holds a one-shot context. `exportAsset()` burns it, independently prepares expected bytes and Core observations before calling Compiler on its clone, and rejects a different Compiler output even if freshly re-signed and technically valid. The result is `{bytes,evidence,binding,verification:{status:'pending_saved_readback',creation_accepted:'not_evaluated'}}`.

The embedding saves bytes, captures the actual saved file again, then calls `completeSave(actualReadbackBytes)`. That operation burns the pending save even on failure, invokes fresh public Core admission and checks the exact pre-compiler byte expectation, asset, judgments, method presence and complete component interpretations. Success is `accepted_with_live_context`; it states no verified person/device identity, no action authorization and no filesystem durability guarantee supplied by the library. CLI additionally performs its own actual exclusive save/readback before a completion marker. Abort, failure or process termination cannot reconstruct the live capability from JSON.

## Private evidence format2

The closed envelope contains `format:{id:'kdna.studio-creation-evidence/2',version:'2.0.0'}`, exact `reference_contract`, `component_definition`, current `compiler`, `session_id`, `revision`, captured `context`, `decision`, complete `history`, `expected_component_bindings`, `presence`, `adoption`, `artifact:{bytes,digest}`, and fixed limitation fields `identity:not_verified`, `action_authorization:not_evaluated`, `creation_accepted:not_evaluated`.

The private context contains the original materials and their UTF-8 hashes, all proposal alternatives and revisions, complete selection history, author identity claims, channel kind/name, delegation record or null, complete asset identity/version and the fixed graph version. Decision binds context and preview digests, complete proposal set and actual reply plus Agent interpretation. The hash chain is replayed against the captured state; material, revision, selection, final review and final history consistency are checked independently of a claimed flag.

`verifyCreationEvidence(bytes,evidence,expectedBinding)` requires the external `{session_id,asset_digest,evidence_digest}` binding. It compares actual Core admission and the complete public Canonical IR from the independently reconstructed plan, not ZIP/CBOR byte equality across providers. This allows genuine peer-provider encodings while binding exact actual A and exact private evidence hash externally. Current producer coordinates are JS `@aikdna/kdna-studio-core / 4.0.0-rc.components.1` and Swift `KDNAStudioCore / 0.6.0-rc.components.1`; artifact SHA UNKNOWN is explicitly unproved, not a trusted registry signature.

Static consistent means external byte/evidence bindings, public observations and the private audit agree. It does not establish that a caller-supplied binding or transcript is authentic, replay a live capability, verify execution identity, or authorize an action. Static results always retain `creation_accepted:not_evaluated` and `live_context:unavailable`. Cross-provider tests, installed exact package checks and live saving are separate evidence layers.
