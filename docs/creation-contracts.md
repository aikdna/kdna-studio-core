# Creation Engine contracts

Status: unreleased dirty-source candidate; not a published or stable API

The Creation Engine is the UI-independent source candidate in
`@aikdna/kdna-studio-core`. It lets a terminal Agent guide a user from an
explicit purpose and source set to a judgment-accepted Studio project without
requiring the Studio App or hand-editing a Studio schema.

Official completion has three independent private gates:

- `JUDGMENT_ACCEPTED`: Studio Core determines whether creation intent,
  judgment semantics, source grounding, confirmations, boundaries, repairs,
  and semantic tests are sufficient.
- `FORMAT_VALID`: the exact final `.kdna` bytes have a current build receipt
  whose Core validate, inspect, plan, load, re-import, and round-trip checks all
  passed.
- `APPLICATION_VERIFIED`: Studio Core observed the exact final asset load,
  a key-bound Consumer recorded another exact-byte load and executed a
  pre-frozen task set in with-KDNA and without-KDNA lanes, and a separately
  keyed evaluator's signed adoption-fidelity facts meet the frozen
  safety, scope, direction, boundary, exception, priority, authority,
  exit, over-application, and stability thresholds. It does not require
  the with-KDNA lane to score higher than the baseline.

`CREATION_COMPLETE` is derived only when all three bind the same semantic
revision/digest and exact asset digest. A successful gate does not claim
factual truth, real-world identity, representativeness, or permission beyond
the declared mode and evidence.

## Public API

```js
const { creationEngine } = require('@aikdna/kdna-studio-core');
```

The public operations are:

```text
createWorkspace(projectPath = null, options = {}) -> workspace
loadWorkspace(pathOrWorkspaceJson) -> workspace
saveWorkspace(path, workspace) -> workspace
setPurpose(workspace, purpose) -> workspace
updateExportPlan(workspace, { version?, access? }) -> workspace
ingestMaterial(workspace, material) -> workspace
reviewMaterial(workspace, materialId, review) -> workspace
addCandidate(workspace, candidate) -> workspace
recordInterviewAnswer(workspace, answer) -> workspace
promoteCandidate(workspace, candidateId, changes = {}) -> workspace
analyzeRelations(workspace, analysis = {}) -> workspace
recordConfirmation(workspace, confirmation) -> workspace
addSemanticTest(workspace, testCase) -> workspace
freezeSemanticTestPlan(workspace, testPlan) -> workspace
recordSemanticTestResult(workspace, testId, result) -> workspace
freezeApplicationTestPlan(workspace, plan) -> workspace
issueApplicationAttempt(workspace, attempt, { asset_bytes, password? }) -> workspace
recordApplicationAssetObservation(workspace, observation, { asset_bytes, password? }) -> workspace
applicationAttemptAbandonmentSigningPayload(workspace, abandonment) -> Buffer
abandonApplicationAttempt(workspace, abandonment) -> workspace
recordApplicationReceipt(workspace, receipt) -> workspace
applicationKeyRegistrySigningPayload(workspace, plan) -> Buffer
applicationPlanSigningPayload(workspace, plan) -> Buffer
applicationConsumerSigningPayload(receipt) -> Buffer
applicationEvaluatorSigningPayload(receipt) -> Buffer
buildRepairPlan(workspace, diagnostics = {}) -> workspace
applyRepair(workspace, repairId, repair) -> workspace
assessReadiness(workspace) -> readiness
compileProject(workspace) -> { project, readiness }
recordBuildReceipt(workspace, receipt, { asset_bytes, password? }) -> workspace
nextAction(workspace) -> action
canonicalOperationRequestDigest(envelope) -> digest
operationCoordinate(workspace) -> coordinate
resolveOperation(workspace, request) -> receipt | null
completeOperation(workspace, request) -> workspace
prepareExportOperation(workspace, request) -> workspace
verifyExportOperation(workspace, request) -> workspace
completeExportOperation(workspace, request) -> workspace
```

Mutation operations are immutable: they return a new workspace and do not
modify the input object. Canonical semantic changes increment
`state.semantic_revision` and recompute `state.semantic_digest`. Nonsemantic
events are still recorded in `history` but keep the same semantic revision.
Any semantic change invalidates confirmation receipts, semantic test results,
test-report acceptance, application plans, and application receipts bound to
an older revision/digest. A same-semantic re-export with different exact asset
bytes supersedes the prior application receipt.

