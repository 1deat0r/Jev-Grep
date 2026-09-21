# Jev-Grep v1 specification

Date: 2026-09-21. Status: reviewed design, revision 1.0; no implementation or benchmark claims. See REVIEW.md for the review record.

## 1. Purpose and scope

Jev-Grep gives people and agents bounded, reproducible evidence from a local workspace. Its first release supports live literal/regex search and indexed lexical discovery through the same CLI, SDK, and MCP contracts. Semantic vectors are a gated extension, not a release dependency.

MUST denotes a release requirement. SHOULD denotes a default whose deviation must be documented. Numeric performance targets are proposed acceptance criteria, not measured results.

The initial workload is a single-user local Linux workspace on a local filesystem: UTF-8 source, Markdown, configuration, and plain-text documents. TypeScript/JavaScript is the first code-oriented evaluation language; Python and Markdown exercise language-independent text retrieval. Network filesystems, multi-host coordination, archive extraction, OCR, arbitrary document conversion, code execution, generated answers, and verified call/type graphs are outside v1. Non-UTF-8 and binary files are reported as unsupported rather than silently converted. No embedding model is mandatory.

The v1 product is judged by task success, evidence sufficiency, correctness under file changes, and bounded cost. Reviewer scores are judgments about this specification, not product-quality measurements.

## 2. System boundaries and initial architecture

- A strict TypeScript core owns request validation, scope policy, evidence construction, retrieval orchestration, and result encoding.
- One versioned schema package generates public TypeScript types and JSON Schema. Transport adapters MUST NOT maintain parallel handwritten contracts. Runtime semantic invariant checks supplement schema validation.
- A pinned ripgrep adapter performs live exact retrieval. Arguments are passed as an argv array without shell interpolation; user patterns cannot become flags.
- SQLite owns the indexed catalog, content revisions, chunks, lexical retrieval, generation state, and compatibility metadata. The initial implementation uses one store before introducing cross-store coordination.
- One service owns all index access for a canonical workspace. Direct CLI usage invokes the same service boundary; it does not independently mutate storage.
- CLI, SDK, and MCP MUST share normalization, limits, errors, and search semantics. CLI human formatting is a view of the structured result.
- A future vector adapter MUST satisfy the durability, isolation, generation-filtering, and recovery contract before activation. A vector capability is not inferred merely from an upsert/search API.

Default compiler settings include strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, and useUnknownInCatchVariables. Unvalidated external data starts as unknown. Unsafe casts and native boundaries require narrow, reviewed wrappers; brand names alone establish no runtime guarantee.

An upstream reuse spike precedes implementation commitments: inspect license, API/format stability, crash recovery, supported runtimes, local-only behavior, and benchmark reproducibility. Reuse only behind the public contract. Selection of Rust, an embedding model, or an upstream fork remains an evidence-based decision.

## 3. Search and scope semantics

Exact operations are literal or regex, and retain explicit case sensitivity. Initial regex semantics are the pinned ripgrep default engine; no implicit PCRE fallback. Matching is line-oriented; multiline regex is outside v1. Discovery is ranked lexical search, optionally augmented by a promoted semantic backend. Exact hits are not relevance-ranked.

Every request binds to a registered workspace ID and immutable scope-policy ID. Registration resolves an absolute root; clients cannot supply arbitrary filesystem paths after registration. Policy fixes include/exclude rules, hidden-file behavior, ignore rules, supported encodings, maximum eligible file size, and symlink behavior. Defaults respect ignore files, skip hidden files, exclude the index directory, and do not follow symlinks. Policy changes invalidate scope compatibility rather than quietly changing a generation's meaning.

All returned paths are relative to the registered root. Canonical containment checks alone are insufficient: reading MUST use safe descriptor-based containment or an equivalent documented mechanism that rejects symlink/root escapes during the operation. If this cannot be enforced on a platform, that platform is unsupported rather than silently weaker. Scope is applied before retrieval and rechecked before source expansion.

