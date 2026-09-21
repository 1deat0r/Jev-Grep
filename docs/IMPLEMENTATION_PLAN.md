# Jev-Grep implementation plan

Date: 2026-09-21. Revision: 1.1. Status: reviewed implementation plan; all implementation tasks are pending.

Source of truth: [SPEC.md](SPEC.md), revision 1.0. Design review: [REVIEW.md](REVIEW.md). Implementation-plan review: [IMPLEMENTATION_PLAN_REVIEW.md](IMPLEMENTATION_PLAN_REVIEW.md).

This plan turns the specification into buildable increments. It does not implement the system, create a workspace search index, choose an embedding model, or claim any acceptance gate has passed. The specification takes precedence if this plan and the specification disagree. Contract elaborations must be recorded before implementation; material behavioral changes require a specification revision.

## 1. Delivery strategy

Deliver three progressively stronger outcomes:

1. **Exact-search release:** confined live literal/regex search, verifiable evidence, bounded source reads, and matching CLI/SDK/MCP behavior. No index dependency.
2. **Lexical v1 release:** explicit incremental indexing, recoverable SQLite generations, identifier-aware ranked retrieval, and the required quality/operational acceptance evidence.
3. **Optional retrieval extensions:** vectors, reranking, and language intelligence only after separate compatibility and promotion gates. These do not block the first two outcomes.

Use a TypeScript application with internal module boundaries first. Extract published packages or native components only where needed. Do not start by creating multiple services, a distributed index, a graph database, or an answer-generation subsystem.

No calendar estimate is attached before the containment/matcher spikes and corpus effort are measured. Milestone completion is determined by evidence, not elapsed time or reviewer scores.

## 2. Planned repository layout

These are planned paths, not existing implementation files.

```text
src/
  contracts/       # Schema authority, generated types/JSON Schema, invariants
  workspace/       # Registry, scope policies, enumeration, confined reads
  evidence/        # Hashes, byte coordinates, excerpts, verification
  exact/           # Matcher adapter, occurrence decoding, bounded results
  service/         # Local service ownership, dispatch, cancellation, scheduler
  index/           # SQLite catalog, generations, authorization, recovery, GC
  lexical/         # Identifier tokenization, chunks, FTS queries, ranking
  adapters/        # CLI, SDK, MCP, local IPC
  providers/       # Default-deny egress gateway; later optional retrieval adapters
tests/
  conformance/     # Contract fixtures and cross-field invariants
  filesystem/     # Race, containment, encoding, scope, and mutation fixtures
  integration/    # Transports, process ownership, cancellation, upgrades
  faults/         # Lifecycle fault points, ENOSPC, interrupted collection
benchmarks/
  manifests/      # Versioned workload, environment, protocol, candidate config
  development/    # Visible development corpus and labels
  harness/        # Search and agent evaluation, raw results, statistics
  results/        # Referenced reports; large artifacts stored separately
spikes/           # Disposable prototypes and measured findings
native/           # Created only if a narrow helper is justified
docs/adr/         # Dependency, matcher, storage, protocol, and promotion decisions
```

Acceptance queries, tasks, and labels must remain inaccessible to candidate tuning. The repository may contain an opaque corpus manifest and digests, but not the sealed material. Corpus acquisition must record redistribution rights and immutable source revisions.

Dependency direction: adapters → service → retrieval/index/workspace/evidence → contracts. Contracts must not import transports, database drivers, or provider implementations. Native helpers are private adapters with validated request/response framing.

## 3. Milestones and dependencies

| Milestone | Depends on | Deliverable | Exit evidence |
|---|---|---|---|
| M0: Decisions and feasibility | None | Build harness, upstream assessment, confinement/matcher prototypes | Measured findings and architecture decision records |
| M1: Executable contracts | M0 toolchain decision | Versioned schemas, invariants, fixtures, capabilities | Contract suite and deterministic schema generation |
| M2: Safe exact-search core | M1 + passing M0 containment/matcher decisions | Captured-byte search, scoped reads, evidence verification | Independent expected-match and race suites |
| M3: Exact-search product | M2 | Local service, CLI, SDK, MCP, cancellation and budgets | Transport parity, process tests, exact performance report |
| M4: SQLite lifecycle | M1 + M3 service boundary | Authorized administration, fixture-backed storage sink, publication, recovery, reclamation | Lifecycle fault matrix with deterministic fixture payloads |
| M5: Lexical discovery | M4 | Production lexical producer, ranking, refresh, verification | Discovery conformance, production-payload fault rerun, development quality report |
| M6: Release acceptance | M3 plus exact gate artifacts, or M5 plus lexical gate artifacts; see applicability matrix | Reproducible release candidate and reports | Applicable correctness, performance, quality, and recovery gates |
| M7: Optional extensions | Passing baseline + experiment-specific prerequisites | One isolated improvement at a time | Preregistered promotion and adapter conformance results |

