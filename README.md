# Jev-Grep

Local-first, typed evidence retrieval for people and AI agents. Implementation has begun; there is no production search CLI, daemon, persistent index, or model provider yet.

The first increment includes strict TypeScript contracts, generated JSON Schemas, source-evidence verification, conformance tests, and Linux filesystem/matcher feasibility prototypes.

## Development

Use Node **26.8.1** and npm **11.19.0** (pinned in `.node-version` and `package.json`).

```sh
npm ci --ignore-scripts
npm run check
```

`check` typechecks, builds, runs the Node test runner, and verifies generated-schema consistency. To deliberately regenerate schemas after changing the authority:

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

## Project documents

- [Specification](docs/SPEC.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [Implementation progress](docs/PROGRESS.md)
- [Executable contract boundaries](docs/CONTRACTS.md)
- [Decision register](docs/adr/DECISIONS.md)
