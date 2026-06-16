# Compile Gates (SAG / TC)

The PR-3 add for kdna-studio-core adds two compile-time gates that
enforce the Source Authority Graph and Truth Charter constraints from
RFC-0013 §3.1 / §3.2.

## API surface

`compileDomain(project, options)` now accepts:

```js
{
  sourceAuthority: <object | undefined>,  // parsed source_authority.json
  truthCharter:   <object | undefined>,  // parsed truth_charter.json
  strictAuthority: <boolean>              // when true, gate violations throw
}
```

The return value gains a new top-level `gates` field:

```js
{
  files: { ... },
  stats: { ... },
  identity: { ... },
  gates: {
    sag:   { gate: 'source_authority', status, errors, warnings, source_authority, strict_authority },
    tc:    { gate: 'truth_charter',    status, errors, warnings, truth_charter,    strict_authority },
    strict_authority: <boolean>
  }
}
```

`status` is one of `'skipped' | 'pass' | 'warn' | 'fail'`.

## Default vs strict

| Mode | Behavior |
|------|----------|
| Default (`strictAuthority: false`, default) | All rule violations are reported as `warnings`. No throw. The function still returns a complete `gates` block. |
| `strictAuthority: true` | Rule violations are reported as `errors`. If any gate's `status === 'fail'`, `compileDomain` throws an `Error` with `code: 'GATE_FAIL'` and the `gates` block attached. |

`status: 'fail'` only happens under `strictAuthority: true` (when a rule
violation becomes an error). In default mode, the same condition reports
`status: 'warn'` so the gate is observable but non-blocking.

## SAG gate rules (`runSagGate`)

| # | Rule | Default | Strict |
|---|------|---------|--------|
| R1 | `precedence_order` references must all exist in `sources[].id` | warning | error |
| R2 | At least one source must have `authority: "current_highest"` | warning | error |
| R3a | `authority: "deprecated"` requires `status: "deprecated"` | warning | error |
| R3b | `authority: "current_highest"` requires `status: "active"` | warning | error |
| R3c | Deprecated sources must not appear in `precedence_order` | warning | error |
| R4 | The first `current_highest` in `precedence_order` must not be preceded by any lower-authority source | warning | error |
| R5 | `sensitivity.sources_contain_pii: true` without `author_consent_on_file: true` | warning (always) | warning (always) |

## TC gate rules (`runTcGate`)

| # | Rule | Default | Strict |
|---|------|---------|--------|
| R1 | `tc_status` must be one of `draft \| synthesized \| locked \| deprecated` | error (always; malformed) | error (always) |
| R2 | `tc_status: "synthesized"` requires the author to upgrade to `locked` | warning | error |
| R3 | `tc_status: "deprecated"` cannot govern new compilations | warning | error |
| R4 | `tc_status: "locked"` requires `locked_at` and `locked_by` | error (always; malformed lock) | error (always) |
| R5 | `renamed_terms` consistency with `KDNA_Patterns.json.terminology.{standard_terms,banned_terms}` | warning (always; only when terminology has content) | warning (always) |
| R6 | `forbidden_simplifications` presence is recorded; we do not perform LLM-based semantic verification (out of scope for a deterministic gate) | n/a | n/a |

Cross-file consistency: if `sourceAuthority` has any `current_highest` source
of `type: "human_locked_charter"` and TC is present, `TC.judgment_authority_holder`
must be present and non-empty (warning in default, error in strict).

## Backwards compatibility

If neither `sourceAuthority` nor `truthCharter` is supplied, both gates report
`status: 'skipped'` and `compileDomain` proceeds exactly as before. Existing
tests that do not pass these options (e.g., legacy workflows) continue to
work without modification.

## PR-2 semantic debt (NOT addressed by PR-3)

PR-2 (the Anti-Monolithic CLI lint) implements structural thresholds only.
The original SPEC §1.6.3 wording is:

> If a domain's `KDNA_Core.json` exceeds 6 primary axioms **and** contains 3+ `frameworks` **and** spans more than 2 distinct user-facing judgment questions, the author MUST either (a) split into sub-domains and reference via cluster, or (b) justify monolithic structure in a `module_manifest.json` with a `decomposition_rationale` of at least 30 characters and obtain a maintainer sign-off recorded in the TC.

The third condition — "spans more than 2 distinct user-facing judgment
questions" — is **not implemented** in PR-2. The CLI currently substitutes
the structural check (presence of `module_manifest.json` + substantive
`decomposition_rationale`) for the question-count heuristic.

**PR-3 explicitly does not fix this debt.** The Studio gates operate on
SAG and TC alone; they do not depend on the Anti-Monolithic question-count
heuristic. Any future attempt to implement the question-count check
(e.g., by counting `frameworks[].highest_question` or `frameworks[].scope`
unique values) should:

1. Be added to PR-2 (the CLI), not PR-3.
2. Be tested independently of the SAG/TC gates.
3. Be specified as its own RFC (suggested: RFC-0022 "Anti-Monolithic
   Question-Count Heuristic"), so that the new field/rule is reviewed
   before it lands in any gate.

This debt is recorded here so the next maintainer can see it without
having to re-derive the chain of reasoning from git history.