Test-report acceptance has an independent canonical digest over case identity,
kind, input, expected output, predeclared creator label, observed creator
label, unit and boundary references, held-out/source references, result status,
evaluator, and evaluation notes. The acceptance
object itself and timestamps are excluded. Adding or re-evaluating a case does
not pretend to change judgment semantics, but it invalidates any acceptance
bound to the previous test-report digest and requires explicit re-acceptance.
The workspace Schema and loader also enforce the exact state/result pair:
`pending/null`, `passed/pass`, `failed/fail`, or
`inconclusive/inconclusive`, with matching evaluation metadata. Re-digesting a
corrupted `passed/fail` case cannot make it Creation Accepted.

When a case declares `expected_creator_label`, it must be `符合` or
`超出范围`. Every current creator-labeled definition must be frozen in a
digest-bound `SemanticTestPlan` by its actor before any result is recorded.
Adding a definition invalidates the plan. Evaluation then persists
`observed_creator_label` as exactly `符合`, `不符合`, or `超出范围`; Core
derives `pass` only when the observed label is not `不符合` and exactly equals
the frozen expectation. A caller cannot submit a contradictory result or hide
the observed label. The optional reason remains evaluation notes.

The label classifies the requested case relative to the represented judgment;
it is not a quality rating of the prose in `expected`. `符合` means the request
is in scope and the observed behavior faithfully applies the judgment.
`不符合` means the observed behavior contradicts it. `超出范围` means the
request itself crosses a declared scope, source-authority, or safety boundary,
even when the faithful expected behavior is to refuse, abstain, or redirect.
This distinction prevents a correct refusal from silently relabeling an
out-of-scope request as in-scope.

`comparison` is the first-class with-vs-without-KDNA construct. It requires one
or more `unit_ids`; the case input describes the identical task used in both
lanes, and `expected` declares the judgment difference expected only when KDNA
is loaded. A caller-provided semantic `pass` never satisfies application
verification. Every current declared comparison must be covered by a
pre-frozen application task and actual signed dual-lane execution before
completion.

If an isolated Consumer runner terminates after its exact-asset observation
but before a signed application receipt exists, the frozen coordinator may
sign one private abandonment receipt. It binds the current plan, semantic,
build and asset coordinates; the exact one-use attempt and challenge; the
Consumer observation when present; a stable reason code, concise reason, and
runner-failure evidence digest; and a canonical UTC `abandoned_at`. When an
observation exists, its Consumer run and runner digests are repeated in the
signed receipt. Studio Core accepts the signed time only within five minutes
of receipt intake and only when it is not earlier than the attempt or
observation, then persists that exact value. It atomically marks the open
attempt and observation `abandoned`, preserves both plus the receipt as
history, and allows a new one-use attempt without changing judgment semantics
or rebuilding the asset. Unknown, stale, consumed, superseded, mismatched,
replayed, unsigned, or non-coordinator requests fail closed. The coordinator
signature proves only that the frozen key signed those facts and that claimed
time; it is not an external time authority, real-world identity, or
process-independence evidence.

## Creation modes

`workflow_mode` is a separate private axis: `collaborative` or `autonomous`.
It describes who drives the workflow, not who owns or is represented by the
judgment. The five source/claim modes below remain authoritative in both
workflows. Autonomous work over another subject's material cannot use
`agent-authored`; it normally uses `interpretive` unless stronger confirmation
evidence is genuinely available. `workflow_mode` never enters Runtime.

| Mode | Permitted claim | Required authority evidence |
|---|---|---|
| `agent-authored` | The declared Agent created the judgment system | The creating Agent or a non-Agent may accept the semantic test report |
| `human-assisted` | A human participated in extraction or editing | A digest-bound participation receipt; no representation claim |
| `human-confirmed` | The named human confirmed this semantic revision | A representation receipt from that human plus a non-Agent held-out evaluation |
| `organization-confirmed` | An authorized confirmer confirmed this revision for the named organization | An authority-bearing representation receipt plus a non-Agent held-out evaluation |
| `interpretive` | The asset interprets named material without representing its subject | Named source material and source-grounded judgments. A distinct represented Agent may accept its own synthetic interpretation without creating human evidence. |

