# PR-3 Acceptance Note — kdna-studio-core SAG / TC Compile Gates

**RFC-0013 phase:** PR-3 (Studio gates)
**Status:** All acceptance criteria met
**Re-run:**
- `cd aikdna/kdna-studio-core && node --test tests/compile-gates.test.js` (PR-3 unit tests, 13/13 pass)
- `cd aikdna/kdna-studio-core && node --test tests/*.test.js` (full suite; see "Pre-existing failures" note below)

## Scope

PR-3 implements **RFC-0013 §9 acceptance criterion #3** by adding two
compile-time gates to `kdna-studio-core`'s `compileDomain`:

1. **Source Authority Graph (SAG) gate** — enforces RFC-0013 §3.1 invariants
   (precedence_order integrity, authority/status consistency, current_highest
   presence, lower-authority override detection).
2. **Truth Charter (TC) gate** — enforces RFC-0013 §3.2 invariants
   (tc_status, locked fields, renamed_terms soft check against
   KDNA_Patterns.json.terminology, cross-file consistency with SAG).

Per the work plan §4.2 PR-3 boundary:

- ✅ Default mode is backwards-compatible: legacy workspaces without SAG/TC
  pass through with both gates reporting `status: 'skipped'`.
- ✅ Strict-authority mode: any gate `status: 'fail'` causes `compileDomain`
  to throw with `Error.code === 'GATE_FAIL'`.
- ✅ Output is structured (JSON-serializable) and consumable by a future UI
  layer (per work plan §4.2 PR-3 "Output contract" requirement).

## RFC-0013 §9 acceptance criteria covered

| # | Item | Status | Where |
|---|------|--------|-------|
| #3 | kdna-studio-core rejects (with a clear error) any `compile()` call where the source workspace has a TC with `tc_status: "synthesized"` and a SAG with no `current_highest` source, **and** the caller passes `--strict-authority` | ✅ | this PR |

Not covered (still pending):
- #2 kdna dev validate --anti-monolithic: PR-2 (merged)
- #4 kdna-lab smoke on simple official domain: PR-4
- #5 SPEC §1.6 Anti-Monolithic principle verbatim: PR-2a (merged)
- #6 RFC-0014 / RFC-0015 filed: Phase 2 (deferred)
- #7 real legacy domain migration: PR-4

## Files

| File | Change | Lines |
|------|--------|-------|
| `src/compile/source-authority-gate.js` | new | ~170 |
| `src/compile/truth-charter-gate.js` | new | ~140 |
| `src/compile/index.js` | modified (gate integration in `compileDomain`) | +35 / -3 |
| `tests/compile-gates.test.js` | new (13 tests using `node --test`) | ~210 |
| `docs/compile/gates.md` | new | ~110 |

## PR-2 semantic debt recorded (NOT addressed by this PR)

PR-2 (the Anti-Monolithic CLI lint in kdna-cli) implements structural
thresholds only. The original SPEC §1.6.3 third condition:

> spans more than 2 distinct user-facing judgment questions

…is **not implemented** in PR-2. The CLI substitutes a structural check
(presence of `module_manifest.json` + substantive `decomposition_rationale`)
for the question-count heuristic.

**This PR does not fix the debt.** The Studio gates operate on SAG and TC
alone; they do not depend on the question-count heuristic. Any future
attempt to implement the question-count check should:

