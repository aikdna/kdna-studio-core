# Creation Engine source contracts

Status: unreleased Studio Core source candidate. These contracts describe the
checked-in candidate, not the currently published npm package and not a claim
that every terminal Host supports Creation.

## Product boundary

The Creation Engine turns an ordinary-language goal and optional, explicitly
authorized material into a recoverable private workspace. It compiles a
managed `.kdna` test candidate, but it does not make an incomplete candidate a
user delivery, publish a file, authenticate a real person, or replace the
official Runtime.

The public `.kdna` format is unchanged. Workflow, authority, interview,
material-processing, confirmation, semantic-test, and application evidence
remain private Studio state.

## Two honest axes

`workflow_mode` describes execution only:

- `collaborative` — the Host asks the user at the intended decisions;
- `autonomous` — the Agent continues reversible work and uses an allowed
  independent evaluator without fabricating human authority.

`mode` describes judgment authority:

| Mode | Permitted claim | Acceptance boundary |
|---|---|---|
| `agent-authored` | The declared Agent authored the bounded judgments | A distinct independent Agent evaluator or an eligible non-Agent may accept |
| `human-confirmed` | A named human represents the current judgment | That human confirms the exact current semantic digest |
| `organization-confirmed` | An authorized actor represents an organization | Matching subject, scope, authority, and current-digest confirmation |
| `interpretive` | The asset is a bounded interpretation of named sources | Source-grounded independent evaluation; never represents the source author |
| `mixed-authorship` | Human and Agent both made substantive judgment-content contributions | Unit-scoped contribution evidence; the human confirms only the human-contributed current content |

Human participation or assistance is a receipt, not an authority mode.
Creating and evaluating Agents must be distinct where independent Agent
acceptance is permitted. A creating Agent cannot self-accept. No workflow value
implies an authority value, and no mode or receipt is projected into Runtime as
human identity, Human Lock, or public representation provenance.

Both axes are explicit for new workspaces. Older private workspace shapes
require an explicit, auditable migration; the Engine does not guess a new
authority from an obsolete combined label.

## Private workspace

Every mutation returns a new workspace and records one history event. A
semantic mutation advances the private semantic revision once, recomputes the
semantic digest once, invalidates downstream evidence, and updates affected
judgment versions. An exact operation retry is inert; stale or conflicting
operation reuse fails closed.

The workspace persists through atomic replacement and validates against the
shipped private JSON Schema. It contains indexes, digests, receipts, and
Host-bound recovery coordinates, but not raw source bodies, passwords,
decrypted Runtime payloads, or role private keys. Load distinguishes an
unsupported workspace schema from a generically malformed workspace.

The public status uses:

- `compile_ready` for readiness to build a managed test candidate;
- `judgment_accepted` for the second Creation gate;
- `completion_gates.format_valid`;
- `completion_gates.judgment_accepted`;
- `completion_gates.application_verified`;
- `completion_gates.creation_complete`.

Compile readiness is not `FORMAT_VALID`, and Judgment Acceptance is not
Creation Complete.

## Purpose and judgment scale

A purpose needs a bounded objective, scope, loading condition, and honest
non-goals or global boundaries. Non-goals and boundaries may reference or
semantically map to one another; they need not repeat identical strings.
Contradictions and a completely unconstrained purpose fail closed.

One complete Judgment Unit can be sufficient. A unit states:

```text
statement
rationale
applies_when
does_not_apply_when
misuse_risk
source_refs
counterexample_search
confidence
confidence_reason
card_type
```

`card_type`, creator identity, interview actor, authority, and source
classification are explicit. The Engine does not default an unknown card to
`axiom`, an absent creator to a synthetic Agent, an interview actor to `user`,
or an imported source to `supporting`.

Actual contrary evidence may be empty. `counterexample_search` records the
bounded method, scope, result, and residual uncertainty. “None found” is not
evidence and a placeholder must not be presented as contrary evidence.