Creation confirmation receipts remain private Creation evidence in every
mode. They constrain Creation Accepted but never compile into Runtime creator
identity or legacy Human Lock provenance. Human participation is not human
confirmation, and a declared representation receipt is not authenticated
real-world identity evidence. Only a creating Agent may be projected as
optional technical creator provenance; a declared human or organization
`created_by` identity is omitted from Runtime output.

The Engine binds the exact declared actor, subject, authority text, semantic
revision, and digest. It does not authenticate a real-world person or an
organizational delegation. A terminal Host that presents a representational
claim must establish that identity or authority in its own authenticated
session and retain the external evidence. Synthetic fixtures never supply
that real-world assurance. A signature proves a signing act over bytes and
does not replace this confirmation boundary.

Interpretive and representational modes require every promoted judgment to
bind at least one in-scope, non-expired source for the represented subject. A
representational source must additionally
declare that it belongs to the subject, represents the subject's current
judgment, is current, and has `current-highest` or `supporting` authority.
Wrong-subject, unknown, historical, negative, rejected, out-of-scope and
expired declarations do not satisfy source grounding. Pure Agent inference
cannot make those modes Creation Accepted.

## First-class objects

The workspace schema defines eight semantic objects:

- `PurposeBrief` declares objective, scope, explicit non-goals, loading
  condition, represented
  subject, highest question, worldview, ordered values, judgment role, and
  global boundaries.
- `SourceRecord` stores a content digest, declared source creation/update time
  and time basis, plus interpretation metadata, never the ingested source body.
  A later private source review may change only subject binding, ownership,
  representativeness, authority, currentness, constraints, scope, split
  suggestion, or expiry. Every effective review requires a typed reviewer and
  reason and appends a before/after digest receipt. Source identity, bytes,
  title, kind, time, trust scan, and sensitivity remain immutable.
- `JudgmentCandidate` is a complete proposed judgment before promotion. Its
  private `contrary_evidence` list records the attempted disconfirmation or
  conflicting observation shown during review; it does not become a Runtime
  field. Its
  promote/reject receipt binds reviewer, reason, before/after digests and
  changed fields so a creator correction remains auditable.
- `JudgmentUnit` is the promoted form compiled to one of the 16 Studio card
  types.
- `JudgmentRelation` explicitly represents support, limit, exception,
  conflict, or priority. `support`, `limit`, and resolved-conflict records stay
  in private creation evidence at this checkpoint. Only explicitly accepted
  `priority` and `exception` relations enter Runtime `core_structure`.
- `ConfirmationReceipt` binds participation or representation to a canonical
  semantic digest.
- `SemanticTestCase` binds an applicable, counterexample, boundary, conflict,
  optional with-KDNA/without-KDNA comparison, or holdout case to a semantic
  digest.
- `RepairItem` makes a failed test, unresolved conflict, or other diagnostic
  actionable and auditable.

Every candidate and unit declares:

```text
statement
rationale
applies_when
does_not_apply_when
misuse_risk
source_refs
contrary_evidence
confidence
confirmation_state
agent_inference
card_type
fields
```

Array position never silently establishes priority. Use an explicit `priority`
relation. Conflicts require an explicit resolution or rejection. Asset split
recommendations remain blocking until accepted and moved out of the workspace,
or explicitly rejected with a reason.

## Recoverable workspace

`saveWorkspace` atomically publishes one directory containing exactly eleven
JSON artifacts:

```text
creation-state.json
purpose-brief.json
materials-index.json
candidate-judgments.json
judgment-model.json
unresolved-questions.json
confirmation-receipts.json
semantic-test-report.json
repair-plan.json
export-plan.json
build-receipt.json
```

Every artifact envelope carries the same workspace identifier, semantic
revision, and semantic digest. Public validation and every object, JSON, or
artifact load enforce the shipped 2020-12 JSON Schema before accepting the
canonical digest. Validation errors include JSON-pointer paths. Loading rejects
missing, schema-invalid, or mixed snapshots. If an interrupted directory
replacement leaves the canonical path absent,
`loadWorkspace` can resume from the newest complete transaction-owned backup
or staging snapshot; it never accepts a partial snapshot.

