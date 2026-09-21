import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { WorkspaceRegistry } from '../../src/workspace/registry.js';
import { ExactService } from '../../src/service/exact.js';
import { assertEvidenceSource } from '../../src/contracts/validation.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'jev-service-'));
  const registry = new WorkspaceRegistry(); const service = new ExactService(registry);
  t.after(async () => { registry.close(); await rm(root, { recursive: true, force: true }); });
  const registration = await registry.register(root);
  const envelope = { version: 1, requestId: 'test', workspaceId: registration.workspaceId, scopePolicyId: registration.scopePolicyId };
  const exact = { ...envelope, operation: 'exact', query: { kind: 'literal', text: 'needle', caseSensitive: true }, maxMatches: 100 };
  return { root, registry, service, envelope, exact };
}

test('public exact → verified read → mismatch → fresh read works without an index', async t => {
  const { root, service, envelope, exact } = await fixture(t);
  const original = Buffer.from('é needle\r\n'); await writeFile(join(root, 'source.ts'), original);
  const result = await service.execute(exact);
  assert.equal(result.status, 'ok'); assert.equal(result.result.operation, 'exact');
  assert.equal(result.result.coverage.kind, 'complete');
  const hit = result.result.matches[0]!.evidence;
  assertEvidenceSource(hit, original); assert.deepEqual(hit.range, { start: 3, end: 9 });
  const read = { ...envelope, operation: 'read-verified', path: hit.path, range: hit.range, byteBudget: 4096, expectedFileSha256: hit.fileSha256 };
  const verified = await service.execute(read);
  assert.equal(verified.status, 'ok'); assert.equal(verified.result.operation, 'read-verified');
  assert.equal(verified.result.evidence.id, hit.id); assertEvidenceSource(verified.result.evidence, original);
  await writeFile(join(root, 'source.ts'), 'é change\r\n');
  const mismatch = await service.execute(read); assert.equal(mismatch.status, 'error'); assert.equal(mismatch.error.code, 'REVISION_MISMATCH');
  const fresh = await service.execute({ ...envelope, operation: 'read-fresh', path: hit.path, range: hit.range, byteBudget: 4096 });
  assert.equal(fresh.status, 'ok'); assert.equal(fresh.result.operation, 'read-fresh'); assert.notEqual(fresh.result.evidence.id, hit.id);
  assertEvidenceSource(fresh.result.evidence, Buffer.from('é change\r\n'));
  assert.deepEqual(await readdir(root), ['source.ts']);
});

test('source expansion rechecks scope and current ignore rules', async t => {
  const { root, service, envelope, exact } = await fixture(t);
  await writeFile(join(root, 'source'), 'needle');
  const r = await service.execute(exact); assert.equal(r.status, 'ok'); assert.equal(r.result.operation, 'exact');
  const hit = r.result.matches[0]!.evidence;
  const request = { ...envelope, operation: 'read-verified', path: hit.path, range: hit.range, byteBudget: 4096, expectedFileSha256: hit.fileSha256 };
  const narrowed = await service.execute({ ...request, narrow: { include: ['elsewhere/**'], exclude: [] } });
  assert.equal(narrowed.status, 'error'); assert.equal(narrowed.error.code, 'OUT_OF_SCOPE');
  await writeFile(join(root, '.gitignore'), 'source\n');
  const ignored = await service.execute(request); assert.equal(ignored.status, 'error'); assert.equal(ignored.error.code, 'OUT_OF_SCOPE');
});

test('hand-authored occurrence fixtures preserve case, UTF-8 offsets, CRLF and zero-width progress', async t => {
  const { root, service, exact } = await fixture(t);
  const cases = [
    { text: 'foo foo\r\nFOO\n', query: { kind: 'literal', text: 'foo', caseSensitive: true }, ranges: [[0,3],[4,7]] },
    { text: 'foo foo\r\nFOO\n', query: { kind: 'literal', text: 'foo', caseSensitive: false }, ranges: [[0,3],[4,7],[9,12]] },
    { text: 'éé z\n', query: { kind: 'regex', pattern: 'é+', caseSensitive: true }, ranges: [[0,4]] },
    { text: 'ab\ncd\n', query: { kind: 'regex', pattern: '^', caseSensitive: true }, ranges: [[0,0],[3,3]] },
    { text: '', query: { kind: 'literal', text: 'x', caseSensitive: true }, ranges: [] },
  ];
  for (const c of cases) {
    await writeFile(join(root, 'source'), c.text);
    const result = await service.execute({ ...exact, query: c.query });
    assert.equal(result.status, 'ok'); assert.equal(result.result.operation, 'exact'); assert.equal(result.result.coverage.kind, 'complete');
    assert.deepEqual(result.result.matches.map(h => [h.evidence.range.start, h.evidence.range.end]), c.ranges);
    for (const hit of result.result.matches) assertEvidenceSource(hit.evidence, Buffer.from(c.text));
  }
});

test('limits preserve partial status after public envelope overhead, and exactly-full can be complete', async t => {
  const { root, service, exact } = await fixture(t);
  await writeFile(join(root, 'source'), 'needle needle');
  const partial = await service.execute({ ...exact, maxMatches: 1 });
  assert.equal(partial.status, 'ok'); assert.equal(partial.result.operation, 'exact'); assert.equal(partial.result.coverage.kind, 'partial');
  assert.ok(partial.issues.some(i => i.code === 'LIMIT_REACHED'));
  const complete = await service.execute({ ...exact, maxMatches: 2 });
  assert.equal(complete.status, 'ok'); assert.equal(complete.result.operation, 'exact'); assert.equal(complete.result.coverage.kind, 'complete');
  await writeFile(join(root, 'source'), 'needle '.repeat(100));
  const bounded = await service.execute(exact, { responseBytes: 4096 });
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 4096);
  assert.equal(bounded.status, 'ok'); assert.equal(bounded.result.operation, 'exact'); assert.equal(bounded.result.coverage.kind, 'partial');
  assert.ok(bounded.issues.some(i => i.code === 'BYTE_LIMIT'));
});

