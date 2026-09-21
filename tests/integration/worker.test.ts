import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { assertEvidenceSource } from '../../src/contracts/validation.js';
import { NativeWorker, WorkerError } from '../../src/worker/client.js';
import type { WorkerInput } from '../../src/worker/protocol.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'jev-worker-'));
  const worker = new NativeWorker(root);
  t.after(async () => { worker.close(); await delay(10); await rm(root, { recursive: true, force: true }); });
  return { root, worker };
}
async function afterRetirement(worker: NativeWorker, input: WorkerInput) {
  for (let i = 0; i < 50; i++) {
    try { return await worker.search(input); }
    catch (e) { if (!(e instanceof WorkerError) || e.code !== 'WORKER_RESTARTING') throw e; await delay(10); }
  }
  assert.fail('worker did not retire');
}
function pid(worker: NativeWorker): number { assert.ok(worker.pid); return worker.pid; }

test('persistent worker captures, hashes and matches the same source bytes', async t => {
  const { root, worker } = await fixture(t);
  const bytes = Buffer.from('é needle\r\nsecond needle\n');
  await writeFile(join(root, 'a.ts'), bytes);
  const r = await worker.search({ pattern: 'needle' });
  assert.equal(r.status, 'ok'); if (r.status !== 'ok') assert.fail();
  assert.deepEqual(r.matches.map(h => h.range), [{ start: 3, end: 9 }, { start: 18, end: 24 }]);
  for (const h of r.matches) assertEvidenceSource({ id: 'e1', ...h }, bytes);
  const first = pid(worker);
  await writeFile(join(root, 'a.ts'), 'changed needle');
  const updated = await worker.search({ pattern: 'needle' });
  assert.equal(updated.status, 'ok'); if (updated.status !== 'ok') assert.fail();
  assert.notEqual(updated.matches[0]?.fileSha256, r.matches[0]?.fileSha256);
  assert.equal(pid(worker), first);
});

test('supported literal and regex occurrences agree with pinned ripgrep', async t => {
  const { root, worker } = await fixture(t);
  const cases: { text: string; pattern: string; kind: 'literal' | 'regex'; caseSensitive?: boolean }[] = [
    { text: 'foo needle\r\nFoo\nfoo\n', pattern: 'foo', kind: 'literal' },
    { text: 'foo needle\r\nFoo\nfoo\n', pattern: 'foo', kind: 'literal', caseSensitive: false },
    ...['foo|needle', '^foo', 'foo$', '\\bfoo\\b', '[a-z]+', '^|$'].map(pattern => ({ text: 'foo needle\r\nFoo\nfoo\n', pattern, kind: 'regex' as const })),
    { text: 'ab\ncd\n', pattern: '(?:)', kind: 'regex' },
    { text: 'abc\n', pattern: 'a*', kind: 'regex' },
    { text: 'éé needle\r\n', pattern: 'é+', kind: 'regex' },
    { text: 'needle\r\n', pattern: 'needle\\r$', kind: 'regex' },
    { text: '', pattern: '^', kind: 'regex' },
  ];
  const version = execFileSync('rg', ['--version'], { encoding: 'utf8' });
  assert.match(version, /^ripgrep 15\.2\.0 /);
  for (const c of cases) {
    await writeFile(join(root, 'a.txt'), c.text);
    const args = ['--no-config', '--engine=default', '--json', ...(c.kind === 'literal' ? ['--fixed-strings'] : []), ...(c.caseSensitive === false ? ['--ignore-case'] : ['--case-sensitive']), '-e', c.pattern, '-'];
    let out: string;
    try { out = execFileSync('rg', args, { input: c.text, encoding: 'utf8' }); }
    catch (e) {
      if (typeof e !== 'object' || e === null || !('status' in e) || e.status !== 1 || !('stdout' in e) || typeof e.stdout !== 'string') throw e;
      out = e.stdout;
    }
    const expected: { start: number; end: number }[] = [];
    for (const line of out.trim().split('\n')) {
      if (!line) continue;
      // Trusted comparator output is checked minimally here; production uses Zod.
      const row = JSON.parse(line) as { type: string; data: { absolute_offset: number; submatches: { start: number; end: number }[] } };
      if (row.type === 'match') for (const m of row.data.submatches) expected.push({ start: row.data.absolute_offset + m.start, end: row.data.absolute_offset + m.end });
    }
    const result = await worker.search({ pattern: c.pattern, kind: c.kind, caseSensitive: c.caseSensitive ?? true });
    assert.equal(result.status, 'ok', c.pattern); if (result.status !== 'ok') assert.fail();
    assert.deepEqual(result.matches.map(h => h.range), expected, c.pattern);
  }
});