The evaluation track starts in M0 and continues alongside implementation. It is not postponed until M6. Work that can proceed independently includes corpus preparation, protocol fixtures after M1 freeze, and lifecycle fault-harness preparation before M4 is complete. Integration still follows the dependency table.

## 4. M0 — Resolve implementation risks first

**T00.1 — Bootstrap a minimal build and verification harness.** Pin the supported runtime, package manager, TypeScript compiler, schema library, SQLite binding, MCP SDK, test runner, and ripgrep version after verifying their actual APIs and runtime compatibility. Enable the specification's strict compiler flags. Add a lockfile, reproducible development setup, and Linux CI. Use one schema authority that can produce both runtime validation and JSON Schema; document any refinements that need separate semantic checks.

**T00.2 — Assess upstream reuse.** Inspect the pinned upstream revision for license, provenance, supported runtime, index format, recovery, local-only operation, and reproducible benchmark methodology. Decide whether to reuse components, wrap a library, or maintain an independent orchestration layer. Record rejected options and concrete reasons in an ADR; repository popularity is not sufficient evidence.

**T00.3 — Prove root-confined reads.** Prototype descriptor-based root access under adversarial parent-directory/symlink replacement, deleted roots, permission failures, and file replacement during reads. Define the supported Linux kernel/filesystem assumptions and reject unsupported environments explicitly. If the selected runtime cannot provide the guarantee, test a narrow native broker. The prototype must read bytes and hash the same capture it returns.

**T00.4 — Prove exact matching over captured bytes.** Compare the simplest correctness prototype with batched/persistent alternatives using the pinned regex semantics. Include up to 10,000 small files, 50 MiB text, Unicode, zero-width/multiple matches, and large match counts. Measure enumeration, capture/hash, matching, process overhead, encoding, and total response time. A per-file subprocess implementation is not assumed fast enough. Avoid a second live-path read to manufacture evidence after matching.

**T00.5 — Start the benchmark manifest.** Record reference-machine details, performance envelope, corpus acquisition rules, baseline routing, result budgets, and development/acceptance split. Prepare a small development corpus for iteration and schedule the full independently labeled acceptance corpus.

**T00.6 — Maintain the decision register.** Record decision ID, owning task, required evidence, freeze milestone, status, and affected dependents. At minimum cover toolchain/upstream strategy (T00.1–2, M0), confinement/matcher mechanism (T00.3–4, before M2), schema/administration compatibility and refresh metadata (T01.2–4, M1), IPC ownership (T03.1, before M3 integration), generation-input/cleanup model (T04.1–3, before M4 publication), and evaluation access/preregistration (E01–E03, before sealed execution). A dependent task cannot silently assume an unresolved decision; record a justified provisional boundary or close the decision first.

**Exit:** ADRs identify the actual toolchain, upstream strategy, confinement mechanism, and matcher approach with measured limitations. No unsafe containment fallback is allowed. An unachieved performance target stays an open gate; any target revision follows the specification's pre-experiment change rule.

## 5. M1 — Make the public contract executable

**T01.1 — Implement the schema authority.** Encode search requests/responses, evidence, issues, exact/discovery results, scope, limits, timestamps, digests, and verification variants. Generate public types and JSON Schema reproducibly. Reject unknown request fields, invalid bounds, and unsupported versions.

