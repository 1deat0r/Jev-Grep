# Implementation progress

Date: 2026-09-21. First implementation increment.

The reviewed [plan](IMPLEMENTATION_PLAN.md) remains a historical approved baseline; this document tracks execution. Scores in the review records do not score this implementation.

## Implemented and locally checked

- Exact runtime/compiler/schema dependency pins, npm lockfile, strict TypeScript build, Node test runner, generated declarations, and a Linux CI workflow with pinned action commits. The foundation passed hosted CI.
- Structural schemas for exact/discovery/read requests and responses, evidence, issues, scope, verification, administrative requests, and initial capabilities.
- Runtime request/response semantic validation and full captured-source evidence verification.
- Hand-authored conformance cases, deterministic generated JSON Schemas, and schema-drift checking.
- Linux confined-read prototype and adversarial fixture tests using disposable temporary data.
- Captured-byte matcher measurements at 1,000 and 10,000 synthetic files, with environment/limitations retained in reports.
- Persistent Linux native worker with confined capture, SHA-256, matcher, framed typed IPC, restart identity checks, cancellation/deadline enforcement, and integration tests.
- Initial upstream source screening and a decision register with unresolved choices.

## Milestone status

| Work | Status | Remaining gate |
|---|---|---|
| T00.1 toolchain | Core bootstrap done | SQLite/MCP dependency selection before those adapters; hosted CI execution |
| T00.2 upstream reuse | Initial screen done | Any reused subsystem needs full qualification before adoption |
| T00.3 confinement | Prototype passes locally | Production helper, handle lifecycle, supported-platform checks and integration |
| T00.4 matcher | Two approaches measured | Persistent/batched production adapter; full request latency gate |
| T00.5 evaluation manifest | Synthetic environment/results recorded | Full workload manifest, repository families, labels, evaluator setup |
| T00.6 decision register | Created | Maintain as evidence closes decisions |
| M1 contracts | Core schema and validation slice implemented | Remaining boundaries listed in CONTRACTS.md; conformance expansion |
| M2–M7 | Not started as product milestones | Follow the plan's dependency and acceptance gates |

## Next bounded work

Finish M1 request-context, administration/status, identity, and error-mapping contracts. Promote the persistent worker prototype only after adding ignore/glob policy, public error mapping, and broader regex compatibility fixtures. Then connect a single safe exact-search path before adding the three transport adapters.

No production search CLI/daemon, index, model provider, or release candidate exists yet. No implementation quality or performance score is claimed. The current test/spike results validate only the implemented slice and prototype assumptions.
