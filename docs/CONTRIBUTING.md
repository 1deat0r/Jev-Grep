# Working on Jev-Grep

Use focused branches and conventional commits. Open a pull request with the concrete behavior change, test evidence, and remaining limits. Keep implementation claims separate from design-review scores and synthetic benchmark results. Public-repository status does not imply a production release.

Install the pinned toolchain, run `npm ci --ignore-scripts`, then `npm run check`. Configure the local convenience hook with `git config core.hooksPath .githooks`. CI repeats the commit-scope gate on all tracked bytes; bypassing a local hook does not bypass CI.

## Commit boundary

Commit source, schemas, lockfiles, tests, reviewed documentation, and explicitly synthetic fixture/benchmark reports. All example contents in tests and spikes are fictional generated data; no customer content or media belongs in this repository.

Never commit credentials, environment files, private keys/certificates, profiles, local approval/override files, runtime databases/indexes, user uploads/media, private skill/design bundles, build outputs, or dependency caches. `.gitignore` and `scripts/check-commit-scope.py` enforce the boundary. The gate prints filenames and categories, never matched secret values.

Add tests appropriate to a change. Preserve explicit partial/error outcomes, captured-source identity, scope containment, request deadlines, and cancellation semantics. A passing prototype is not permission to claim release performance or weaken a failed acceptance gate.

Changes to public contracts require regenerated JSON Schemas and conformance evidence. Native protocol changes require both Rust and TypeScript parity tests. Keep the specification and implementation progress accurate; unfinished work must remain visible.