**T01.2 — Complete the named but abbreviated contracts.** Define exact-match provenance, ranked-hit provenance, effective-scope count meanings, stable error/stage codes, capabilities, status, verified/fresh read variants, and their success/error envelopes. Define explicit registration and index create/refresh/rebuild/migrate commands, including recorded refresh authorization. Define where deadline/byte-budget overrides enter the shared request context; they cannot be adapter-specific or reset on fallback. Specify CLI exit codes and the mapping between domain errors and MCP tool results. Resolve SPEC §5.2 failed-refresh visibility in the executable discovery contract: include the pinned generation publication time and observation time, derive nonnegative generationAgeMs with a documented clock-skew flag, and carry lastUpdateOutcome as never-attempted, succeeded, or failed with attempt ID, completedAt, and a bounded stable issue. Capture the latest completed update outcome when the request pins its generation; expose a running update separately rather than erase a completed failure. Age is time since publication, not proof of freshness. CLI/SDK/MCP must preserve a failed-refresh outcome even when queries against the previous generation succeed; add the corresponding parity fixtures.

**T01.3 — Encode semantic invariants.** Add checks for range/excerpt equality, hash equality/inequality, contiguous ranks, count limits, truncation, generation identity, partial-reason/issue correspondence, operation matching, and verification state. Reserve room for mandatory metadata/issues when applying serialized-byte limits; bound issue details without hiding failure counts or reasons. Full results must remain valid protocol messages even when their content budget is exhausted.

**T01.4 — Define compatibility and identity.** Specify canonical policy/config serialization and fingerprints, evidence identity inputs, protocol/storage/manifest versions, capability negotiation, and rejection of unknown discriminants. No automatic storage migration. Keep complete original source bytes available where full-file hashing is promised.

**T01.5 — Build independent fixtures.** Hand-author expected valid/invalid cases and cross-field counterexamples; do not derive every expected result from the implementation under test. Include scope escape, inconsistent verification, false completeness, invalid UTF-8 boundaries, provider failure presented as empty success, and unknown format cases.

**Exit:** Generated contracts reproduce without drift; schema and semantic fixtures pass; adapter implementers have one authoritative contract. Any discovered ambiguity is resolved in an ADR or specification amendment before dependent work starts.

## 6. M2 — Implement safe live search and source reads

**T02.1 — Workspace registry and policy.** Bind workspace IDs to canonical roots and safe root handles. Implement immutable scope policies, narrowing by intersection, ignore/hidden behavior, no symlink following, size/encoding exclusions, and self-index exclusion. Capture policy digests and report meaningful coverage counts. Only regular files are eligible: reject FIFOs, devices, sockets, and other special objects without opening an unbounded/blocking content stream. The confinement spike must establish a safe object-type inspection and readable-handle acquisition protocol; revalidate identity/type on the actual descriptor so substitution after enumeration cannot bypass the rule. Report exclusions separately from a detected mutation/read failure according to the frozen scope contract.

**T02.2 — Captured source and evidence.** Read eligible files through the M0-approved mechanism, preserve exact bytes and CRLF, compute SHA-256, and produce byte ranges plus derived display lines. Detect observable source/policy changes; retry a changed source at most once within budget, then skip with an explicit partial/failure outcome. Bound actual bytes captured even when a regular file grows after its initial size check; stop at the effective size limit plus a bounded detection allowance and report the agreed oversized/mutated outcome. Check deadlines/cancellation during capture and test growing files, FIFOs/devices/sockets, and regular-to-special substitution. These fixtures must establish bounded completion and no unintended special-file reads. Never claim an atomic workspace snapshot.

**T02.3 — Exact adapter.** Support literal and line-oriented regex with explicit case sensitivity. Preserve separate occurrences and zero-width progress semantics. Bound input/output buffering; treat matcher errors as errors. Pass argv without a shell where subprocesses are used. Reject unsupported regex/multiline behavior without silent dialect switching.

**T02.4 — Budget-aware result assembly.** Enforce hit, snippet, serialized-response, file-size, and time caps. Returning exactly the maximum does not establish completeness. Distinguish observed extra matches, early stopping, failed reads, cancellation, and deadline expiry. Preserve partial status in all output forms.

**T02.5 — Verified and fresh reads.** Apply the same scope envelope to source expansion. Hash the full captured file before claiming a matched revision; return REVISION_MISMATCH for changed source. Fresh reads return new evidence identity. Never use an evidence ID as permission to bypass scope checks.

**Exit:** 100% agreement with the declared expected-match fixture corpus; no accepted scope/hash/range violations in the suite; deliberate filesystem races produce the specified outcomes. Demonstrate search and source expansion with no index present and no implicit index creation.

## 7. M3 — Expose a usable exact-search release