Highest question, worldview, ordered values, judgment role, priority,
exception, and other core structures are optional unless the asset actually
declares them. Once declared, they must be internally complete and consistent.
The Engine never requires a correction or a relation merely to match a
fixture. A digest-bound review may honestly record `reviewed-no-change`.

## Source and interview grounding

Source authorship, judgment authorship, and evidential influence are separate.
An Agent-authored asset may synthesize foreign sources without representing
their authors. An interpretive asset may contain Agent inference when it
remains source-bound and explicitly non-representational. A proposed Agent
inference may become human- or organization-confirmed only through a matching
current-digest representation receipt.

Human-confirmed zero-file work is possible through a structured,
digest-bound interview answer by the represented human. Organization-confirmed
interview grounding additionally binds the authorized actor and scope.
Interpretive work without material is not source-grounded.

Interview answers bind the question, explicit actor and subject, operation,
pre-answer semantic coordinate, answer digest, and source references. Their
privacy-safe normalized representation participates in the private semantic
digest, so changing or removing an answer invalidates confirmations, tests,
builds, and application evidence.

Imported KDNA cards receive a complete mapping report. Every source card is
`mapped`, `evidence-only`, `unsupported-with-reason`, or `user-excluded`.
Potential judgment content cannot disappear through a silent filter.

## Material inventory and delivery

Directory input begins with a content-free inventory. Readable entries are
`eligible` or `awaiting-approval`; they are not accepted and
`approved_for_content_read` is false until exact-digest approval.

The inventory:

- shows relative display paths and per-item status;
- excludes VCS metadata, dependencies, common build/cache output, the
  workspace, managed candidates, output paths, and secret-like files by
  default;
- reports unsupported, unreadable, excluded, exact duplicate,
  near-duplicate, uncertain, and failed items rather than silently dropping
  them;
- probes extractor capabilities before content processing;
- treats operation file/byte limits as recoverable batching, not product
  material-count limits;
- advances a continuation past already ingested unchanged entries.

This source candidate does not implement offset continuation inside a single
oversized text file. Inventory reports that capability gap explicitly; an
approved split copy must preserve order and full coverage rather than silently
dropping the remainder.

Approval binds the inventory digest and an explicit material-processing
policy: local-only, a named remote processor with declared boundary, or
prohibited, plus a declared assurance level. A generic caller-supplied
capability digest is only `host-declared`; it cannot prove that processing
stayed local. A verified-local requirement needs a separately trusted Host
adapter and otherwise fails before content delivery. Directory-read permission
is not remote-processing consent. Destination, provider, capability, path
identity, or byte drift invalidates the approval.

Approved content is delivered through a bounded Host-private channel. Exact
bytes are hash-checked before and after delivery and are not placed in normal
JSON, stdout, stderr, logs, or Runtime. Regular private output files must be no
more permissive than mode 0600 and must not alias stdout or stderr.

Direct text uses strict UTF-8 and never silently truncates. PDF/word-processing
support is capability-probed and reports extraction coverage, empty output,
and OCR needs. For image, audio, video, or other Host-observed material, the
source is stream-hashed and a bounded observation binds the source digest,
media type, Host/tool coordinate, output digest, coverage, and uncertainty.
Unsupported formats remain visible and may be excluded or supplied through a
valid observation; one irrelevant binary does not abort an otherwise safe
directory.

Exact byte duplicates are deduplicated across operations and batches. A
changed file at the same path is a new review coordinate. Recovery either
reopens an authorized Host locator and verifies the same digest or returns
`source_reauthorization_required`; previous chat context is never recovery
evidence.

## Semantic acceptance

`JUDGMENT_ACCEPTED` derives from:

- a bounded purpose and at least one complete, traceable unit;
- applicable grounding and honest authority evidence;
- resolution or bounded disposition of open questions, conflicts, source
  safety, and import mappings;
- semantic tests covering use, boundary or exit, and over-application
  prevention;
- current acceptance by an actor allowed for the authority mode;
- no open blocking repair.

