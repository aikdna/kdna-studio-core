# Studio creation evidence format 1

This is a private Studio-owned evidence representation. It does not change a public KDNA container, Core/Read/IR contract, admission authority, human identity, or the meaning of existing Studio 3.0.0 records.

## Discriminator and unchanged payload

New producers emit `format: "kdna.studio-creation-evidence/1"` and retain `kind: "studio-blank-material-evidence"`. The top-level fields are exactly `format`, `kind`, `session_id`, `synthetic_fixture`, `agent`, `compiler`, `revision`, `materials`, `candidates`, `human_messages`, `history`, `final_decision`, `artifact`, `core`, `creation`, `confirmation`, `identity`, `read_permission`, and `action_authorization`.

The existing blank-material session, material entries, authored candidates, human-channel messages/reviews, history entries and final decision retain their existing field meanings and digest coverage. In particular `artifact` remains `{digest, bytes}`, `expectedBinding` remains the separate trusted `{session_id, asset_digest, evidence_digest}`, and each history digest covers the complete entry with its `digest` member removed. Private materials, coordinates, history, provider records and confirmation never enter the public container. A producer must actually call its public Core admission implementation on its output bytes; a verifier must independently admit the supplied exact bytes using its own public Core and compare A/C/E evidence.

`revision`, history `sequence`, candidate `revision`, message/review revisions and artifact `bytes` are nonnegative safe integers (at most 9007199254740991). Text must be well-formed Unicode; no normalization is performed. Session/material/candidate/message IDs and timestamps remain actual producer values. Interoperability does not require two independently created sessions to share random IDs, timestamps or container bytes.

## Actual compiler and admission provider

New `compiler` is the closed record `{name, version, provider, artifact_sha256}`. `name` and `version` describe the actual Studio producer. `provider` is `javascript` or `swift`. `artifact_sha256` is a lowercase 64-hex digest when independently available, otherwise the literal `UNKNOWN`. The current producers record `UNKNOWN` for their own self-containing package: they must not invent a self-referential package digest. This compiler record also appears unchanged in the producer's compiler-preview history detail.

New `core` is the closed record `{status, reference_contract, implementation, digests}`. `status` must be `valid`; `digests` is the actual admitted public Core A/C/E evidence object.

`reference_contract` is exactly `{core, read, tuple}`. Its `core` and `read` records are exactly `{package, version, artifact_sha256}`:

| Reference | package | version | artifact_sha256 |
| --- | --- | --- | --- |
| Core | @aikdna/kdna-core | 0.23.0 | b2cecb761e599d8711114d7288d6caf627b1aa01620699ecb1fca49ac3bb6ba0 |
| Read | @aikdna/kdna-read | 0.2.0 | 1595075677dc1359c2df751ec54a706b55ffff6bfc77d117e16464fb16a5c96e |

`tuple` is the exact public tuple in the accompanying FORMAT.json. Read package 0.2.0 retains read contract `kdna.read/0.1.0`. The reference Read coordinate does not claim that the producer executed Read.

`implementation` is exactly `{provider, name, version, artifact}`; `artifact` is exactly `{kind, sha256}`. These two admission-provider coordinate sets are supported in this revision:

| provider | name | version | artifact.kind | artifact.sha256 |
| --- | --- | --- | --- | --- |
| javascript | @aikdna/kdna-core | 0.23.0 | npm-tgz | b2cecb761e599d8711114d7288d6caf627b1aa01620699ecb1fca49ac3bb6ba0 |
| swift | KDNACore | 0.3.1 | source-tar-gz | fc0bbb87af1b418aeea3700a0d63e72fbec3af692838e1eefa68d77359c981a3 |

The compiler and admission implementation providers must agree for these supported producers. Unknown provider sets, partial or mixed legacy/new Core shapes, extra discriminator/Core/compiler fields, unsupported reference coordinates/tuple, and unknown format fail closed. These declarations never select a module, file path, remote endpoint, credential or trust source.

Provider/package names and digest strings are claims bound by the private evidence digest, not execution-identity authentication. Changing a field without the original trusted binding must fail; a caller who supplies a newly forged trusted binding is outside binding authenticity. Even a syntactically supported complete declaration cannot prove which process executed admission. Verification must describe this limit and must not upgrade `claimed_unverified`, `not_verified`, or `not_evaluated`.

## Private JSON digest representation

For format 1, the digest input domain is an acyclic JSON value: null, booleans, finite binary64 numbers, well-formed Unicode strings, dense arrays, and plain records with own enumerable data members only. Reject undefined, holes, functions, bigint, symbols, accessors, custom prototypes/toJSON conversion, malformed surrogate text, nonfinite numbers, cycles, and values exceeding depth 64 or 100000 total values. Field constraints above additionally restrict the actual evidence numeric fields to safe integers. No input getters or conversion callbacks are invoked.

1. Object member names are sorted lexicographically by unsigned UTF-16 code units, exactly JavaScript `Object.keys(value).sort()`; compare exact code units, not locale or normalization-aware equality. Arrays retain order.
2. Emit no insignificant whitespace. Quotes and backslashes use `\"` and `\\`. U+0008/0009/000A/000C/000D use `\b`, `\t`, `\n`, `\f`, `\r`; other U+0000..001F use lowercase `\u00xx`. Slash, U+2028 and U+2029 are not escaped. All other valid Unicode scalar values are emitted literally as UTF-8. Composed/decomposed strings remain distinct.
3. Numbers use ECMAScript `JSON.stringify` binary64 spelling: negative zero emits `0`; finite shortest round-trip decimal, decimal notation for the ordinary -6..20 exponent interval, otherwise lowercase `e`, explicit plus for positive exponent, no exponent zero padding. Nonfinite values are rejected, never converted to null.
4. SHA-256 hashes the UTF-8 bytes of this representation. Evidence/material/history digest strings use lowercase `sha256:` followed by 64 hex digits; artifact pins above deliberately contain only the 64 hex digits.

The accompanying canonical-vectors.json records actual JavaScript inputs and expected UTF-8 bytes/hash, including non-BMP/BMP key ordering, composed/decomposed keys, controls, negative zero and exponent boundaries. Swift may use its accepted public KDNAJSON canonical serializer where its output matches these private rules; it must not copy or reinterpret the public IR digest implementation.

## Legacy branch and verification meaning

An existing record with no own `format` member uses the explicit legacy Studio blank-material branch. Its original bytes/digest rules and original `core: {status, package, version, digests}` meaning are retained: that field claimed actual JavaScript Core 0.23.0 admission. Do not reinterpret it as a reference-only field. Reject new provider/reference fields mixed into this legacy Core/compiler shape. Missing historical artifact/provider execution proof is reported `UNKNOWN`; do not fill in either today's b2ce.../1595... graph or an old same-version archive from the version string.

Both new verifiers still check the trusted external binding, real public Core admission, material content hashes and references, selected/rejected review completeness, history sequence/previous digest chain, final human-message/preview/artifact/revision association, and unchanged authority markers. Consistency is a limited evidence check: confirmation remains `claimed_unverified`, identity `not_verified`, Creation acceptance and action authorization `not_evaluated`. Old unmodified Studio 3.0.0 is not required to accept format 1; its actual rejection/compatibility result must be recorded, never represented as new-format support.