**T03.1 — One local service boundary.** Implement one owner per canonical workspace, a versioned local IPC protocol, and shared dispatch for CLI/SDK/MCP. Prefer a user-private Unix-domain endpoint on supported Linux; finalize socket discovery, ownership checks, permissions, and stale-endpoint recovery in the transport ADR. Keep protocol framing, input size, and buffered requests bounded. A second service must not become another index writer.

**T03.2 — Thin adapters.** CLI supports human and JSON views; SDK returns validated domain results; MCP advertises generated input/output schemas and structured results. Expose exact search, scoped reads, capabilities, and unavailable-index status. Unsupported discovery reports capability/index state accurately.

**T03.3 — Deadline and cancellation propagation.** One request context owns the original deadline, output budget, cancellation signal, and fallback allowance. Propagate cancellation through queues, matcher workers, and reads. Clean up on client disconnect. Explicit cancellation must not trigger an automatic retry.

**T03.4 — Operational defaults and egress gateway.** Implement one default-deny gateway in providers/ owning per-workspace allowlisted provider identities, allowed content classes, and cumulative byte budgets. Every future embedding/reranking/fallback adapter must use it; direct content-bearing network paths are prohibited. Keep content-bearing logs/telemetry disabled. Add adversarial fixtures for disallowed providers, content classes, exhausted budgets, fallback/provider-switch bypass, and query/path/snippet leakage in logs and errors. Search must not silently download model artifacts: missing local assets return a typed unavailable/degraded result. Administrative model acquisition is a separate explicit operation with recorded artifact identity, destination, and authorization, never a hidden retrieval side effect. Test offline retrieval and zero retrieval-time network requests. Document installation, registration, exact search, partial results, and revision mismatches.

**Exit:** CLI/SDK/MCP semantic parity on common fixtures; service ownership and cancellation process tests; no-index exact search remains functional. Run the applicable M6 exact-release checks before labeling this independently releasable.

## 8. M4 — Implement storage correctness before ranked search

**T04.1 — Catalog and authorization.** Model workspace/configuration, refresh authorization, generations, captured source revisions, chunks, file outcomes, the published pointer, and cleanup state. Add foreign keys/uniqueness constraints that enforce ownership and one authoritative publication. Initialize and read back required SQLite durability/reclamation settings. Registration/search alone must never create an index.

**T04.2 — Scheduler and process locks.** Integrate OS-managed shared/exclusive locking with the daemon's bounded FIFO admission queue. Later indexed readers cannot bypass a queued writer. Remove cancelled/expired queue entries. Live exact remains independent. Test lock release after process death and distinguish cancellation, contention refusal, and deadline expiry.

**T04.3 — Generation builder and publisher.** Define a versioned GenerationInput/storage-sink interface for source revisions, chunk bytes/ranges, configuration fingerprints, file outcomes, and optional backend records. M4 uses an independently specified deterministic fixture producer through that interface; it does not depend on the M5 production chunker or FTS ranking. The sink owns validation, record ownership, and publication. M5 plugs in the production lexical producer and reruns the fault matrix with real FTS/chunk payloads. Implement staged → validated → published → retired → collected, with recorded file failures separate from required-record corruption. Verify durable required records before transactional publication. Start with a simple ownership model; enable immutable payload sharing only if reference-safe deletion is tested and its benefit measured.

**T04.4 — Recovery and collection.** Recover before serving indexed requests after unclean shutdown. Discard incomplete unpublished generations, resume cleanup idempotently, verify the published generation, and fail explicitly when required records are missing. Preserve old-or-new publication through every transaction boundary. Live exact remains available through index failures.

**T04.5 — Storage budgets and maintenance.** Account for database/WAL/SHM, staging, backend data, and logs. Enforce the specified quota/free-space floor with admission estimates and actual write-error handling. Implement bounded incremental reclamation/checkpoint work, report reusable versus physically reclaimed bytes, and never delete the published generation to make room.

**T04.6 — Fault harness.** Add deterministic fault points around stage writes, validation, pointer commit, and collection. Exercise SIGKILL/process death, restart, missing records, storage exhaustion, repeated cleanup, and many near-quota generations. A mocked ENOSPC test is supplemented by a constrained real-filesystem integration case. Every injected fault is followed by reopening the store in a fresh process. Independent oracles compare the selected old-or-new pointer, required payload IDs, source bytes/digests, file outcomes, and unaffected generation ownership against precomputed expectations. Check observable error/degraded states, absence of mixed publication, and convergent cleanup across repeated restarts; a successful exit code alone is insufficient. Persist fault location, injection seed, candidate/configuration hashes, recovery observations, and apparent/allocated/retained-byte measurements. Process-kill testing does not establish power-loss durability.

