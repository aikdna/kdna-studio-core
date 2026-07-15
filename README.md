# KDNA Studio Core

**KDNA Studio Core is the JS authoring kernel for `.kdna` files.** It turns scattered notes, documents, works, and feedback into loadable judgment assets by distilling stable judgment patterns into a declared domain and loading scope.

Open-source Studio-compatible authoring kernel for creating reviewable `.kdna` assets — JS/npm package. Supports two authoring paths: interview-first (direct expression) and distillation-first (pattern extraction from existing content). Both end with the current canonical KDNA runtime export.

**KDNA Studio Core is the JS authoring kernel.** It is not a UI tool and not a CLI package. It is a pure-logic engine for creating KDNA judgment cards, optional provenance records, compiler output, and runtime `.kdna` exports from JavaScript applications and Studio-compatible tools.

Studio-compatible tooling uses a project workspace for authoring, review, and
audit, then exports the canonical KDNA runtime container. The public
asset is the packaged `.kdna` file; project JSON is an authoring/editing view,
not the default distribution form.

Studio Core distinguishes authoring compile output from runtime distribution
output. Authoring compile output may include source entries such as
`KDNA_Core.json` and `KDNA_Patterns.json` for audit and review. Runtime export
must produce the canonical KDNA distribution shape:

```text
mimetype
kdna.json
payload.kdnab
checksums.json
```

Runtime export must validate with `@aikdna/kdna-core` and must plan through the
LoadPlan contract in `aikdna/kdna`. Studio products must not create app-private
`.kdna` shapes that KDNA Core or CLI cannot inspect, validate, or plan-load.

Current exports keep responsibility names separate from compatibility
coordinates: the container uses `format_version: 0.1.0`, the payload declares
`profile: kdna.payload.judgment` with `profile_version: 0.1.0`, checksums use
`digest_profile: kdna.digest-basis.runtime-entry-set` with
`digest_profile_version: 0.1.0`, and Runtime loading yields a
`kdna.runtime-capsule` contract at `0.1.0`.

| Library | Language | Role |
|---------|----------|------|
| `@aikdna/kdna-cli` | JS/npm | **Operate** KDNA — inspect, validate, plan-load, pack/unpack, load |
| **`@aikdna/kdna-studio-core`** | JS/npm | **Authoring kernel** — project model, cards, review/provenance, compiler, runtime export |
| `@aikdna/kdna-studio-cli` | JS/npm | **Create via CLI** — `kdna-studio` create, review, export |
| `@aikdna/kdna-core` | JS/npm | **Use** KDNA — load, validate, format |

## What it does

- **Project Model** — `studio.project.json` with full metadata, provenance tracking
- **Evidence Room** — import raw material (text, markdown, interviews, cases)
- **Distillation Target** — declare domain category, owner scope, granularity, task scope, include/exclude areas, and load condition before extraction
- **Evidence Relevance** — classify source material as relevant, weakly relevant, out-of-scope, or split-domain before distillation
- **Scope Gate** — mark candidates with `scope_fit`, relevance score, and suggested split domain before they can become cards
- **Judgment Cards** — 8 card types: axiom, ontology, stance, framework, misunderstanding, self_check, banned_term, terminology
- **Review and provenance** — AI may propose candidates; projects can record review and release evidence when needed.
- **Authoring Provenance** — every compiled manifest records Studio-compatible
  compiler metadata, project digest, review counts, and confirmation status.
- **Asset Build Reports** — every compile emits build, provenance, review,
  readiness, evaluation, and receipt artifacts for audit.
- **Feynman Restatement** — verify understanding, not just agreement
- **Readiness Gates** — readiness check: draft → structurally_ready → judgment_ready → publish_ready
- **Compiler** — complete, non-deprecated cards → authoring compile output; optional Human Lock provenance is preserved
- **Runtime Export** — compiled judgment → canonical `mimetype` +
  `kdna.json` + `payload.kdnab` + `checksums.json`
- **Declared Judgment Core** — optional `judgment_core` fields
  (`highest_question`, `worldview`, ordered `value_order`, and bounded
  `judgment_role`) are preserved verbatim from project source through compile
  and runtime payload. They are scoped judgment data, not facts or policy.
