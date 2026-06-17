# KDNA Studio Core

**KDNA Studio Core is the judgment asset refinery.** It turns scattered notes, documents, works, and feedback into loadable .kdna judgment assets — not by compressing content, but by distilling the stable judgment patterns embedded within it.

AI may propose judgment candidates from content analysis. Humans must confirm judgment. Only human-locked judgment can compile into KDNA.

Open-source Studio-compatible authoring kernel for creating trusted `.kdna` assets — JS/npm package. Supports two authoring paths: interview-first (expert self-expression) and distillation-first (pattern extraction from existing content). Both end with Human Judgment Lock.

**KDNA Studio Core is the JS authoring kernel.** It is not a UI tool and not a CLI package. It is a pure-logic engine for creating KDNA judgment cards, Human Locks, compiler output, and authoring provenance from JavaScript applications and Studio-compatible tools.

A `.kdna` asset is not created by writing JSON files. It is compiled by a
Studio-compatible authoring pipeline that performs human confirmation,
validation, canonicalization, identity generation, digest computation, signing,
optional encryption, and provenance recording.

**Hard boundary:** Optional encryption, when supported, MUST be represented as
protected entries inside the `.kdna` container (RFC-0008). App-private encrypted
envelopes or transfer wrappers that cannot be opened by KDNA Core are NOT
conforming KDNA runtime assets.

| Library | Language | Role |
|---------|----------|------|
| `@aikdna/kdna-cli` | JS/npm | **Operate** KDNA — install, verify, load, compare, publish |
| **`@aikdna/kdna-studio-core`** | JS/npm | **Authoring kernel** — project model, cards, Human Lock, compiler, provenance |
| `@aikdna/kdna-studio-cli` | JS/npm | **Create via CLI** — `kdna-studio` create, compile, export |
| `@aikdna/kdna-core` | JS/npm | **Use** KDNA — load, validate, format |

## What it does

- **Project Model** — `studio.project.json` with full metadata, provenance tracking
- **Evidence Room** — import raw material (text, markdown, interviews, cases)
- **Distillation Target** — declare domain category, owner scope, granularity, task scope, include/exclude areas, and load condition before extraction
- **Evidence Relevance** — classify source material as relevant, weakly relevant, out-of-scope, or split-domain before distillation
- **Scope Gate** — mark candidates with `scope_fit`, relevance score, and suggested split domain before they can become cards
- **Judgment Cards** — 8 card types: axiom, ontology, stance, framework, misunderstanding, self_check, banned_term, terminology
- **Human Lock** — AI proposes, human confirms. Only locked cards compile.
- **Authoring Provenance** — every compiled manifest records Studio-compatible
  compiler metadata, project digest, Human Lock count, and confirmation status.
- **Asset Build Reports** — every compile emits build, provenance, Human Lock,
  quality gate, eval, and receipt artifacts for audit.
- **Feynman Restatement** — verify understanding, not just agreement
- **Quality Gates** — readiness check: draft → structurally_ready → judgment_ready → publish_ready
- **Compiler** — locked cards → `KDNA_Core.json` + `KDNA_Patterns.json`
- **Test Lab** — A/B comparison (No KDNA vs Best Prompt vs KDNA)
- **Provenance** — content fingerprinting, build tracking, audit trail

## What it is not

- Not a UI framework
- Not the official KDNA Studio App
- Not a one-click AI generator
- Not a prompt engineering tool

## Authoring Flow

```
Evidence Room → Judgment Cards → Human Lock → Quality Gate → Compile → Validate → Export
```

For distillation-first authoring, the flow starts with an explicit target:

```
Declare Domain + Scope → Import Evidence → Classify Relevance → Distill Candidates
  → Scope Gate → Human Review → Promote to Cards → Human Lock → Compile → Export
```

A single `.kdna` asset should stay scoped to one domain and loading condition. If a task needs several judgment domains, create multiple domain assets and compose them through a KDNA Cluster rather than making one broad file.

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
kdna-studio export my_domain --out dist/my_domain.kdna --sign
kdna verify dist/my_domain.kdna --judgment
kdna publish dist/my_domain.kdna
```

## Quick Start

```js
const {
  project: projectApi,
  cards: cardApi,
  distillation
} = require('@aikdna/kdna-studio-core');

// 1. Create a project
const project = projectApi.createProject('writing_judgment', 'domain', {
  author: { name: 'Writing Expert', id: 'writer_001' }
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

// 3. Human Lock
const locked = cardApi.lockCard(card, {
  by: 'writer_001',
  statement: 'This represents my professional writing judgment.',
  checked: { applies_when: true, does_not_apply_when: true, failure_risk: true }
});

// 4. Check readiness
const gate = projectApi.checkHumanLockGate(project);
if (!gate.blocked) {
  // 5. Export
  const json = projectApi.exportProject(project);
  console.log('Ready to publish');
}
```

## Card Types (v1.0)

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
- Only `locked`/`tested`/`published` cards can be compiled
- Cards must have Human Lock (`human_lock.by` + `human_lock.statement`) before locking
- Human Lock must confirm `applies_when`, `does_not_apply_when`, `failure_risk` were reviewed

## Human Lock

AI can propose. Human must confirm. Only locked judgment can compile.

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

KDNA Studio Core is open source. Official KDNA Studio App, hosted collaboration, managed registry, quality review workflows, and enterprise private registry may be commercial services.

## Related

- [KDNA Core](https://github.com/aikdna/kdna) — Official format
- [kdna-cli](https://github.com/aikdna/kdna-cli) — CLI tools
- [kdna-core-swift](https://github.com/aikdna/kdna-core-swift) — Swift runtime for macOS/iOS
- [aikdna.com](https://aikdna.com) — Website