Saving also uses optimistic concurrency. An idempotent save of the exact
persisted snapshot is allowed, and a new snapshot may extend the exact
persisted history prefix. A stale snapshot, divergent history, or different
`workspace_id` fails with `CREATION_WORKSPACE_CONFLICT` instead of overwriting
another Agent's accepted progress.

`creation-state.json` also carries the private operation ledger. A write
request is identified by a caller-stable `operation_id` and a canonical digest
over the effective JSON/stdin request, material snapshots and bounded I/O
effects. Exact replay returns without changing history or workspace content;
reusing an ID for another payload fails with
`CREATION_OPERATION_CONFLICT`. A completed receipt is replayable only while
its semantic and, for export, private export-plan coordinates are still
current. An old ID cannot replay a stale
answer, review, test, repair, or exported asset after a semantic correction.
For export, the current accepted readiness and build receipt must also bind
the same semantic coordinate, distributed and judgment versions, and exact
asset digest. Operation receipts do not enter the semantic
snapshot, do not advance `semantic_revision`, and never project to a project,
Manifest, Runtime payload or Capsule. The CLI supplies a digest-derived
private ID when a caller omits one; callers that may intentionally repeat an
identical action should always supply their own unique ID.

Export operations use private `prepared → verified → completed` receipts.
`prepared` records a normalized output reference relative to the workspace
parent, deterministic sibling candidate/backup names, and the exact
prior-output digest before any packed bytes are generated. The relative
reference lets a fresh terminal Agent reconstruct the requested target from
the persisted workspace without putting an absolute output path in the
receipt. `verified` binds the exact packed bytes only after
validate/inspect/plan/authorized compact+full load/re-import/semantic
comparison, including an exact comparison between the Runtime Manifest
versions and the compiled export plan. `completed` is recorded only after
those same bytes are installed and a matching build receipt exists. Every
phase is persisted before the next external effect, so a fresh process can
reconcile an interrupted publish without regenerating protected bytes.
Advancing the export plan makes an earlier prepared, verified, or completed
operation inapplicable. Unknown, replaced, symlinked, digest-mismatched, or
stale-plan recovery files fail closed.

A build receipt may also carry a private `development_baseline`. This is a
strict projection of one externally attested development BOM: its semantic and
file digests plus the Core, Studio Core, and Studio CLI commit/tree,
dirty-source, package-input, and candidate-artifact digests. Studio Core
checks the shape, repository ownership, and package/version match against the
actual tool coordinates. The receipt contains no repository path, and this
development evidence never enters the Manifest, Payload, or Runtime Capsule.

Source bodies are treated as untrusted data. Material ingestion stores:

- SHA-256 content digest;
- declared source creation/update times and whether they came from a
  declaration, file metadata, an asset manifest, or remain unknown;
- authority and currentness;
- source-subject and representational declarations;
- scope and split-domain classification;
- sensitivity and external constraints;
- an opaque reference, when supplied;
- prompt-injection detection metadata using stable indicator codes only; regex
  matches and source excerpts are never persisted. The workspace schema is
  closed to that code set, and the detection flag must exactly match whether
  any indicator is present.

Source text is not persisted in the workspace or copied into the compiled
project or Runtime payload. Instruction-like text creates an open
`source_safety` question. Every open unresolved question blocks Creation
Accepted until a caller records an explicit answer.

An in-scope `sensitive` source also blocks a `public` export with
`SENSITIVE_PUBLIC_EXPORT_BLOCKED` until a structured
`public-safe-abstraction` disposition is recorded. `licensed` and `remote`
plans may instead use `non-public-isolation`; the source body remains excluded
in every mode.

## State and next action

The state machine is:

```text
needs_purpose
needs_sources
analyzing_sources
eliciting_judgment
awaiting_confirmation
testing
repairing
ready_to_export
exported
```

`nextAction` returns:

```js
{
  action,
  state,
  reason,
  requires_user,
  unresolved_ids
}
```

It prioritizes missing purpose and source material, candidate review,
low-confidence clarification, explicit conflicts and splits, open safety
questions, mode-specific confirmation, test evaluation, repair, test
acceptance, and export. It pauses for user authority only when the declared
mode requires it. The declared creating Agent may accept its own
`agent-authored` semantic test report. In `interpretive` mode, a represented
Agent distinct from the creating Agent may accept the report for its own
synthetic interpretation. That receipt remains private Creation evidence,
does not make the represented Agent the Runtime author, and cannot create
Human Lock. No Agent may fabricate a human or organization evaluation.

