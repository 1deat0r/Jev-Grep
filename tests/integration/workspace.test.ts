import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, rename, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { WorkspaceRegistry } from '../../src/workspace/registry.js';
import { createPolicy, narrowPolicy } from '../../src/workspace/policy.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'jev-scope-'));
  const registry = new WorkspaceRegistry();
  t.after(async () => { registry.close(); await rm(root, { recursive: true, force: true }); });
  const put = async (path: string, content = 'needle') => {
    const parts = path.split('/'); parts.pop();
    await mkdir(join(root, ...parts), { recursive: true }); await writeFile(join(root, path), content);
  };
  return { root, registry, put };
}
const ids = (r: { workspaceId: string; scopePolicyId: string }) => ({ workspaceId: r.workspaceId, scopePolicyId: r.scopePolicyId });
function paths(response: Awaited<ReturnType<WorkspaceRegistry['search']>>) {
  assert.equal(response.result.status, 'ok');
  assert.equal(response.result.coverage, 'complete');
  return response.result.matches.map(m => m.path).sort();
}

test('policy identity is canonical, copied, deeply frozen and distinguishes authority', () => {
  const input = { include: ['src/**', '**/*.ts', 'src/**'] };
  const a = createPolicy(input); const b = createPolicy({ include: ['**/*.ts', 'src/**'] });
  assert.equal(a.policyHash, b.policyHash);
  input.include.push('secret/**'); assert.equal(a.policy.include.length, 2);
  assert.throws(() => (a.policy.include as string[]).push('**'));
  assert.throws(() => { (a.policy as { hidden: boolean }).hidden = true; });
  assert.notEqual(a.policyHash, createPolicy({ hidden: true }).policyHash);
  assert.deepEqual(narrowPolicy(a.policy, { include: ['test/**'], exclude: [] }).includeGroups, [['**/*.ts', 'src/**'], ['test/**']]);
  for (const p of ['../**', '/etc/**', '!secret', 'a\\b', 'a//b', 'é'.repeat(600)]) assert.throws(() => createPolicy({ include: [p] }));
  assert.throws(() => createPolicy({ symlinks: 'follow' }));
});

test('registration pins root before first search, creates no index, and can be revoked', async t => {
  const { root, registry, put } = await fixture(t);
  await put('old.txt'); const registration = await registry.register(root);
  assert.deepEqual(await readdir(root), ['old.txt']);
  assert.equal('absoluteRoot' in registration, false);
  const old = `${root}-old`; t.after(() => rm(old, { recursive: true, force: true }));
  await rename(root, old); await mkdir(root); await put('replacement.txt');
  assert.deepEqual(paths(await registry.search({ ...ids(registration), pattern: 'needle' })), ['old.txt']);
  registry.unregister(registration.workspaceId);
  await assert.rejects(registry.search({ ...ids(registration), pattern: 'needle' }), { code: 'OUT_OF_SCOPE' });
});

test('workspace IDs, policy IDs and request fields cannot select arbitrary roots or expand policy', async t => {
  const { root, registry } = await fixture(t); const r = await registry.register(root);
  for (const extra of [{ absoluteRoot: '/etc' }, { hidden: true }, { respectIgnore: false }, { maxFileBytes: 99 }, { narrow: { include: [], exclude: [], hidden: true } }]) {
    await assert.rejects(registry.search({ ...ids(r), pattern: 'needle', ...extra }), { code: 'INVALID_REQUEST' });
  }
  await assert.rejects(registry.search({ ...ids(r), scopePolicyId: randomUUID(), pattern: 'needle' }), { code: 'OUT_OF_SCOPE' });
  await assert.rejects(registry.search({ ...ids(r), workspaceId: randomUUID(), pattern: 'needle' }), { code: 'OUT_OF_SCOPE' });
  await assert.rejects(registry.register('relative'), { code: 'INVALID_REQUEST' });
  registry.close(); await assert.rejects(registry.register(root), { code: 'REGISTRY_CLOSED' });
});

test('include intersection and exclude union restrict captures, including source expansion candidates', async t => {
  const { root, registry, put } = await fixture(t);
  for (const path of ['src/a.ts', 'src/a.js', 'src/private.ts', 'test/a.ts']) await put(path);
  const r = await registry.register(root, { include: ['src/**'], exclude: ['**/private.ts'] });
  assert.deepEqual(paths(await registry.search({ ...ids(r), pattern: 'needle', narrow: { include: ['**/*.ts', 'test/**'], exclude: [] } })), ['src/a.ts']);
  assert.deepEqual(paths(await registry.search({ ...ids(r), pattern: 'needle', narrow: { include: ['test/**'], exclude: [] } })), []);
  assert.deepEqual(paths(await registry.search({ ...ids(r), pattern: 'needle', narrow: { include: [], exclude: ['src/a.*'] } })), []);
});

