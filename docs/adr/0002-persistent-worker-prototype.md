# Persistent worker prototype

Status: experimental, 2026-09-21. This closes a feasibility question, not a production milestone.

The per-file subprocess spike was too expensive. A persistent Rust process now pins one trusted root and serially executes bounded searches using grep-regex 0.1.14. The Node client uses a private versioned, length-prefixed JSON protocol with runtime validation. Both sides cap frames and request bounds. The parent includes startup and decoding in its deadline and kills an interrupted worker without replaying its request.

The Linux helper resolves entries using openat2 confinement, checks regular-file identity before reading, captures bounded bytes, checks metadata again, and retries a detected mutation at most once. SHA-256, matching and returned excerpts derive from the same capture. This establishes captured-byte evidence, not an atomic filesystem snapshot. Root device/inode identity persists across worker restarts. An unexpected replacement requires explicit new registration.

## Evidence

Local checks: 31 Node tests, 4 Rust tests, 10 Python confinement tests; TypeScript/schema checks and Rust clippy pass. Integration fixtures exercise pinned roots, special objects, byte/match/depth/entry limits, source updates, process crashes, cancellation and stopped-process deadlines. Supported regex cases are compared against ripgrep 15.2.0.

The [recorded run](../../spikes/results/persistent-worker-10000.json) used 10,000 generated files, 51,200,000 bytes and 20,000 lines. After 10 warmups, 200 alternating sparse-positive/negative searches measured p50 130.56 ms, p95 138.87 ms and p99 154.34 ms. First request was 142.07 ms. Every request checked complete coverage and all file bytes read; the process stayed alive throughout. Measurements include enumeration, capture, hashing, matching, IPC and Node response validation. Raw samples and host metadata are retained. This is an uncalibrated synthetic host measurement, not the specification's release acceptance result.

## Remaining limits

- Linux openat2 and mounted /proc are required. No production packaging or platform capability negotiation exists.
- Fixed hidden/binary/invalid-UTF-8/oversize exclusions replace full ignore/glob policy. This worker must not yet back the public exact API.
- Regex support is deliberately narrower than ripgrep: whole-buffer anchors and some inline flags are rejected; unsupported byte-boundary matches fail explicitly. Broader differential testing remains necessary.
- One active request per worker; no pooling, public root registry, stable global ordering, transport adapter or production resource supervisor.
- Frame/request/file/entry limits and process termination provide bounded prototype behavior. This is not a complete adversarial CPU/RSS qualification.
- Current device/inode and metadata checks are not immutable snapshots or protection against privileged hostile filesystem mutation.

Next: implement scope policy and public response mapping, expand differential/adversarial fixtures, then qualify a single exact-search service path before adding other transports.