When a source-grounded mode has a purpose but no pre-existing material,
`nextAction` first permits a source interview. After an answer is recorded, it
requires the exact answer to be ingested and classified as an interview
`SourceRecord`; merely storing natural language never bypasses grounding.

## Judgment acceptance and completion

`assessReadiness.compile_ready` is compile readiness. The legacy
`format_ready` field is only an alias for that value and is not
`FORMAT_VALID`. `creation_accepted` is the legacy alias for
`JUDGMENT_ACCEPTED`. Judgment acceptance requires:

1. explicit purpose, scope, loading condition, represented subject where the
   mode requires one, and judgment core;
2. complete, traceable judgments with Agent inference labeled;
3. source grounding for interpretive and representational modes;
4. explicit global boundaries;
   every declared non-goal must exactly match one boundary so it cannot
   disappear during Runtime compilation;
5. resolved open questions, conflicts, and split decisions;
   proposed support, limit, exception, and priority relations also require an
   explicit acceptance or rejection and are never compiled by implication;
6. current mode-specific participation or representation evidence;
7. a passed applicable case and counterexample for every judgment;
8. a passed test for every global boundary;
9. a non-Agent held-out real-task test for representational modes;
10. every declared current semantic test has a passed result (failed, pending,
    and inconclusive cases cannot be accepted away);
11. current semantic-test acceptance by an allowed actor;
12. no open blocking repair.

The returned `completion_gates` separately reports `format_valid`,
`judgment_accepted`, `application_verified`, and `creation_complete`.
Only after `FORMAT_VALID`, application plans freeze the exact build-receipt
and asset digests, fresh-hidden input digests, free-response mode, a
high/critical risk sample, all declared verification dimensions, at least
three noncritical direction/stability seeds in one repeat/perturbation group,
and non-weakenable zero-tolerance safety and fidelity thresholds. Fresh-hidden
tasks cannot reference development semantic-test identifiers. A four-role
Ed25519 registry freezes
distinct Creation, coordinator, Consumer, and evaluator public keys. The
Creation and coordinator keys both sign that registry, and the coordinator
also signs the full immutable task/oracle/threshold plan. On every load, Core
reconstructs those payloads and verifies their digests and signatures.

New plans must use the private `adoption-fidelity` contract and the
`fresh-hidden-holdout` evidence set. Core derives whether the Consumer followed
the KDNA's direction and scope, honored boundary/exception/priority and
authority precedence, avoided safety, permission, external-action and
over-application violations, exited correctly, and remained at least 90%
stable across the frozen noncritical direction seeds. Every failure count has
a maximum of zero. The without-KDNA lane is retained as a signed diagnostic
contrast; neither its score nor a with-KDNA improvement is an acceptance
threshold. Callers cannot submit derived metrics or result status.

Persisted whole-set and `selective-noninferiority` score plans remain
schema-compatible solely for historical audit. They cannot be newly frozen,
cannot satisfy the current completion gate, and are never reinterpreted as
adoption-fidelity evidence.

After `FORMAT_VALID`, the coordinator issues a one-use challenge only after
Core loads the exact final `.kdna` bytes. The Consumer must then record a
separate one-use observation after Core loads the same exact bytes again.
Consumer signatures cover the plan, attempt/challenge, semantic/judgment/
build/asset coordinates, exact-byte observation, Consumer run/runner digests,
and both lane outputs. Evaluator signatures cover those execution bytes,
separate evaluator run/runner digests, and every direction, scope, boundary,
exception, priority, authority-precedence, safety, permission, external-action,
exit, over-application, and stability fact. Core derives the gate
status and rejects caller-supplied status fields. A semantic change invalidates
the plan and all later evidence; replacing the build receipt or exact asset
bytes invalidates the bound plan and supersedes later application evidence.

These signatures prove only that the corresponding private keys signed those
facts. They are not real-world identity authentication and do not by
themselves prove organizational or process independence. The ordered Engine
state proves only that the public keys and plan were frozen before application
results. Initial key enrollment is trust-on-first-use, not external identity
proof. A benchmark or Host must separately prove the Creation process could
not read the Consumer or evaluator private keys, those private keys were
different and isolated, and the claimed Consumer/evaluator processes actually
had the asserted separation. Private keys and secrets never enter the
workspace or receipt.