**T04.7 — Implement index administration and compatibility transitions.** Own explicit create, authorized refresh, and authorized rebuild through the common service boundary. Record scope/configuration and refresh mode; search/registration never authorize these implicitly. Implement rebuild by staging replacement state and retaining the original publication until validation and the selected atomic activation protocol succeed. Define supported source/target formats in an ADR; unknown formats are never opened for mutation or automatically removed. V1 advertises in-place migration as unavailable unless an explicit format-pair implementation and preservation tests exist; a migration request then returns a typed capability-unavailable result with the supported explicit rebuild guidance. This capability boundary must be visible in the M1 contracts. Test unapproved operations, format/config incompatibility, interrupted rebuild, failed validation/activation, and preservation of the original on failure. A rebuild involving a different store format requires a validated store-switch protocol before that transition is advertised; otherwise report the transition unsupported.

**Exit:** Every applicable SPEC §5.3 fault row has a passing test and artifact; continuous readers do not starve a queued writer; incomplete/failed refresh status is observable. No indexed result can combine generations.

## 9. M5 — Add incremental lexical discovery

**T05.1 — Versioned chunks and tokenization.** Implement the production producer for the M4 GenerationInput/storage-sink boundary and rerun lifecycle faults using actual captured chunks and FTS payloads. Start with bounded text/line chunks and explicit source ranges, preserving full identifiers and useful subtokens. Record chunking/tokenization fingerprints. Add syntax-aware boundaries only if development evaluation justifies them; verified code relationships are outside this milestone.

**T05.2 — SQLite lexical retrieval.** Implement FTS-backed candidate selection constrained to the published generation and effective scope. Use parameterized database access and bounded parsing of search input; do not inject raw user text into an uncontrolled query language. Rank/deduplicate with deterministic tie-breaking and preserve retrieval provenance and distinct source revisions.

**T05.3 — Incremental refresh.** Reconcile content hashes on authorized startup/explicit refresh; treat watchers only as hints. Handle changed/new/deleted/renamed/oversized/unsupported files and failed extraction. Publish new generations explicitly, reuse unchanged work where safe, and report scan intervals and coverage. Do not silently expand policy or replace incompatible models/formats.

**T05.4 — Verification and fallback.** Return pinned indexed evidence with optional full-file live verification. Changed/unavailable hits remain explicitly historical. Propagate the M1-defined last completed update outcome and generation-age observation on every indexed response, not only the status endpoint. A failed-refresh fixture must query the still-intact previous generation and verify identical failure/age semantics across CLI/SDK/MCP. Missing/incompatible/busy/unavailable indexes yield the defined error and next action; no hidden rebuild. A fallback shares the original budget and never becomes an endless query loop.

**T05.5 — Development measurements.** Compare lexical retrieval with the frozen ripgrep-plus-context baseline; measure evidence sufficiency, task success, context use, query latency, initial indexing, one-file update lag, and storage. Tune only on development data. If lexical coverage misses its release target, record the failure and continue development rather than promoting based on architecture review scores.

**Exit:** Discovery contract and incremental-file tests pass; development reports support a frozen candidate for M6. Scope/configuration changes cannot silently reuse incompatible generations.

## 10. Evaluation track and M6 acceptance

**E01 — Freeze the experiment protocol early.** Define baseline query formulation/context expansion, a common routing/call-budget harness, no-retrieval control, pinned evidence-consumer model/prompt, tokenizer, task success checks, and environment manifest. Include verification and queue wait in full-request timing.

**E02 — Build the corpus.** Maintain 10 development and 20 sealed acceptance repository families. Acceptance requires 400 queries and 100 externally checkable agent tasks, with the specification's unanswerable and controlled-change proportions. Obtain two independent label reviews and adjudicate disagreements; record alternative sufficient evidence sets. Corpus access, labeling, reference hardware, and model availability are explicit dependencies of releases that make ranked/agent-quality claims; they do not block the exact-only path in the applicability matrix. If unavailable, report the relevant acceptance gate as unrun rather than substitute an informal benchmark. Assign an evaluator custodian distinct from candidate tuning, with separate access credentials/storage; keep acceptance queries, tasks, labels, and fine-grained results inaccessible to tuners before the frozen run. The custodian records immutable corpus manifests/digests and access events. If the same operator must fill both roles, freeze the candidate before granting evaluation access and treat any subsequent tuning as contamination; do not describe this as an independent held-out run.

