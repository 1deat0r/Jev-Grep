# Jev-Grep

Local-first, typed evidence retrieval for people and AI agents. Implementation has begun; there is no production search CLI, daemon, persistent index, or model provider yet.

The development core now supports registered workspace policies, scoped exact search, and verified/fresh source reads through a typed in-process API. Strict runtime contracts, generated JSON Schemas and adversarial fixtures cover the implemented path.

## Development

Use Linux with mounted `/proc`, `openat2`, Rust **1.98.1**, ripgrep **15.2.0**, Node **26.8.1** and npm **11.19.0** (pinned in `.node-version` and `package.json`).

```sh
npm ci --ignore-scripts
npm run check
```

`check` typechecks, builds the native worker, runs Rust and Node tests, and verifies generated-schema consistency. To deliberately regenerate schemas after changing the authority:

```sh
npm run contracts:generate
```

No persistent search index is created by these commands.

## Feasibility prototypes

On Linux x86_64/aarch64 with Python 3, `openat2`, and mounted `/proc`:

```sh
npm run spike:confinement
```

The matcher comparison additionally requires **ripgrep 15.2.0**:

```sh
npm run spike:matcher -- 1000
```

Both prototypes use disposable generated fixtures. They save local results under `spikes/results/`; they are not release acceptance tests. The matcher comparison excludes real workspace enumeration and source capture, and its results must not be presented as end-to-end product latency.

## In-process search and source reads

After building, import `WorkspaceRegistry` and `ExactService` from `dist/src/index.js`:

```js
import { WorkspaceRegistry, ExactService } from './dist/src/index.js';

const registry = new WorkspaceRegistry();
try {
  const workspace = await registry.register('/absolute/project', {
    include: ['src/**'], exclude: ['**/*.generated.ts'],
  });
  const service = new ExactService(registry);
  const result = await service.execute({
    version: 1, requestId: 'example', operation: 'exact',
    workspaceId: workspace.workspaceId, scopePolicyId: workspace.scopePolicyId,
    query: { kind: 'literal', text: 'TODO', caseSensitive: true }, maxMatches: 100,
  });
  console.log(result);
} finally {
  registry.close();
}
```

`read-verified` accepts the same workspace/policy IDs, a result path/range, `expectedFileSha256` and `byteBudget`. `read-fresh` omits the expected digest. Both recheck scope and capture the full source before returning evidence. Current read ranges are capped at 4 KiB.

Defaults respect workspace-local `.gitignore`/`.ignore`, skip hidden paths, and exclude `.git`/`.jev-grep`. Requests can only narrow registered scope. Read the [scope and API semantics](docs/adr/0003-scoped-exact-core.md), including explicit regex and ignore-dialect limits.

## Persistent worker prototype

A private typed IPC client now drives a persistent Rust worker. Each request enumerates the pinned root, captures bounded regular-file bytes, hashes and matches that same capture, and returns validated evidence. Cancellation and deadlines terminate the worker; a restart cannot silently adopt a replacement root.

```sh
npm run spike:worker -- 10000 200
```

This records full request latency over generated fixtures, including capture, hashing and IPC. This benchmark exercises the low-level worker without registered ignore policy. Its historical result does not measure the new scoped service. See [worker history](docs/adr/0002-persistent-worker-prototype.md) and [current core limits](docs/adr/0003-scoped-exact-core.md).

## Project documents

- [Specification](docs/SPEC.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [Implementation progress](docs/PROGRESS.md)
- [Executable contract boundaries](docs/CONTRACTS.md)
- [Decision register](docs/adr/DECISIONS.md)