- **Test Lab** — A/B comparison (No KDNA vs Best Prompt vs KDNA)
- **Provenance** — content fingerprinting, build tracking, audit trail

## What it is not

- Not a UI framework
- Not the official KDNA Studio App
- Not a one-click AI generator
- Not a prompt engineering tool

## Authoring Flow

```
Evidence Room → Judgment Cards → Review/Provenance → Quality Gate → Compile → Validate → Export
```

For distillation-first authoring, the flow starts with an explicit target:

```
Declare Domain + Scope → Import Evidence → Classify Relevance → Distill Candidates
  → Scope Gate → Review → Promote to Cards → Provenance → Compile → Export
```

A single `.kdna` asset should stay scoped to one domain and loading condition.
If a task needs several judgment domains, create multiple domain assets and
compose them through an explicit consumption policy rather than making one
broad file. Route cards and consumer indexes are separate, disabled-by-default
sidecars; they do not belong in the runtime asset export.

## Install

```bash
npm install @aikdna/kdna-studio-core
```

## Studio CLI

The command-line authoring entry is a separate package:

```bash
npm install -g @aikdna/kdna-studio-cli
kdna-studio create my_domain --name @yourscope/my_domain
kdna-studio import my_domain ./notes.md
kdna-studio target declare my_domain \
  --category expression_writing \
  --scope personal \
  --granularity core_principles \
  --task "longform article review" \
  --include "argument structure,tone,revision" \
  --exclude "life habits,food preference"
kdna-studio source classify my_domain
kdna-studio distill my_domain --candidates candidates.json
kdna-studio candidate accept my_domain <candidate-id>
kdna-studio candidate promote my_domain
kdna-studio card add my_domain axiom \
  --field one_sentence="Judgment principle" \
  --field full_statement="What the agent should do differently" \
  --field why="What fails without this judgment" \
  --field applies_when='["Relevant task"]' \
  --field does_not_apply_when='["Out of scope"]' \
  --field failure_risk="What could go wrong"
kdna-studio card approve my_domain <card-id> --by expert --statement "I confirm this judgment."
kdna-studio export my_domain --out dist/my_domain.kdna
kdna validate dist/my_domain.kdna
kdna plan-load dist/my_domain.kdna
```

## Quick Start

```js
const {
  project: projectApi,
  cards: cardApi,
  compile,
  exportRuntime,
  distillation
} = require('@aikdna/kdna-studio-core');

// 1. Create a project
const project = projectApi.createProject('writing_judgment', 'domain', {
  author: { name: 'Writing Expert', id: 'writer_001' },
  judgmentCore: {
    highest_question: 'Which in-scope tradeoff should this asset resolve?',
    worldview: ['Observed task facts remain authoritative.'],
    value_order: ['prevent irreversible harm', 'preserve reversibility'],
    judgment_role: {
      acts_as: 'a scoped judgment authority',
      does_not_act_as: ['a fact source', 'a policy engine'],
      responsibility: 'Order qualitative tradeoffs inside the declared scope.'
    }
  }
});

// Optional: declare a distillation target before extracting from evidence.
const target = distillation.createDistillationTarget({
  domainName: 'writing_judgment',
  domainCategory: 'expression_writing',
  ownerScope: 'personal',
  granularity: 'core_principles',
  taskScope: 'longform article diagnosis and revision',
  includeAreas: ['argument structure', 'reader framing', 'evidence density'],
  excludeAreas: ['life habits', 'food preference']
});
project.distillation_target = target;

// 2. Create judgment cards
const card = cardApi.createCard('axiom', {
  one_sentence: 'Most writing problems are structural, not language-level.',
  full_statement: 'When reviewing content, diagnose structure before language.',
  why: 'Surface polishing on structurally weak content wastes effort.',
  applies_when: ['User asks to review content'],
  does_not_apply_when: ['User explicitly asks for grammar check only'],
  failure_risk: 'May over-diagnose structural problems in content that only needs polish.'
});
project.cards.push(card);

// 3. Optional review provenance for this Studio project
const locked = cardApi.lockCard(card, {
  by: 'writer_001',
  statement: 'This represents my professional writing judgment.',
  checked: { applies_when: true, does_not_apply_when: true, failure_risk: true }
});

// 4. Check readiness
const gate = projectApi.checkHumanLockGate(project); // optional review report

// 5. Compile and runtime-export. Human Lock does not grant creation permission.
const compiled = compile.compileDomain(project, { strictAuthority: false });
const runtimeAsset = exportRuntime.exportRuntimeAsset(project, { compiled });
console.log(Object.keys(runtimeAsset.files), gate.lockedJudgmentCards);
```