**E03 — Implement reproducible runners.** Preserve raw outcomes including failures/timeouts, per-class metrics, three paired seeds/repetitions, family-clustered 95% intervals, and content-token accounting across all attempts. Run at least 200 timing requests per configuration and report cold behavior separately. Before the custodian executes a sealed run, register immutable source/build/configuration hashes, dependency/model/prompt versions, promotion route, gate definitions, and the corpus digest. The evaluator executes that exact candidate without interactive tuning, retains raw artifacts, and releases the specified report after completion. Record every query/task/label/result exposure that may affect tuning; mark an exposed set development-only when required and acquire a replacement sealed set before a new confirmatory claim. A code/config change after evaluation requires a new candidate identity and a documented gate rerun; no report transfers automatically to an untested artifact.

**E04 — Run applicable release gates.**

| Gate | Required acceptance evidence |
|---|---|
| Exact correctness | 100% expected matches under declared semantics; zero accepted scope/hash/range violations in the suite |
| Exact performance | Warm literal p95 ≤500 ms on the declared workload/reference machine |
| Lexical performance | p95 ≤750 ms; initial indexing ≤60 s; idle one-file publication p95 ≤2 s |
| Memory/storage | Daemon RSS ≤4 GiB; specified quota/free-space behavior and physical reclamation tests |
| Ranked evidence quality | ≥85% complete required-evidence coverage within top 10 and 8,000 returned-context tokens |
| Unsupported answers | ≤5% unsupported substantive answers on the unanswerable agent-task slice, with uncertainty reported |
| Reliability | Required lifecycle, cancellation, fairness, recovery, and transport-conformance tests pass |
| Reproducibility | Pinned manifest, raw results, generated schemas, fault reports, and decision records retained |

Release applicability is explicit:

| Artifact/gate | Exact-only release | Lexical v1 | Optional ranked extension |
|---|---|---|---|
| Exact match/confinement/contract fixtures | Required | Required regression gate | Required regression gate |
| Timing, memory, clean install, transport/cancellation | Required for exact path | Required for both paths | Required for baseline plus extension |
| Pinned environment/build dossier and independent exact fixtures | Required | Required | Required |
| Sealed ranked/agent corpus, coverage and unsupported-answer gates | N/A: no ranked/agent-quality claim | Required | Required with fresh uncontaminated comparison |
| Index lifecycle/fairness/physical-reclamation fault matrix | N/A: no persistent index capability | Required with production lexical payloads | Required for baseline and added backend |
| Cross-store vector durability tests | N/A | N/A for SQLite-only lexical | Required when a vector store is added |
| Incremental update/indexing/storage budgets | N/A | Required | Required with added indexing costs |
| Feature promotion versus passing baseline | N/A | Apply SPEC §9.4 when promoting added retrieval | Required for each promoted extension |

M3 produces an exact-search candidate; its M6 exact branch can complete without M4/M5, E02's ranked corpus, or model-provider access. M4 may proceed once the M3 service boundary is verified, without waiting for the exact release dossier. M6's lexical branch requires M5 and E01–E04 in full. This is a branching dependency graph, not a requirement to finish all later milestones before releasing exact search.

Exact-only release does not claim ranked quality and is not blocked by optional retrieval promotion. Lexical v1 must pass its ranked gates. Feature promotion additionally follows SPEC §9.4; a failed or inconclusive experiment retains the simpler baseline. Once acceptance results influence tuning, that set becomes development data and fresh sealed acceptance is required for new claims.

**T06.1 — Package the candidate.** Test installation and first-use behavior on a clean supported Linux environment, including missing native dependencies, absent index, permission errors, incompatible storage, and offline retrieval. Pin shipped dependencies and expose versions/capabilities. Build artifacts and release notes must state the tested support envelope and remaining limits.

**T06.2 — Assemble a release dossier.** Link each gate to its exact candidate revision, command, manifest, and result. Keep failures visible. Publishing is a separate action from preparing the candidate; this plan does not perform a release.