Coverage is structure- and risk-driven. All high-risk or unique judgments,
global critical boundaries, and declared conflict, priority, exception, or
authority-precedence structures must be covered. Homogeneous low-risk units
may use a pre-frozen representative sample with a digest-bound coverage map
and rationale. Missing a high-risk or unique unit fails closed. The Engine does
not require a separate applicable and counterexample execution for every
low-risk unit.

Source sensitivity and application risk are independent. Material sensitivity
controls processing, disclosure review, isolation, and logs. Application risk
comes from an explicit, digest-bound use/risk profile and rationale. A private
writing style can be low-risk; a public medical, financial, or external-action
use can be high-risk.

## Managed candidate and application verification

Compilation is allowed only after Judgment Acceptance and produces a managed
private test candidate. Runtime output contains only public-format technical
authoring provenance, never private authority mode, workflow mode,
participation, represented subject, interview answer, or confirmation receipt.
Candidate compilation does not assert publication or `ready_for_release`.

The build receipt establishes `FORMAT_VALID` for the exact candidate bytes:
container/schema/profile/integrity, encryption structure when applicable,
Runtime compatibility, identity/digests, and load planning. An encrypted
container can be format-valid even when the current caller lacks
authorization. Actual authorized load, projection, Runtime Capsule, exact-byte
round trip, and task use belong to `APPLICATION_VERIFIED`.

New plans use `application-adoption-fidelity`. Each task declares
`with-only` or `paired-diagnostic` execution:

- `with-only` requires the exact-asset Consumer lane and records causal
  difference as not evaluated;
- `paired-diagnostic` adds an isolated baseline lane for a pre-frozen
  capability or diagnostic question.

Equal correct outputs do not fail an asset and do not prove causal influence.
Per-asset acceptance depends on exact Runtime delivery plus applicable,
independently evaluated direction, scope, boundary, exit, permission,
over-application, and declared relation fidelity. Safety and permissions use
Host-observed capabilities in addition to Consumer output.

At least one pre-frozen core or highest-risk boundary scenario has repeated
and, where declared, perturbed runs sufficient for the plan's stability claim.
The plan need not repeat every task, but a single-run-only plan cannot claim
stable use or Creation Complete. Receipts bind every actual Consumer output
and per-task evaluation for each repetition; stability is mechanically
recomputed and never accepted from a caller-supplied boolean or arbitrary
digests.

The official Host owns fresh Consumer/evaluator isolation and cryptographic
plumbing. A signature proves key possession, not process isolation, human
identity, or organizational authority. The ordinary user does not prepare
role keys, signatures, plans, or receipts. A Host that cannot provide the
required independent execution must report an integration blocker.

`APPLICATION_VERIFIED` and `Creation Complete` require one semantic digest,
one build receipt, and the same exact managed asset bytes. Semantic revision,
candidate replacement, stale receipt, missing repetition, altered output, or
failed applicable dimension invalidates the gate.

## Final delivery

Final delivery is a separate, atomic operation after all three gates. It copies
the already verified managed bytes without recompiling and verifies:

```text
managed candidate digest
== application receipt asset digest
== Creation Complete asset digest
== delivered file digest
```

An output inside the private workspace, a path alias or symlink into it, stale
evidence, changed candidate, or incomplete gate fails before any target write.
Protected ciphertext does not require a redundant password merely to copy
unchanged authorized bytes.

Runtime `access: public` means that possession of the file is sufficient to
load it. It does not publish the asset to the Internet. Distribution,
publication, license, deprecation, revocation, and marketplace management are
separate caller responsibilities and do not occur implicitly during local
Creation.

## Local lifecycle

The current lifecycle is create, resume, revise or correct, invalidate stale
confirmations/tests, retest, finalize, and recover the last valid local state.
Stopping retains the private workspace. The current command surface does not
provide general workspace abandon/delete; application-attempt abandonment is a
narrow receipt for one interrupted Consumer attempt. Existing lineage and
revision are preserved when the implemented revision path imports a prior
project or asset. Forking, publication, deprecation, revocation, and
marketplace distribution are reported only when their separate implementations
have been verified; they do not block a bounded local first-creation candidate.