Exact completeness means the eligible enumeration completed without failed reads or interruption, not that the filesystem was a point-in-time snapshot. Each inspected file is read from one opened file handle; detected mutation causes at most one retry within the original budget. If mutation persists, skip the affected file, emit SOURCE_MUTATED, and make exact coverage partial (or record an eligible-file failure during indexing). Concurrent changes can prevent complete temporal coverage even when enumeration completes. Negative results mean no matches observed in that scope during the reported interval.

Discovery is never exhaustive. Lack of results MUST NOT be labeled proof of absence. Lexical tokenization SHOULD preserve full identifiers alongside subtokens; ranking/chunk configuration is versioned. Primary evidence has stable byte coordinates with contextual links; deduplication MUST preserve distinct revisions and matching occurrences.

Initial exact output ordering is explicitly unspecified; no cursor/pagination is offered in v1. Hitting a result, byte, or time limit returns partial execution with an explicit reason. Clients narrow scope or rerun with supported limits rather than treating a truncated result as exhaustive. Indexed discovery uses deterministic score tie-breaking by relative path, byte start, and evidence ID within one generation.

## 4. Evidence and trust

Evidence identity binds workspace, source content digest, byte range, and extraction configuration. Hashes identify exact original UTF-8 bytes. Byte ranges are zero-based half-open; line numbers are one-based display aids derived from those bytes. CRLF is preserved in source hashing. Display escaping and presentation truncation cannot alter the source range or imply omitted bytes were returned.

The result distinguishes immutable captured evidence from optional comparison with live source. Live comparison reports verification time and the digest observed then. It never promises the file will remain unchanged or that other files were captured at the same instant. Partial slices cannot be described as verification of a whole-file digest unless the full file was actually hashed.

Indexed evidence needed to reproduce a result is retained with its generation. A subsequent source read MUST verify the expected source revision; if the file changed, return a typed revision mismatch and offer a fresh read explicitly. Never silently substitute different bytes behind an old citation.

The agent treats source content as untrusted evidence, not tool instructions. Jev-Grep does not execute retrieved content or generate shell commands. All model-derived plans pass the same validation and budgets as user-supplied requests. File contents, queries, paths, and snippets are excluded from default telemetry and logs. Operational logs contain bounded error codes and counts.

All outbound content-bearing provider traffic passes one egress policy. Remote embeddings, reranking, answers, and content telemetry are disabled by default. Explicit per-workspace policy must name allowed providers, content classes, and byte budgets; provider switching cannot bypass it. v1 needs no network access for searching an existing local index.

Defaults: 100 exact hits, top 20 discovery hits, 64 KiB serialized result budget, 4 KiB snippet budget per hit, 10-second search deadline, 1 MiB eligible source-file limit. Hard caps: 1,000 hits, 1 MiB response, 30-second search deadline, and 16 MiB eligible file size. A deployment may lower caps; increasing hard caps requires a new policy version. Oversized/unsupported files contribute coverage exclusions. Budgets cover model expansion as well as direct requests. Cancellation propagates to subprocesses/providers and releases resources; cancellation is not an empty success.

## 5. Index authorization and lifecycle

Workspace registration does not authorize persistent indexing. An explicit index-create operation authorizes initial scope/configuration and records whether incremental refresh is manual or enabled. Rebuild, embedding-model replacement, and scope expansion require a separate explicit operation. Searches never create or rebuild an absent or incompatible index. Background refresh is permitted only under recorded incremental-refresh authorization.

Filesystem watchers are hints. Startup and explicit refresh reconcile eligible files against content hashes. A completed scan reports its interval and exclusions; it does not claim an atomic filesystem snapshot. Changed/new files after the scan may be absent, and verifying returned hits does not prove discovery completeness. Deletes and renames become visible in the next published generation; old evidence stays identifiable as old.