test('scope excludes hidden, special, binary, invalid UTF-8 and oversized files', async t => {
  const { root, worker } = await fixture(t);
  await writeFile(join(root, 'ok'), 'needle');
  await writeFile(join(root, '.hidden'), 'needle');
  await writeFile(join(root, 'binary'), Buffer.from([0, 110]));
  await writeFile(join(root, 'bad-utf8'), Buffer.from([255]));
  await writeFile(join(root, 'large'), 'needle'.repeat(100));
  await symlink('/etc/passwd', join(root, 'outside'));
  await symlink('ok', join(root, 'inside-link'));
  execFileSync('mkfifo', [join(root, 'pipe')]);
  const r = await worker.search({ pattern: 'needle', maxFileBytes: 100 });
  assert.equal(r.status, 'ok'); if (r.status !== 'ok') assert.fail();
  assert.equal(r.coverage, 'complete'); assert.equal(r.counts.searched, 1);
  assert.equal(r.counts.excluded, 7); assert.deepEqual(r.matches.map(h => h.path), ['ok']);
});

test('match and serialized-byte limits never report complete execution', async t => {
  const { root, worker } = await fixture(t);
  await writeFile(join(root, 'a'), 'needle needle');
  const limited = await worker.search({ pattern: 'needle', maxMatches: 1 });
  assert.equal(limited.status, 'ok'); if (limited.status !== 'ok') assert.fail();
  assert.equal(limited.coverage, 'partial'); assert.deepEqual(limited.reasons, ['LIMIT_REACHED']);
  const bytes = await worker.search({ pattern: 'needle', responseBytes: 2048 });
  assert.equal(bytes.status, 'ok'); if (bytes.status !== 'ok') assert.fail();
  assert.deepEqual(bytes.reasons, ['BYTE_LIMIT']); assert.ok(Buffer.byteLength(JSON.stringify(bytes)) <= 2048);
  await writeFile(join(root, 'a'), 'needle');
  const exactly = await worker.search({ pattern: 'needle', maxMatches: 1 });
  assert.equal(exactly.status, 'ok'); if (exactly.status !== 'ok') assert.fail();
  assert.equal(exactly.coverage, 'complete');
});

test('traversal budgets are explicit and repeated searches enumerate fresh entries', async t => {
  const { root, worker } = await fixture(t);
  await mkdir(join(root, 'nested')); await mkdir(join(root, 'nested', 'deep'));
  await writeFile(join(root, 'nested', 'deep', 'a'), 'needle');
  const depth = await worker.search({ pattern: 'needle', maxDepth: 1 });
  assert.equal(depth.status, 'ok'); if (depth.status !== 'ok') assert.fail();
  assert.ok(depth.reasons.includes('DEPTH_LIMIT'));
  const entries = await worker.search({ pattern: 'needle', maxEntries: 1 });
  assert.equal(entries.status, 'ok'); if (entries.status !== 'ok') assert.fail();
  assert.ok(entries.reasons.includes('ENTRY_LIMIT'));
  await rm(join(root, 'nested'), { recursive: true });
  await writeFile(join(root, 'new'), 'needle');
  const fresh = await worker.search({ pattern: 'needle' });
  assert.equal(fresh.status, 'ok'); if (fresh.status !== 'ok') assert.fail();
  assert.deepEqual(fresh.matches.map(h => h.path), ['new']);
});