test('invalid ranges, unsupported semantics and cancellation are typed errors', async t => {
  const { root, service, envelope, exact } = await fixture(t); await writeFile(join(root, 'source'), 'é needle');
  const read = { ...envelope, operation: 'read-fresh', path: 'source', range: { start: 0, end: 1 }, byteBudget: 4096 };
  for (const request of [read, { ...read, path: '../outside' }, { ...read, range: { start: 0, end: 500 } }, { ...exact, absoluteRoot: root }]) {
    const r = await service.execute(request); assert.equal(r.status, 'error'); assert.equal(r.error.code, 'INVALID_REQUEST');
  }
  const cancelled = await service.execute(exact, {}, { signal: AbortSignal.abort() });
  assert.equal(cancelled.status, 'error'); assert.equal(cancelled.error.code, 'CANCELLED');
  const badContext = await service.execute(exact, { responseBytes: 1_048_577 }); assert.equal(badContext.status, 'error'); assert.equal(badContext.error.code, 'INVALID_REQUEST');
  const regex = await service.execute({ ...exact, query: { kind: 'regex', pattern: '(?=x)', caseSensitive: true } }); assert.equal(regex.status, 'error'); assert.equal(regex.error.code, 'INVALID_REQUEST');
});

test('read policy includes parent directories and invalid policy never becomes complete success', async t => {
  const { root, service, envelope, exact } = await fixture(t);
  await mkdir(join(root, 'nested')); await writeFile(join(root, 'nested', 'source'), 'needle'); await writeFile(join(root, '.gitignore'), 'nested/');
  const r = await service.execute({ ...envelope, operation: 'read-fresh', path: 'nested/source', range: { start: 0, end: 6 }, byteBudget: 4096 });
  assert.equal(r.status, 'error'); assert.equal(r.error.code, 'OUT_OF_SCOPE');
  await writeFile(join(root, '.gitignore'), Buffer.from([0xff]));
  const failure = await service.execute(exact); assert.equal(failure.status, 'ok'); assert.equal(failure.result.operation, 'exact'); assert.equal(failure.result.coverage.kind, 'partial');
  assert.ok(failure.issues.some(i => i.code === 'READ_FAILED'));
});

test('empty reads, byte caps and unsupported protocol versions have explicit outcomes', async t => {
  const { root, service, envelope, exact } = await fixture(t);
  await writeFile(join(root, 'empty'), '');
  const empty = await service.execute({ ...envelope, operation: 'read-fresh', path: 'empty', range: { start: 0, end: 0 }, byteBudget: 1 });
  assert.equal(empty.status, 'ok'); assert.equal(empty.result.operation, 'read-fresh'); assert.equal(empty.result.evidence.excerpt.text, '');
  await writeFile(join(root, 'large'), 'x'.repeat(5000));
  const cap = await service.execute({ ...envelope, operation: 'read-fresh', path: 'large', range: { start: 0, end: 5000 }, byteBudget: 5000 });
  assert.equal(cap.status, 'error'); assert.equal(cap.error.code, 'BYTE_LIMIT');
  const version = await service.execute({ ...exact, version: 2 }); assert.equal(version.status, 'error'); assert.equal(version.error.code, 'UNSUPPORTED_VERSION');
});

test('verified read hashes bytes outside the requested excerpt and refuses symlink expansion', async t => {
  const { root, service, envelope, exact } = await fixture(t); await writeFile(join(root, 'source'), 'needle outside');
  const r = await service.execute(exact); assert.equal(r.status, 'ok'); assert.equal(r.result.operation, 'exact');
  const hit = r.result.matches[0]!.evidence;
  await writeFile(join(root, 'source'), 'needle changed');
  const request = { ...envelope, operation: 'read-verified', path: 'source', range: hit.range, byteBudget: 4096, expectedFileSha256: hit.fileSha256 };
  const mismatch = await service.execute(request); assert.equal(mismatch.status, 'error'); assert.equal(mismatch.error.code, 'REVISION_MISMATCH');
  const { symlink } = await import('node:fs/promises'); await symlink(join(root, 'source'), join(root, 'alias'));
  const alias = await service.execute({ ...request, path: 'alias' }); assert.equal(alias.status, 'error'); assert.equal(alias.error.code, 'OUT_OF_SCOPE');
});

test('oversized mandatory scope metadata returns a bounded error rather than an invalid partial result', async t => {
  const { root, registry, service, exact } = await fixture(t);
  const r = await registry.register(root, { include: Array.from({ length: 64 }, (_, i) => `prefix-${i}-${'x'.repeat(90)}/**`) });
  const bounded = await service.execute({ ...exact, workspaceId: r.workspaceId, scopePolicyId: r.scopePolicyId }, { responseBytes: 2048 });
  assert.equal(bounded.status, 'error'); assert.equal(bounded.error.code, 'BYTE_LIMIT');
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 2048);
});

test('request budget overrides cannot expand deployment caps', async t => {
  const { root, registry, exact } = await fixture(t); await writeFile(join(root, 'source'), 'needle '.repeat(100));
  const limited = new ExactService(registry, { responseBytes: 2048 });
  const result = await limited.execute(exact, { responseBytes: 1_048_576 });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 2048);
  if (result.status === 'ok') { assert.equal(result.result.operation, 'exact'); assert.equal(result.result.coverage.kind, 'partial'); }
  else assert.equal(result.error.code, 'BYTE_LIMIT');
});