Each generation records scope-policy hash, chunk/extractor version, lexical configuration, source revisions, file outcomes, and optional embedding provider/model fingerprint, dimensions, distance metric, and adapter format. Incompatible formats fail closed with actionable errors.

### 5.1 Coordination and transitions

All indexed operations MUST acquire an OS-managed workspace lock. Searches hold a shared lock for the full indexed evidence read; indexing, recovery, publication, and collection hold an exclusive lock. Locks release on process death. v1 does not promise concurrent indexing and indexed searches and uses no persistent reader leases. Live exact searches need no index lock. A waiting search respects its original deadline and cancellation signal. Explicit cancellation before useful work returns CANCELLED with nextAction=none. Deadline expiry returns DEADLINE; expiry of a shorter bounded lock-admission interval returns INDEX_BUSY. Contention/deadline responses may offer exact fallback within any remaining original budget. No retry resets a deadline. Cancellation after useful work follows section 8.1. The daemon also enforces these rules among its own requests; a process-level lock alone is not an internal scheduler. Admission uses a bounded FIFO queue (default maximum 64 pending requests); once an exclusive operation is queued, later indexed reads cannot bypass it. Full admission returns INDEX_BUSY rather than allocating an unbounded queue. Cancelled/expired entries are removed without delaying eligible requests. Live exact remains independent of this index queue. Acceptance tests must demonstrate that continuous reader arrival cannot starve an already queued writer.

Generation transitions:

| State | Required invariant / transition |
|---|---|
| staged | Catalog manifest exists before external writes; generation-qualified immutable record IDs; previous publication untouched |
| validated | All required records and captured evidence are durable and readable; IDs/counts, content hashes, dimensions, configuration, and indexing outcomes verified |
| published | A single SQLite transaction changes the sole published pointer and retires its predecessor; only this transition makes the generation query-visible |
| retired | New queries cannot select it; exclusive locking proves no old indexed reader remains |
| collected | Generation-owned payloads removed; bounded diagnostic tombstone optional |

Interrupted staged/validated generations are discarded, never silently published. Discard and collection MUST be idempotent; ownership manifests remain until their payloads are removed. Required metadata/storage failures abort publication. Individual eligible-file read/extraction failures may produce a generation only with explicit incomplete coverage and per-file outcomes; they are not hidden as exclusions. Every usable chunk must still pass its own integrity checks.

### 5.2 Durability and recovery

SQLite uses WAL with synchronous FULL on the supported local filesystem. v1 guarantees recovery under process termination; sudden power-loss behavior is separately characterized and cannot be inferred solely from process-kill tests or SQLite settings. Published data is never overwritten in place.

A vector extension MUST provide idempotent generation-qualified writes/deletes, strict generation isolation, an explicit durability barrier, read-after-barrier validation, owned-record enumeration/deletion, and errors for ambiguous operations. A successful barrier must satisfy the declared crash model. Validate actual IDs/content metadata, not only aggregate counts. A backend without these capabilities is ineligible for persistent mode.

After unclean shutdown, exclusive recovery precedes indexed service: discard incomplete builds, resume collection, and verify published catalog/required records are readable. Missing required published data yields INDEX_UNAVAILABLE; no silently incomplete indexed success. Live exact remains available when the index is unavailable. Recovery may leave cleanup pending only if the published data remains intact and safe to serve; retained bytes and errors must be visible.

Default storage budget: 2 GiB index-owned bytes and a 1 GiB filesystem free-space floor. These are configurable policy values. Admission accounts for published data, staging, WAL/journal growth, and verification overhead; estimates cannot replace handling ENOSPC on every write. Incremental builders SHOULD reuse unchanged immutable payloads, but shared payloads require reference-safe collection. A simpler copy-per-generation implementation is allowed within the same budget.

