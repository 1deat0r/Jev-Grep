# Executable contract increment

Status: implemented structural search/read/administration/capability schemas and core search/read semantic validators. This is not a functioning search service. M1 remains in progress.

`src/contracts/schemas.ts` is the structural authority. TypeScript types are inferred from it and declaration files emitted by the compiler. `npm run contracts:generate` writes deterministic JSON Schema files to `schemas/`; `contracts:check` detects drift. External data starts as unknown.

`parseRequest` validates the search/read shape, byte budgets, relative-path syntax, Unicode, and range ordering. `parseResponse` additionally binds results to requests, verifies count/rank/generation/verification relationships, and rejects hidden failure states. `assertEvidenceSource` requires the complete captured bytes and checks the full-file digest, exact excerpt bytes, source limits, UTF-8 boundaries, and truncation semantics.

JSON Schema alone cannot express all of these guarantees. Each generated file explicitly identifies itself as structural validation only. Neither a structurally valid path nor matching scope IDs prove filesystem authorization; the upcoming workspace boundary must check actual policy and descriptor containment. Neither a matched digest field nor successful schema validation proves a live read happened; the verified-read implementation must establish that observation.

## Decisions made in this increment

- Exact and discovery hits wrap their evidence as `evidence`; the exact evidence range is the match range, avoiding two disagreeing range fields.
- IDs use bounded ASCII identifiers; hashes use 64 lowercase hexadecimal characters. Paths use forward-slash relative components, excluding traversal, backslashes, line breaks, and NUL. They are not normalized into acceptance. Valid Linux filenames outside this initial representable subset must be reported as unsupported by the future enumerator.
- Exact request text cannot contain literal CR/LF/NUL. Backend regex compilation still needs to reject expressions that require unsupported multiline semantics.
- Counts are `{value, reason}`: a known nonnegative count has a null reason; an unknown count has a null value and a bounded reason.
- Indexed responses carry the latest completed update outcome, observation/publication times, nonnegative age, and a clock-skew flag. Age is elapsed publication time, not a freshness guarantee. Failed-refresh metadata can coexist with a successful query against an intact older generation.
- Relative path, byte, time, partial-result, and other source checks are semantic runtime obligations, not inferred from branded names.
- Administrative request declarations do not authorize or execute anything. Migration is advertised unavailable in the initial capability shape. Authorization records, administrative responses, actual capability/status serving, and IPC/CLI/MCP error mappings remain unimplemented.

## Remaining M1 work

Freeze the common request-context override schema and negotiated lower budgets; complete administrative response and index-status schemas; implement canonical policy/configuration/evidence identity encoding; freeze stable transport error mappings and additive-response compatibility behavior. Add conformance cases for those interfaces as they are finalized. These are explicitly pending rather than marked passed by the current contract tests.

Source APIs were checked in the installed Zod 4.6.5 declaration files before use. JSON Schema conversion follows [Zod's documented conversion interface](https://zod.dev/json-schema). Cross-field semantics are implemented separately so JSON Schema generation does not silently erase custom refinements.