## 11. M7 — Optional extensions, one experiment at a time

**T07.1 — Vector adapter qualification.** Choose one local model/backend only after development evidence identifies lexical misses. Implement fingerprint compatibility, generation isolation, durable publication barriers, idempotent writes/deletes, recovery, and explicit degradation. Test the full cross-store fault matrix before persistent use. Model replacement/rebuild remains an explicit authorized operation. Wire the adapter through the T03.4 gateway and test provider-switch/fallback budget enforcement; provision model artifacts through the separate administrative acquisition path, never on a search request.

**T07.2 — Hybrid promotion.** Freeze the candidate and compare against lexical with the same harness. Require the specification's ≥5-point task-success route with a positive lower confidence bound, or ≥20% context reduction with success non-inferiority. Retain all coverage, unsupported-answer, per-class regression, storage, memory, and ≤2-second hybrid latency gates. Inconclusive means experimental, not default.

**T07.3 — Reranking.** Evaluate separately against the promoted baseline, using the ≤3-second reranked latency budget and the same quality/promotion conditions. Enforce the T03.4 gateway for any remote provider and disclose degraded fallback; reranker failure or provider switching cannot acquire a fresh egress budget or reset the request deadline.

**T07.4 — Language intelligence.** Only after demonstrated task failures justify it, define a separately versioned capability for one compiler-backed language adapter. Specify supported build context and provenance before implementation; syntax-derived edges cannot claim compiler resolution. Graph expansion receives its own budgets and evaluation.

Generated answers, broad document conversion, multi-host operation, and concurrent indexing/search remain separate future proposals.

## 12. Verification workflow and traceability

Planned scripts (created during M0/M1; none exist yet):

| Command | Purpose | When required |
|---|---|---|
| `npm run typecheck` | Strict compile-time checks | Each code change |
| `npm run contracts:check` | Reproducible schema generation and contract drift | Contract/adapter changes |
| `npm run test:conformance` | Structural and semantic contract fixtures | Contract/evidence changes |
| `npm run test:filesystem` | Root confinement, scope, and source races | Workspace/matcher changes |
| `npm run test:integration` | Transport parity, service/process behavior | Service/adapter changes |
| `npm run test:faults` | Publication/recovery/storage failures | Index changes and release candidates |
| `npm run bench:dev` | Visible development experiments | Retrieval/performance changes |
| `npm run bench:acceptance` | Controlled sealed evaluation | Frozen release/promotion candidates |

The command names assume npm as the initial script interface; M0 may choose a different package manager and update this table before use. Routine CI does not expose sealed labels or rerun expensive acceptance on every commit. Broader testing follows changed risks rather than repeating unchanged checks.

| Specification requirement | Owning tasks |
|---|---|
| §§1–2 scope and architecture | T00.1–T00.2, T03.1 |
| §3 scope, exact semantics, completeness | T00.3–T00.4, T02.1–T02.4 |
| §4 evidence, trust, budgets | T01.3, T02.2–T02.5, T03.3–T03.4 |
| §5 index authority, lifecycle, durability, failed-update visibility | T01.2, T04.1–T04.7, T05.3–T05.4 |
| §§6–7 staged release and artifacts | M0–M7, T06.2 |
| §8 contracts, compatibility, reads | T01.1–T01.5, T02.5, T03.2 |
| §9 evaluation and fallback | E01–E04, T05.4–T05.5, T07.2–T07.3 |
| §10 feasibility and gate changes | T00.3–T00.5, ADRs |

## 13. First implementation work packages

The next execution session should start with these bounded deliverables, preserving the milestone dependencies:

1. Bootstrap the pinned toolchain and CI; create the requirement/decision register and planned script entry points.
2. Run upstream, confinement, and captured-byte matcher spikes; save measurements and select adapters.
3. Implement schemas plus hand-authored contract/conformance fixtures, including read/admin operations omitted from the spec pseudocode.
4. Implement the registry, scope policy, captured-file/evidence primitives, and adversarial filesystem tests.
5. Deliver a single end-to-end exact-search path and verified source expansion, then add the three thin transport adapters.

Each work package should produce a reviewable commit-sized sequence with relevant tests and a short evidence summary. Indexing begins only after the exact-search/service foundations are established. This document is the execution backlog; it does not mark any task complete.