Index-owned byte accounting includes database, WAL/SHM, vector backend, staging, and log files. Report both allocated filesystem blocks and apparent file sizes; enforce quota against the larger aggregate to avoid sparse-file accounting surprises. Logical deletion is not reported as filesystem reclamation. New SQLite databases enable auto_vacuum=INCREMENTAL before creating tables; exclusive maintenance performs bounded incremental_vacuum batches and a checked wal_checkpoint(TRUNCATE), with measured headroom for WAL growth. Read back required PRAGMA settings rather than assuming they took effect. Status distinguishes reusable database pages from actual reclaimed filesystem bytes. Full VACUUM is not automatic; any strategy requiring a temporary copy must reserve its headroom or fail safely. Maintenance has a bounded time budget and may resume later; pending bytes continue to count against quota. These choices use SQLite's documented [auto-vacuum and checkpoint behavior](https://www.sqlite.org/pragma.html).

On quota/free-space breach, abort staging/publication and preserve the current publication; clean unpublished data. Never delete the published generation to free space. If cleanup fails, report retained bytes and STORAGE_FULL. After an update fails, indexed results carry the update failure and generation age. Quotas include orphaned staging and logs; logs rotate within a bounded allowance.

### 5.3 Fault acceptance matrix

| Injected fault | Required observable outcome |
|---|---|
| Crash before/during chunk/vector writes | Previous publication usable; staging discarded on recovery |
| Acknowledged backend record absent at validation | Validation fails; no publication |
| Crash after validation before publication | Previous pointer retained; incomplete build discarded |
| Crash during publication transaction | Exactly old or new pointer after recovery |
| Crash after publication before collection | New generation usable; retired data later collected |
| Crash during collection or repeated cleanup | Published data intact; cleanup converges without touching another generation |
| Reader process death / request cancellation | Lock/request released; next mutation can proceed |
| Disk exhaustion at any write/publication boundary | Old or fully committed new publication, never a mixed state |
| Missing required published records | Explicit INDEX_UNAVAILABLE |
| Repeated build/publish/collect near quota | Bounded steady-state storage or STORAGE_FULL; physical reclamation reports match measurement; publication intact |
| Workspace file replaced/renamed during indexing | Captured revision retained accurately; scan limitations reported |

Each matrix row is a required automated fault test; external durability-contract claims also require adapter-specific integration tests.

## 6. Release sequence

1. Freeze v1 contracts and workload/evaluation acceptance rules; build independent conformance fixtures.
2. Ship live exact CLI/SDK/MCP with confined reads, limits, revision verification, and explicit outcomes.
3. Add explicit SQLite lexical indexing with generation lifecycle, recovery, and changed/deleted-file tests.
4. Compare hybrid retrieval with lexical baseline. Add one vector adapter/model only if promotion gates pass.
5. Consider one compiler-backed relationship adapter only after demonstrated task failures justify it. This is a separately versioned capability; syntax guesses cannot masquerade as resolved edges.
6. Consider reranking and bounded graph expansion independently. Generated answers remain downstream.

No stage is promoted merely to meet a review score. Release requires its conformance and fault tests plus the applicable performance/quality gates. Failed improvements remain experiments and do not displace a passing baseline.

## 7. Required design artifacts

The implementation must retain: executable generated contract schemas; conformance fixtures; a lifecycle transition implementation and fault suite; a benchmark manifest with frozen repositories, query splits, reference hardware, tool versions, and results; and a decision record for upstream/backend choices. This document specifies their acceptance conditions; it does not claim those artifacts already exist.

## 8. Public contract

The following is normative pseudocode; omitted primitive definitions are constrained below. The schema package must implement the same discriminants and reject impossible field combinations.