## Runtime Export Contract

`compile.compileDomain(project)` is an authoring compile step. It returns source
and evidence artifacts for review, audit, and reports. It is not itself the
runtime distribution contract.

Use `exportRuntime.exportRuntimeAsset(project)` to produce a canonical KDNA
runtime source directory payload:

```js
const { exportRuntime } = require('@aikdna/kdna-studio-core');

const runtimeAsset = exportRuntime.exportRuntimeAsset(project);
// runtimeAsset.files contains only:
// - mimetype
// - kdna.json
// - payload.kdnab
// - checksums.json
```

The exported files are tested against `@aikdna/kdna-core.validate`. In the OPEN
workspace they are also tested against the current `aikdna/kdna` LoadPlan
implementation when available.

Runtime `creator` metadata is optional provenance. Studio Core preserves a
declared creator name and ID, but omits the entire `creator` record when no
non-empty creator name is available. It never invents an `Unknown` identity.
The Studio project's editable `author` object remains independent of this
runtime validity rule.

Access values are canonicalized for runtime export:

| Studio / legacy value | Runtime value |
|---|---|
| `open` | `public` |
| `protected` | `licensed` |
| `runtime` | `remote` |

Top-level source JSON entries such as `KDNA_Core.json`, `KDNA_Patterns.json`,
and `KDNA_CARD.json` must not be present in runtime export output.

## Card Types (current)

| Type | Compiles to | Description |
|------|------------|-------------|
| `axiom` | KDNA_Core.json | Core judgment principle |
| `ontology` | KDNA_Core.json | Concept boundaries |
| `framework` | KDNA_Core.json | Structured diagnostic approach |
| `stance` | KDNA_Core.json | Domain position/perspective |
| `misunderstanding` | KDNA_Patterns.json | Common wrong interpretation |
| `self_check` | KDNA_Patterns.json | Yes/no verification question |
| `banned_term` | KDNA_Patterns.json | Terms to avoid and replacements |
| `terminology` | KDNA_Patterns.json | Standard term definitions |

## Card State Machine

```
draft → revised → locked → tested → published → deprecated
```

Rules:
- `locked`/`tested`/`published` are Studio project review states, not KDNA Core format-validity states.
- Studio release exports use reviewed cards as release evidence.
- A validated `.kdna` file can still be structurally valid without Human Lock; trust, authorship, signatures, and release evidence are separate layers.

## Human Lock

Human Lock is optional provenance metadata. It records that a human reviewed
specific judgment fields in a Studio project. It is useful for public,
enterprise, or high-risk assets, but it is not a KDNA format-validity
requirement and does not certify content quality.

```js
lockCard(card, {
  by: 'expert_id',
  statement: 'I confirm this reflects my domain judgment.',
  checked: {
    applies_when: true,
    does_not_apply_when: true,
    failure_risk: true
  }
});
```

## License

Apache-2.0 — see [LICENSE](LICENSE).

KDNA Studio Core is open source. Official KDNA Studio App, hosted collaboration, managed review workflows, and enterprise private distribution may be commercial services.

## Related

- [KDNA Core](https://github.com/aikdna/kdna) — Official format
- [kdna-cli](https://github.com/aikdna/kdna-cli) — CLI tools
- [kdna-core-swift](https://github.com/aikdna/kdna-core-swift) — Swift runtime for macOS/iOS
- [aikdna.com](https://aikdna.com) — Website
