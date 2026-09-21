# Scoped exact-search core

Status: implemented development core, 2026-09-21. This extends the private worker with an in-process public request/response boundary. It is not a packaged release or transport-parity claim.

## Authority and lifetime

`WorkspaceRegistry.register` is an administrative call accepting an absolute root and policy. It resolves a canonical path, observes device/inode identity, and starts a confined worker. The worker must report the same identity before registration succeeds. Registration validates glob syntax without scanning sources or creating an index. At most 32 registrations, including those in progress, can exist per registry. Each owns one serial worker; concurrent searches fail explicitly rather than queue without a budget. Revocation/close kills the worker. A parent-owned directory descriptor remains open for the registration lifetime, preventing inode reuse after worker death. Root identity remains pinned across restarts.

Search and reads accept workspace/policy IDs. They cannot override root, hidden/ignore behavior, file-size limits or symlink policy. Policies and their pattern arrays are copied and frozen. Changing policy requires a new registration; old IDs do not silently acquire new authority.

## Scope semantics

Patterns use pinned globset 0.4.20, case-sensitive and relative to the root. `*` does not cross `/`; `**` can. Include arrays are OR groups; an empty group imposes no restriction. Registered includes and request includes are separate AND groups. Exclusions are unioned and always win. A pattern matching a directory excludes its subtree; positive include patterns select files without pruning potential ancestor directories. Negation, absolute paths, traversal components and backslashes are rejected in explicit include/exclude arrays. Use the exclude array rather than `!` syntax. Malformed globs fail before source enumeration.

`.gitignore` and `.ignore` are read from traversed directories within the registered root. `.ignore` takes precedence across depths; within one kind, deeper rules override ancestors and the last matching line wins. Negation cannot resurrect a pruned parent. Rules use pinned ignore 0.4.33. Ancestor/global Git configuration, `.git/info/exclude`, `.rgignore` and external ignore files are deliberately not consulted. This workspace-only dialect is part of policy identity; it is not a promise of all ripgrep defaults.

Hidden files are excluded by default. `.git` and `.jev-grep` directories are always excluded, including when hidden files are enabled. Symlinks, special objects, binary/invalid-UTF-8 content and oversized source files remain ineligible. Root handles and captures retain the native confinement rules.

Each operation captures exact ignore bytes plus absence observations, bounded to 64 KiB per file, 1 MiB total, 4,096 lines and 4,096 observations. Invalid, symlinked or unreadable policy fails closed; a directory is not searched with missing rules. Observations are rechecked after traversal. Detected edits/creation/removal produce `POLICY_CHANGED`; inability to recheck produces an explicit partial/error outcome. These checks do not claim an atomic filesystem snapshot.

## Identity and response metadata

Policy SHA-256 uses UTF-8 JSON with a fixed field order: version, glob dialect, ignore dialect, sorted/deduplicated includes and excludes, hidden, respectIgnore, maxFileBytes, symlinks, encoding, fixed excludedDirectories. Effective policy identity hashes `{version:1, policyHash, scope}`, with separate include groups. Ignore snapshot identity uses a versioned domain and sorted paths with byte lengths, explicit absence/presence and captured bytes. All fingerprints are lowercase SHA-256.

Evidence identity hashes `{version:1, workspaceId, policyHash, path, fileSha256, range}`. An exact hit and verified read of that same range/revision share identity; a changed file produces a new identity on fresh read. Identity is never permission to bypass current scope.

Responses include separate include groups (authoritative intersection), effective-policy and ignore-snapshot hashes. The legacy flat `include` field displays request includes if nonempty, otherwise registered includes; it must not be used alone to reconstruct authority. Known searched/failed counts are reported. Excluded/unsupported/oversized file counts remain explicitly unknown because the worker aggregates pruned entries rather than enumerating excluded subtrees. No fabricated descendant-file counts are emitted.

## Exact and read boundary

`ExactService.execute` validates public requests and shared request context, sends scoped work, maps stable errors, constructs evidence identities, and validates the final response. Per-call budgets are clamped to optional lower deployment caps. The deadline includes validation, worker startup/restart and final serialization. Cancellation terminates in-flight native work. Public-envelope byte limits are applied after evidence wrapping; trimming matches marks partial coverage and retains the issue. If mandatory metadata cannot fit, the result is a bounded `BYTE_LIMIT` error.

Source reads traverse only candidate ancestors under the same scope rules and hash the full capture before checking the requested revision. Changed source returns `REVISION_MISMATCH`; fresh reads return current evidence. Out-of-file or split-UTF-8 ranges fail. The current evidence contract limits a read to 4 KiB; larger requested ranges return `BYTE_LIMIT`, not silently truncated success. Reads never return success after an observed policy/read failure.

Literal matching and the existing declared regex subset retain captured-byte offsets. Whole-buffer anchors, some inline flag changes, lookaround and matches on non-UTF-8 boundaries remain unsupported with explicit errors. No fallback changes dialect. Broader regex compatibility, transport adapters, capability negotiation and packaged installation belong to subsequent work.

## Validation

Hand-authored end-to-end fixtures cover exact → verified read → mismatch → fresh read without an index; expected case/UTF-8/CRLF/zero-width occurrences; scoped reads after ignore changes; partial output and exact-limit completion; serialization budgets; unsupported input and cancellation. Registry fixtures cover root replacement before first search, revocation, immutable identity, narrowing, ignore precedence/negation, malformed and oversized policy, hidden/symlink/self-index exclusions. Native tests deterministically detect policy edits, creation and removal, alongside source-race and special-object tests. Existing differential tests compare the declared regex cases against ripgrep 15.2.0.

The previous 139 ms synthetic benchmark predates policy evaluation and this service wrapper. It must not be advertised as performance of this increment. No new performance or agent-quality score is claimed.