```ts
type Request = {
  version: 1;
  requestId: string;
  workspaceId: string;
  scopePolicyId: string;
  narrow?: { include: string[]; exclude: string[] };
} & (
  | { operation: 'exact'; query:
        | { kind: 'literal'; text: string; caseSensitive: boolean }
        | { kind: 'regex'; pattern: string; caseSensitive: boolean };
      maxMatches: number }
  | { operation: 'discover'; question: string; anchors: string[];
      maxHits: number; verifyLive: boolean }
);

type Issue = {
  code: string; stage: string; retryable: boolean;
  message: string; path?: WorkspaceRelativePath;
  nextAction: 'narrow-scope' | 'retry-once' | 'use-exact'
    | 'request-index-create' | 'request-rebuild' | 'free-storage'
    | 'fix-request' | 'none';
};

type Response =
  | { version: 1; requestId: string; status: 'error'; error: Issue }
  | { version: 1; requestId: string; status: 'ok';
      scope: EffectiveScope; issues: Issue[];
      result: ExactResult | DiscoveryResult };

type ExactResult = {
  operation: 'exact'; source: { kind: 'live-read'; startedAt: string; endedAt: string };
  coverage:
    | { kind: 'complete' }
    | { kind: 'partial'; reasons: Array<'limit' | 'cancelled' | 'read-failure' | 'deadline' | 'policy-changed' | 'source-mutated'> };
  matches: ExactMatch[];
};

type DiscoveryResult = {
  operation: 'discover';
  source: { kind: 'index'; generationId: string; manifestHash: string;
    publishedAt: string; scanStartedAt: string; scanEndedAt: string;
    coverage: 'eligible-scan-complete' | 'eligible-scan-incomplete'; failedFiles: number };
  selection: { kind: 'ranked'; requestedLimit: number;
    limitReached: boolean; degraded: boolean };
  execution:
    | { kind: 'complete' }
    | { kind: 'partial'; reasons: Array<'byte-limit' | 'cancelled' | 'deadline'> };
  hits: RankedHit[];
};

type Evidence = {
  id: string; path: WorkspaceRelativePath; fileSha256: string;
  range: ByteRange;
  excerpt: { range: ByteRange; text: string; truncated: boolean };
};

type LiveVerification =
  | { kind: 'not-requested' }
  | { kind: 'matched'; checkedAt: string; observedFileSha256: string }
  | { kind: 'changed'; checkedAt: string; observedFileSha256: string }
  | { kind: 'unavailable'; checkedAt: string; issue: Issue };
```

ByteRange is {start: nonnegative integer, end: nonnegative integer}, start <= end, bounded by source length. IDs are nonempty opaque strings with bounded lengths; SHA-256 values are lowercase 64-character hexadecimal; timestamps are UTC RFC3339. Numeric limits are bounded positive integers. Request text/pattern is nonempty, <=8 KiB UTF-8; anchors <=16, each <=256 bytes; filter patterns <=64, each <=1 KiB. Unknown request fields are rejected. Scope narrowing intersects the registered policy and cannot expand it. Error messages are bounded and must not echo sensitive contents.

EffectiveScope includes policy ID/hash, effective narrowed patterns, ignore/hidden/symlink/encoding/file-size policies, and counts of searched/indexed, excluded, unsupported, oversized, and failed files when known. Unknown counts are null with a reason, never fabricated zeros. Exclusion policy files and their content digests are captured per operation/generation; policy changes detected during enumeration produce partial coverage. Hash identity does not imply coherent filesystem snapshot identity.

ExactMatch includes Evidence plus exact-match provenance and match range; RankedHit includes Evidence, generationId, liveVerification, rank, and nonempty retrieval provenance (lexical or vector with config fingerprint). Scores, if exposed, are route-specific values, never confidence probabilities. Exact provenance never includes inferred relationships. Excerpt text re-encoded as UTF-8 MUST equal captured bytes at excerpt.range, on UTF-8 boundaries. excerpt.truncated is true exactly when excerpt.range does not contain the entire evidence range; otherwise it is false. Excerpts may be shorter than a match only when this marker and the ranges explicitly indicate it. Byte ranges and evidence digest are computed on the exact bytes searched, never by reopening a path after ripgrep searched it.