test('default ignores support nested overrides, negation, anchored and directory rules', async t => {
  const { root, registry, put } = await fixture(t);
  await put('.gitignore', '*.log\n/root.txt\nblocked/\n!blocked/revive.txt\n');
  await put('nested/.gitignore', '!keep.log\n');
  for (const path of ['a.log', 'root.txt', 'keep.txt', 'nested/root.txt', 'nested/keep.log', 'nested/drop.log', 'blocked/revive.txt', '.hidden']) await put(path);
  const r = await registry.register(root);
  assert.deepEqual(paths(await registry.search({ ...ids(r), pattern: 'needle' })), ['keep.txt', 'nested/keep.log', 'nested/root.txt']);
});

test('.ignore overrides .gitignore; ignore files are bounded and invalid policy fails closed', async t => {
  const { root, registry, put } = await fixture(t);
  await put('.gitignore', '*.txt\n'); await put('.ignore', '!keep.txt\n'); await put('keep.txt'); await put('drop.txt');
  const r = await registry.register(root);
  const before = await registry.search({ ...ids(r), pattern: 'needle' });
  assert.deepEqual(paths(before), ['keep.txt']);
  await put('.ignore', '!drop.txt\n');
  const after = await registry.search({ ...ids(r), pattern: 'needle' }); assert.deepEqual(paths(after), ['drop.txt']);
  if (before.result.status === 'ok' && after.result.status === 'ok') assert.notEqual(before.result.policySnapshotHash, after.result.policySnapshotHash);
  await put('.ignore', 'x'.repeat(65_537));
  const bad = await registry.search({ ...ids(r), pattern: 'needle' });
  assert.equal(bad.result.status, 'ok'); assert.equal(bad.result.coverage, 'partial'); assert.deepEqual(bad.result.matches, []);
});

test('explicit hidden/no-ignore policy still excludes metadata, index, symlinks and oversized files', async t => {
  const { root, registry, put } = await fixture(t);
  await put('.gitignore', '*.txt');
  for (const path of ['.visible', '.git/config', '.jev-grep/chunks', 'nested/.jev-grep/chunks', 'ignored.txt']) await put(path);
  await put('large', 'needle'.repeat(10)); await symlink(join(root, 'ignored.txt'), join(root, 'alias'));
  const r = await registry.register(root, { hidden: true, respectIgnore: false, maxFileBytes: 10 });
  assert.deepEqual(paths(await registry.search({ ...ids(r), pattern: 'needle' })), ['.visible', 'ignored.txt']);
});

test('symlinked ignore files are errors, never a reason to scan with weakened rules', async t => {
  const { root, registry, put } = await fixture(t); await put('data'); await put('policy', 'data');
  await symlink(join(root, 'policy'), join(root, '.gitignore'));
  const r = await registry.register(root); const response = await registry.search({ ...ids(r), pattern: 'needle' });
  assert.equal(response.result.status, 'ok'); assert.equal(response.result.coverage, 'partial'); assert.deepEqual(response.result.matches, []);
});

test('ignore precedence applies across directory depths and never overrides explicit exclusions', async t => {
  const { root, registry, put } = await fixture(t);
  await put('.ignore', '*.log\n!keep.txt\n'); await put('nested/.gitignore', '!keep.log\n*.txt\n');
  for (const path of ['nested/keep.log', 'nested/keep.txt', 'nested/drop.txt']) await put(path);
  const r = await registry.register(root);
  assert.deepEqual(paths(await registry.search({ ...ids(r), pattern: 'needle' })), ['nested/keep.txt']);
  assert.deepEqual(paths(await registry.search({ ...ids(r), pattern: 'needle', narrow: { include: [], exclude: ['**/*.txt'] } })), []);
});

test('malformed globs fail at registration without scanning source files', async t => {
  const { root, registry, put } = await fixture(t); await put('.gitignore', 'x'.repeat(70_000));
  await assert.rejects(registry.register(root, { include: ['['] }), { code: 'INVALID_REQUEST' });
  const r = await registry.register(root);
  assert.ok(r.workspaceId); // Invalid policy file is read only by search, not registration.
});

test('narrowing allows the full base and request exclusion budgets without union overflow', async t => {
  const { root, registry, put } = await fixture(t); await put('keep');
  const r = await registry.register(root, { exclude: Array.from({ length: 64 }, (_, i) => `base-${i}`) });
  assert.deepEqual(paths(await registry.search({ ...ids(r), pattern: 'needle', narrow: { include: [], exclude: Array.from({ length: 64 }, (_, i) => `request-${i}`) } })), ['keep']);
});

test('closing while registration is in flight cannot publish new authority', async t => {
  const { root, registry } = await fixture(t);
  const pending = registry.register(root); registry.close();
  await assert.rejects(pending, { code: 'REGISTRY_CLOSED' });
});