test('unrepresentable byte-boundary and unsupported regex semantics fail explicitly', async t => {
  const { root, worker } = await fixture(t); await writeFile(join(root, 'a'), 'é\n');
  for (const pattern of ['\\A', '\\z', '(?=a)', '[']) {
    const r = await worker.search({ pattern, kind: 'regex' });
    assert.equal(r.status, 'error'); if (r.status !== 'error') assert.fail();
    assert.equal(r.code, 'REGEX_INVALID');
  }
  const split = await worker.search({ pattern: '(?:)', kind: 'regex' });
  assert.equal(split.status, 'error'); if (split.status !== 'error') assert.fail();
  assert.equal(split.code, 'MATCH_ENCODING');
});

test('cancellation interrupts a stopped worker and the next request uses a new process', async t => {
  const { root, worker } = await fixture(t); await writeFile(join(root, 'a'), 'needle');
  await worker.search({ pattern: 'needle' }); const first = pid(worker);
  process.kill(first, 'SIGSTOP');
  const controller = new AbortController();
  const pending = worker.search({ pattern: 'needle' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
  const next = await afterRetirement(worker, { pattern: 'needle' });
  assert.equal(next.status, 'ok'); assert.notEqual(pid(worker), first);
});

test('parent deadline includes unresponsive kernel/process work', async t => {
  const { worker } = await fixture(t); await worker.search({ pattern: 'needle' });
  process.kill(pid(worker), 'SIGSTOP');
  const before = performance.now();
  await assert.rejects(worker.search({ pattern: 'needle', deadlineMs: 25 }), { code: 'DEADLINE' });
  assert.ok(performance.now() - before < 1000);
  assert.equal((await afterRetirement(worker, { pattern: 'needle' })).status, 'ok');
});

test('worker crash rejects in-flight work; a concurrent request cannot enter its stream', async t => {
  const { worker } = await fixture(t); await worker.search({ pattern: 'needle' });
  process.kill(pid(worker), 'SIGSTOP');
  const pending = worker.search({ pattern: 'needle' });
  await assert.rejects(worker.search({ pattern: 'other' }), { code: 'WORKER_BUSY' });
  process.kill(pid(worker), 'SIGKILL');
  await assert.rejects(pending, { code: 'WORKER_EXIT' });
  assert.equal((await afterRetirement(worker, { pattern: 'needle' })).status, 'ok');
});

test('root replacement cannot silently rebind registration after restart', async t => {
  const { root, worker } = await fixture(t);
  const old = root + '-old'; t.after(() => rm(old, { recursive: true, force: true }));
  await writeFile(join(root, 'a'), 'needle'); await worker.search({ pattern: 'needle' });
  await rename(root, old); await mkdir(root); await writeFile(join(root, 'external'), 'needle');
  const pinned = await worker.search({ pattern: 'needle' });
  assert.equal(pinned.status, 'ok'); if (pinned.status !== 'ok') assert.fail();
  assert.deepEqual(pinned.matches.map(h => h.path), ['a']);
  process.kill(pid(worker), 'SIGSTOP');
  await assert.rejects(worker.search({ pattern: 'needle', deadlineMs: 20 }), { code: 'DEADLINE' });
  await assert.rejects(afterRetirement(worker, { pattern: 'needle' }), { code: 'ROOT_CHANGED' });
});

test('invalid requests and pre-cancelled operations never start a worker', async t => {
  const { worker } = await fixture(t);
  await assert.rejects(worker.search({ pattern: 'é'.repeat(4097) }), { code: 'INVALID_REQUEST' });
  await assert.rejects(worker.search({ pattern: 'needle' }, { signal: AbortSignal.abort() }), { code: 'CANCELLED' });
  await assert.rejects(worker.search({ pattern: 'x', id: 'injected' } as unknown as WorkerInput), { code: 'INVALID_REQUEST' });
  assert.equal(worker.pid, undefined);
});