The exact adapter MUST search captured bytes (for example, pass each retained file buffer to ripgrep stdin) or use an equivalent single-revision mechanism. It MUST NOT search a live path, reread it, and label the reread as the matched revision without proving equality. Resource limits still apply; stdin/output is streamed with bounded buffers. Multiple matches per line and zero-width matches have distinct, stable occurrence coordinates; zero-width progress semantics follow the pinned engine.

### 8.1 Legal state rules

- Invalid request, unsupported version, no usable required provider/store, or cancellation before useful work returns error; never successful zero matches.
- Exact complete requires eligible enumeration/read success and every observed match returned. Read failure, policy mutation, deadline, cancellation, or proven truncation makes it partial with corresponding issues. Returning exactly maxMatches does not prove truncation: complete requires proving enumeration ended with no additional match. Early stopping is partial.
- Discovery complete means its requested pipeline finished; it does not mean exhaustive discovery. limitReached describes count versus requested limit, not evidence left unseen. Optional provider failure allows lexical fallback only with degraded=true and an issue. Deadline after useful results may return partial; before useful results returns an error.
- A required lexical store failure cannot be disguised as successful lexical fallback. Missing/incompatible index returns error and a supported next action.
- verifyLive=true requires matched, changed, or unavailable on every hit; false requires not-requested. Changed/unavailable evidence remains explicitly historical and cannot be presented as verified current evidence.
- All indexed hits belong to the response generation. No live-read replacement may be spliced into a pinned indexed hit; fresh evidence is a separate result.
- A matched live check is a full-file digest comparison from one read, timestamped at completion. It is an observation, not a guarantee against later mutation or a filesystem-wide snapshot.
- The same conditions produce the same discriminants across CLI/SDK/MCP. Human output must preserve partial/degraded/historical status.

| Cross-field invariant | Required rule |
|---|---|
| Response operation | Equals request operation |
| Exact match count | <= requested maxMatches |
| Ranked hit count/ranks | <= requested maxHits; contiguous ranks 1..N |
| limitReached | Exactly equals returned hit count == requested maxHits |
| Partial reasons | Nonempty, unique, and each backed by a corresponding issue |
| Degraded retrieval | True whenever a configured optional retrieval stage failed; issue required |
| Incomplete eligible scan | At least one recorded failure; failedFiles counts failures over generation scope, not narrowed query scope |
| Matched verification | observedFileSha256 equals evidence.fileSha256 |
| Changed verification | observedFileSha256 differs from evidence.fileSha256 |
| Unavailable verification | No fabricated observed digest; issue required |
| checkedAt | For matched/changed, completion of full-byte read/hash comparison; for unavailable, completion of the failed verification attempt |
| Policy/source mutation | Corresponding partial reason and issue; exhausted source retry skips file |

Schemas enforce structural combinations; runtime conformance checks enforce counts, equality, provenance, and issue correspondence.

### 8.2 Expansion and capability discovery

`jev_read` takes the same version/requestId/workspaceId/scopePolicyId/narrow envelope as search, plus scoped relative path, expected fileSha256, byte range, and byte budget. Its operation discriminant is read-verified; a separate read-fresh variant omits the expected digest and always returns a newly identified revision. Both enforce the same effective scope and containment checks before opening files. It returns verified bytes with coordinates or REVISION_MISMATCH/UNAVAILABLE; reading the new revision requires an explicit fresh-read request. Indexed evidence is returned with its search result; v1 does not promise old generation IDs remain resolvable after collection. Consumers must retain citation bytes and hash from the result. No bearer-style evidence ID grants filesystem access.

Capabilities report supported protocol versions, operation modes, caps, regex dialect, index readiness, active configuration, and local/remote provider policy. Index status reports last publication, scan interval, incomplete coverage, update failure, and cleanup bytes. Absolute roots stay in local registration/configuration, not arbitrary search requests.

### 8.3 Compatibility and conformance