1. Land in PR-2 (the CLI), not PR-3.
2. Be specified as a separate RFC (suggested: RFC-0022 "Anti-Monolithic
   Question-Count Heuristic").
3. Be tested independently of the SAG/TC gates.

Full reasoning is in `docs/compile/gates.md` under "PR-2 semantic debt".

## Validation

### PR-3 unit tests (13/13 pass)

```
$ node --test tests/compile-gates.test.js

ok 1 - legacy workspace without SAG/TC: default mode passes (gate skipped)
ok 2 - legacy workspace without SAG/TC: strict-authority passes (no objects to fail on)
ok 3 - SAG present but no current_highest: strict-authority throws
ok 4 - current_highest is a deprecated source: strict-authority throws
ok 5 - TC status: synthesized: strict-authority throws
ok 6 - TC status: locked: strict-authority passes
ok 7 - TC renamed_terms inconsistent with terminology: warning, not error
ok 7b - TC renamed_terms inconsistent with provided patterns: warning, not error
ok 8 - SAG precedence_order references unknown source id: errors
ok 9 - default mode: same problems are warnings, not errors
ok 10 - output is structured and JSON-serializable
ok 11 - cross-file consistency: SAG human_locked_charter + TC missing judgment_authority_holder
ok 12 - lower-authority source before current_highest in precedence_order: errors
# tests 13 # pass 13 # fail 0
```

### Pre-existing failures (NOT introduced by this PR)

`node --test tests/*.test.js` reports **11 pre-existing failures** in
`tests/core.test.js`, `tests/e2e.test.js`, and `tests/milestone3.test.js`.
These were present before PR-3 (verified via `git stash` + re-run on
clean tree: 11/110 fail on baseline, 11/123 fail with PR-3 added; 13/13
PR-3 tests pass).

The 11 pre-existing failures are about test expectations like
`'KDNA_Core.json' in result.files` which conflicts with the v2 container
contract: post-6-11, `compileDomain` emits `payload.kdnab` (CBOR), not the
six-file source tree. These failures are **out of scope for PR-3**;
they predate it and would need a separate test-suite migration PR (out of
PR-3 boundary per work plan §4.2).

PR-3 itself does not introduce any new test failures.

### CLI smoke (script-free)

```
$ node -e "..."  # See PR-3 audit verify commands
```

## Output contract (consumable by future Studio UI)

```js
{
  files: { 'payload.kdnab': <Buffer>, 'KDNA_CARD.json': '...', ... },
  stats: { ... },
  identity: { ... },
  gates: {
    sag: {
      gate: 'source_authority',
      status: 'skipped' | 'pass' | 'warn' | 'fail',
      errors:   [string, ...],   // strict-only
      warnings: [string, ...],   // always populated
      source_authority: object | null,
      strict_authority: boolean
    },
    tc: { /* same shape, gate: 'truth_charter' */ },
    strict_authority: boolean
  }
}
```

JSON-serializable. Round-tripped in test 10.

## Risk notes

- **No changes to runtime payload** — `compileDomain`'s output (`files`,
  `stats`, `identity`) is byte-identical when both `sourceAuthority` and
  `truthCharter` are `undefined` (default for legacy callers).
- **No changes to existing schema** — gates read existing source
  workspace files (`source_authority.json`, `truth_charter.json`); they
  do not introduce new schema files.
- **No new dependencies** — uses only Node built-ins.
- **Default mode is strictly backwards-compatible** — no existing test
  changes behavior.

## Governance

- This PR follows the real PR flow (feature branch, push, PR, admin merge).
- No direct push to `main`.
- PR title and description clearly limit scope to PR-3.
- PR-2 semantic debt is recorded in `docs/compile/gates.md` for future
  maintainers.

## References

- RFC-0013: https://github.com/aikdna/kdna/blob/main/specs/RFC-0013-judgment-asset-lifecycle.md
- RFC-0013 §3.1: same file, "Source Authority Graph"
- RFC-0013 §3.2: same file, "Truth Charter"
- RFC-0013 §9 #3: same file, "Acceptance Criteria" #3
- Work plan: `Kdna内部思考/KDNA 协议升级工作计划 2026-06-16.md` §4.2 PR-3
- PR-1 (schema baseline): https://github.com/aikdna/kdna/pull/86
- PR-2 (CLI lint): https://github.com/aikdna/kdna-cli/pull/10
- PR-2a (SPEC §1.6.3): https://github.com/aikdna/kdna/pull/87
