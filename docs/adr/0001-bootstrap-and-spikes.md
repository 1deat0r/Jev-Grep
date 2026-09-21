# ADR 0001: Bootstrap contracts and measure filesystem/matcher risks

Status: accepted for the first implementation increment; production matcher and filesystem adapter remain open.

## Contract/toolchain choice

Use the locally available Node 26.8.1 runtime and exact npm dependency pins. Zod 4.6.5 supplies structural schemas, inferred TypeScript types, and JSON Schema generation. Keep byte budgets, cross-field relationships, source hashes, and scope enforcement outside structural schema conversion. The built-in Node test runner avoids another test-runtime dependency. Compiler settings match the reviewed strictness requirements.

The local package proxy required Node's system CA support for downloading tarballs. This was configured only for the install invocation; TLS verification was not disabled, no proxy credentials were written into project files, and package-lock.json retains canonical registry URLs/integrity values.

## Upstream screening

Inspected zvec-grep at commit [`a2feef0ddb1b87e9e802aa4a5a7942b7fc80df6c`](https://github.com/zvec-ai/zvec-grep/tree/a2feef0ddb1b87e9e802aa4a5a7942b7fc80df6c). Its package manifest declares Apache-2.0, Node >=22, zvec/model/parser dependencies, and separate MCP 2.0 packages. Its RootRuntime contains model leases and read-generation caching. Its benchmark documents describe controlled comparisons with pinned inputs, including a 20-task software-engineering subset. Sources: [package](https://github.com/zvec-ai/zvec-grep/blob/a2feef0ddb1b87e9e802aa4a5a7942b7fc80df6c/package.json), [runtime](https://github.com/zvec-ai/zvec-grep/blob/a2feef0ddb1b87e9e802aa4a5a7942b7fc80df6c/src/daemon/root-runtime.ts), [benchmarks](https://github.com/zvec-ai/zvec-grep/blob/a2feef0ddb1b87e9e802aa4a5a7942b7fc80df6c/benchmarks/README.md).

Decision: implement Jev-Grep's small contract core independently first, and keep upstream as a comparison/reuse candidate. This avoids bringing model/storage dependencies into the exact-only foundation. No upstream code was copied. This was an initial source/license/architecture screen, not a completed crash-recovery or compatibility audit; no assertion is made that upstream meets or fails Jev-Grep's durability contract. Such adoption still requires T00.2's deeper qualification.

## Confined capture prototype

The Python prototype opens a path relative to a pinned root using Linux openat2 resolution restrictions and an O_PATH handle. It rejects special objects before opening a readable stream, reopens the pinned regular object through trusted /proc, checks identity/type, bounds captured bytes, and observes mutation metadata. Tests cover traversal, symlinks, root replacement, FIFO/socket/device rejection, source substitution, growth, cancellation/deadline checks, and concurrent parent-directory swapping.

The available Linux headers were checked for syscall/resolve constants. This mechanism passed the local fixture suite. Production still needs a narrow validated helper protocol, resource ownership, enumeration/ignore integration, and cancellation isolation. Userspace checks alone cannot guarantee a deadline across blocked kernel I/O; a worker boundary is needed to keep the service responsive. These tests do not prove behavior on every filesystem/kernel or under privileged mount manipulation.

## Matcher comparison

The synthetic benchmark uses 2-line ~5 KiB files, bounded to 10,000 files and approximately 50 MB of source bytes, within the specification's file/text/line envelope. Compare hashing plus one ripgrep process per captured buffer with hashing/staging captured buffers in disposable files and invoking one ripgrep process. Config files are disabled and the default engine is explicit. The actual matcher binary is version checked.

Reports are [1,000 files](../../spikes/results/matcher-1000.json) and [10,000 files](../../spikes/results/matcher-10000.json). Both are single-run development measurements; they exclude real workspace enumeration/capture and do not establish p95 product latency. The production adapter remains undecided. Per-file process startup is unsuitable for the target; a persistent/batched native matcher is the next experiment. Staged copies are a useful comparison, not an adopted disk-copy search design.

No index was created, no user workspace contents were sent to a model, and no sealed evaluation was run.