Transport, SQLite schema, and index manifest versions are independent. Unknown request versions fail UNSUPPORTED_VERSION and list supported versions. A server advertises versions rather than assuming negotiation succeeded. Within v1, additive optional response fields are permitted; changes to required fields, semantics, or discriminants require a new protocol version. Clients may ignore documented additive fields but MUST reject unknown discriminants as unsupported guarantees.

Unknown future storage versions are opened read-only for diagnostics or rejected, never modified. v1 performs no automatic storage migration: an explicit migration/rebuild operation with recorded authorization is required, preserving the original until successful validation. Index opening validates format and all active retrieval compatibility fingerprints; incompatible embeddings cannot be reused by dimension coincidence alone.

Conformance fixtures MUST test valid round trips plus rejection of root escapes (including symlink races), invalid ranges/UTF-8 boundaries, wrong excerpts/hashes, complete-with-failure, failed-provider-as-empty-success, mixed generations, mismatched configurations, false live verification, invalid limit/truncation states, unknown versions/discriminants, and accidental remote provider invocation under local-only policy. Malformed source content is test data, not instructions.

## 9. Retrieval acceptance specification

### 9.1 Workload and performance envelope

Initial performance envelope: <=10,000 eligible files, <=50 MiB eligible UTF-8 text, <=250,000 lines, on a declared reference machine with 8 CPU cores, 32 GiB RAM, NVMe, CPU-only retrieval. The benchmark manifest MUST name exact CPU/OS/filesystem/tool versions, power settings, warm/cold methodology, and dataset sizes. Other languages/larger roots may work but inherit no unmeasured performance claim. Primary tasks are exact symbol/config lookup, natural-language implementation discovery, and two-file behavior tracing.

Proposed gates (not measured): warm literal p95 <=500 ms; lexical discovery <=750 ms; promoted CPU hybrid <=2 s; promoted reranked discovery <=3 s; daemon resident memory <=4 GiB. Full request-to-response includes embedding, reranking, result encoding, and requested live verification. Cold startup/first query are reported separately. Initial lexical indexing target <=60 s; one-file lexical-update publication p95 <=2 s on an idle service within this envelope. Semantic update lag is separately measured. Indexing peak memory, total stored bytes, and time MUST be reported. At least 200 representative requests per configuration; timeouts count as failures and are not omitted from timing reports. Shared/exclusive-lock waiting counts toward response latency.

### 9.2 Correctness and evidence quality

Release exact search must match 100% of an independently authored expected-match corpus under declared semantics. Fixtures cover ignores, case, UTF-8 byte offsets, CRLF, zero-width/multiple matches, unsupported multiline behavior, edits/renames/deletes, and every limit. No out-of-scope hits, accepted hash/range mismatches, or hidden partial results are permitted in this suite. This finite test guarantee is not a proof of zero possible bugs.

Ranked retrieval target: complete required-evidence coverage for >=85% of answerable held-out queries within both top 10 results and an 8,000-token returned-context budget. Tokenizer is pinned in the manifest; primary excerpts and expanded context both count. Coverage requires all annotated necessary evidence, not one relevant file. Scores cannot trade away correctness gates. On the unanswerable agent-task slice, independently adjudicate whether the frozen evidence consumer makes unsupported substantive answers: the finite acceptance-set target is <=5% of attempts, with family-clustered 95% intervals reported. Explicit insufficient-evidence responses are valid even if they include bounded contextual citations. This evaluates the composed agent workflow, not a generated-answer feature inside Jev-Grep; it is not a production failure-rate guarantee.

### 9.3 Held-out method

Use 30 disjoint repository families: 10 development, 20 sealed acceptance. Acceptance includes 20 queries and 5 externally checkable agent tasks per family (400 queries/100 tasks). At least 20% of queries are unanswerable within scope, and at least 20% use controlled file-change scenarios. At least 20% of agent tasks are also unanswerable within scope. These classes may overlap. Queries and evidence labels are authored without viewing candidate output, with two reviewers and adjudication. Required-evidence sets allow documented alternative sufficient sources; evaluation must not require a single arbitrary gold snippet.