`compileProject` fails closed unless `creation_accepted` is true. It maps
`JudgmentUnit` objects to the existing 16 Studio card types and preserves the
declared judgment core, accepted Runtime `priority`/`exception` relations in
`source_core_structure` using public `from` / `to` / `via` objects, source
mode, semantic acceptance evidence, release pair, lineage, and
private compile-time `distillation_target.load_condition`. Creation Engine
cards are locked for compilation, but only a current representation receipt
can create Human Lock provenance.

Core local `compact` projection preserves those relation objects and exposes
only their public endpoints and `via` value to Agent consumers. Relation IDs,
rationales, review reasons, resolutions, and other private authoring evidence
remain in the Creation workspace. The Creation Engine does not add `support`,
`limit`, resolved-conflict or other private evidence relations to Runtime.

The declared loading condition remains distinct from
`judgment_core.highest_question`. It stays in private Creation/compile
evidence and does not add `payload.core.load_condition` to the public Runtime
contract. Runtime consumers continue to receive the already-declared
`payload.core.highest_question` and axiom applicability fields.

## Export receipt and version rules

External tooling performs Runtime export, then passes the exact final byte
snapshot back to Studio Core. Studio Core independently repeats:

```text
validate
inspect
plan_load
load_compact
load_full
reimport
semantic_round_trip
```

`recordBuildReceipt` requires the exact final `.kdna` bytes, bounded tool
coordinates, the asset digest, semantic digest, `version`, and
`judgment_version`. Core recomputes the byte digest, validates, inspects,
plans, loads both profiles, reads back the Runtime payload, and compares that
payload with the current Creation workspace. Caller-provided result fields are
diagnostic input only and never decide `FORMAT_VALID`; the persisted seven
results are regenerated by Core. Missing bytes, invalid bytes, a different
valid asset, a plaintext shadow, digest substitution, and stale receipt replay
all fail closed. A password, when needed, is transient verification input and
is never persisted in the receipt.

A source-checkout Studio Core coordinate binds its loaded source, Creation
schema, package metadata, and lockfile. The WP0 development BOM separately
binds the complete dirty-source snapshot and reproducible candidate tarball;
the receipt coordinate alone is not a release BOM.

- A semantic change after a verified build increments both `version` and
  `judgment_version` once.
- A metadata-only distributed rebuild changes `version` and preserves
  `judgment_version`.
- A receipt must bind the current semantic digest and current release pair.
- Build receipts reject secret-, password-, plaintext-, raw-content-, and
  private-source-shaped fields.

The Creation Engine does not publish, sign, or grant permission by itself.
Publication remains a separate caller-controlled operation.

## Minimal flow

```js
const { creationEngine } = require('@aikdna/kdna-studio-core');

let workspace = creationEngine.createWorkspace(null, {
  mode: 'agent-authored',
  createdBy: { type: 'agent', id: 'terminal-agent' }
});

workspace = creationEngine.setPurpose(workspace, {
  objective: 'Choose reversible incident actions before speculative repair.',
  scope: 'service incident triage',
  loading_condition: 'Load while choosing the next incident action.',
  highest_question: 'Which action preserves safety and diagnostic evidence?',
  worldview: ['Observed system state remains authoritative.'],
  value_order: ['prevent irreversible harm', 'preserve evidence'],
  judgment_role: { acts_as: 'a scoped incident-triage judgment authority' },
  global_boundaries: ['Never reveal credentials or private source content.']
});

workspace = creationEngine.addCandidate(workspace, {
  statement: 'Prefer reversible containment while root cause is uncertain.',
  rationale: 'It preserves evidence and rollback options.',
  applies_when: ['Root cause is uncertain.'],
  does_not_apply_when: ['Immediate safety intervention is required.'],
  misuse_risk: 'May delay urgent intervention.',
  contrary_evidence: [
    'Immediate safety intervention may require an irreversible action.'
  ],
  confidence: { status: 'high', score: 0.9 },
  agent_inference: true,
  card_type: 'axiom',
  fields: {}
});

const action = creationEngine.nextAction(workspace);
```

The executable repository fixtures under `fixtures/creation-engine` include a
minimal Agent input, a complete human-confirmed input, the five-mode matrix,
mixed public/private/hostile materials, and all 16 card types.
