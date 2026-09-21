# Decision register

Date: 2026-09-21. This register tracks implementation decisions without altering the reviewed specification or treating spikes as release acceptance.

| ID | Owner task | Decision / evidence | State | Freeze point / dependents |
|---|---|---|---|---|
| D001 | T00.1 | Node 26.8.1, npm 11.19.0, TypeScript 7.0.2, Zod 4.6.5, @types/node 26.6.2; exact lockfile, installed API declarations, passing build | Selected for bootstrap | M0; contracts and tests |
| D002 | T00.1 | Node built-in test runner; compile before testing; native JSON Schema generation | Selected | M0; conformance/CI |
| D003 | T00.1 | SQLite binding and MCP runtime package | Open; not installed prematurely | Before storage/MCP code; API inspection required |
| D004 | T00.2 | Independent contract core; no upstream code copied; upstream reuse screening in 0001 | Selected for this increment; deeper reuse audit deferred | Before adopting an upstream subsystem |
| D005 | T00.3 | Linux openat2/O_PATH regular-file prototype passes adversarial fixtures; production helper/lifecycle still required | Feasible prototype, not frozen production adapter | Before M2 workspace capture |
| D006 | T00.4 | Reject process-per-file as the intended production architecture; staged copies show batching benefit but staging cost remains | Preliminary; persistent/batched helper comparison pending | Before M2 matcher |
| D007 | T01.1–4 | Zod structural schemas plus separate source/cross-field checks; field decisions in CONTRACTS.md | Partial M1 implemented | Before adapter integration |
| D008 | T03.1 | IPC ownership, common deadlines, capability serving | Open | Before M3 integration |
| D009 | T04.1–3 | Generation sink, payload ownership and store activation protocol | Open | Before M4 publication |
| D010 | E01–E03 | Synthetic development feasibility reports only; no sealed corpus or agent-quality claims | Open | Before ranked acceptance |

The current machine has a Ryzen 7 5800X, 16 logical CPUs, Linux 7.0.0-31-generic, and an ext4 project volume. It is not asserted to be the specification's calibrated reference environment. Time-dependent package metadata was checked against the registry; implementation API shapes were checked against the installed locked versions.

No decision authorizes automatic indexing, downloads during retrieval, content telemetry, or egress. Those remain behind the specified explicit administrative boundaries.