Pin source snapshots, queries, language models/providers/versions/prompts, tools, budgets, hardware, and tokenizer. Freeze the evidence-consumer agent prompt and query-routing/call-budget harness across compared configurations; specify exactly how the ripgrep-plus-context baseline formulates queries and expands context. Include a no-retrieval control to expose prior model knowledge. Run agent tasks with three paired seeds per configuration where supported; otherwise three paired controlled repetitions, documenting nondeterminism. Compare identical tasks/snapshots with equal tool/context/time budgets and externally checked success criteria. Report repository-family-clustered bootstrap 95% intervals, raw task outcomes, per-class failures, and uncertainty. Acceptance data exposed during tuning becomes development data; new claims require a fresh sealed set. Choose candidates and promotion route on development data before a confirmatory acceptance run; exploratory comparisons cannot masquerade as preregistered confirmation.

### 9.4 Promotion gates

Compare ripgrep plus bounded context, identifier-aware lexical, hybrid, and reranking with one component changed at a time. Live exact is independently releasable; ranked discovery must meet its own coverage target before promotion.

An added retrieval feature MUST pass correctness/resource budgets and either:

A. Improve absolute agent task success by >=5 percentage points with the paired 95% interval wholly above zero; OR

B. Reduce retrieved-context tokens per attempted task by >=20%, including failures, while the success-difference lower 95% bound is above -2 percentage points.

Both routes also require no increase in the unsupported-answer point rate versus baseline on the unanswerable task slice and retain >=85% required-evidence coverage and no >2-point point-estimate regression in any preregistered query class. Per-class uncertainty is reported and low-powered results do not establish equivalence. Hard-failure classes such as scope violations, corrupted evidence, and hidden incomplete execution have zero tolerance in the acceptance suite. An inconclusive result keeps the simpler default; it does not justify silently relaxing the gate. Index/storage/update costs must fit the declared budgets too. Feature experimentation never triggers unapproved index creation.

### 9.5 Agent recovery contract

| Condition | Required guidance |
|---|---|
| INDEX_MISSING | Use exact; request explicit indexing if discovery is needed |
| INDEX_INCOMPATIBLE | Use exact; request authorized rebuild/migration |
| INDEX_BUSY / index unavailable | Use exact or retry once within original deadline |
| Historical/unverified evidence | Verify via bounded read before claiming current behavior |
| REVISION_MISMATCH | Discard current-file claim; retrieve fresh evidence; at most one automatic retry |
| Partial/truncated exact or discovery | Narrow scope or rerun with supported limits; never infer absence; no v1 cursor |
| Optional vector/reranker failure | Explicit degraded lexical results; no concealed failure |
| Zero ranked hits | Insufficient evidence; optional one anchor-based exact follow-up |
| Unsupported language relationships | Capability unavailable; no compiler-resolution claim |

Automatic fallback makes at most one follow-up request per initial request and consumes the original total deadline/context budget. Exact empty results may support only the bounded observation 'no matches observed in the declared scope during this read interval'; v1 never claims an atomic live-filesystem absence proof. No automatic endless query reformulation or index creation.


## 10. Feasibility spikes before implementation lock-in

A small implementation spike MUST demonstrate safe root-confined reads and single-revision exact matching within the chosen runtime. A per-file subprocess proof of correctness is permitted as a prototype, but must not be assumed to meet the 500 ms target across 10,000 files. Compare batched or persistent matcher designs using the same pinned matching semantics. A narrowly scoped native filesystem/matcher helper is justified if required for containment or measured performance; this does not require moving orchestration out of TypeScript. Failure to meet a budget is a reported failed gate, not permission to weaken evidence semantics.

The first development corpus may be small; only the frozen acceptance corpus supports release claims. Exact/lexical features remain independently useful if semantic promotion fails. Numeric thresholds may change only through a versioned pre-experiment decision record, never retroactively to pass a failed acceptance run.
