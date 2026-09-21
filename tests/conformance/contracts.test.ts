import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { AdminRequestSchema, PathSchema } from '../../src/contracts/schemas.js';
import { assertEvidenceSource, ContractError, parseRequest, parseResponse } from '../../src/contracts/validation.js';

const digest = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'; // SHA-256 of abc
const other = '0'.repeat(64);
const start = '2026-09-21T00:00:00.000Z';
const end = '2026-09-21T00:00:01.000Z';
const envelope = { version: 1, requestId: 'r1', workspaceId: 'w1', scopePolicyId: 'p1' };
const request = { ...envelope, operation: 'exact', query: { kind: 'literal', text: 'abc', caseSensitive: true }, maxMatches: 1 };
const discovery = { ...envelope, operation: 'discover', question: 'where is abc', anchors: [], maxHits: 1, verifyLive: false };
const evidence = { id: 'e1', path: 'src/a.ts', fileSha256: digest, range: { start: 0, end: 3 }, excerpt: { range: { start: 0, end: 3 }, text: 'abc', truncated: false } };
const scope = {
  workspaceId: 'w1', policyId: 'p1', policyHash: other, include: [], exclude: [],
  respectIgnore: true, hidden: false, symlinks: 'reject', encoding: 'utf-8', maxFileBytes: 1_048_576,
  counts: {
    searched: { value: 1, reason: null }, indexed: { value: 1, reason: null },
    excluded: { value: 0, reason: null }, unsupported: { value: 0, reason: null },
    oversized: { value: 0, reason: null }, failed: { value: 0, reason: null },
  },
};
function issue(code: string) { return { code, stage: 'read', retryable: false, message: 'Operation interrupted', nextAction: 'none' }; }
function exact() {
  return { version: 1, requestId: 'r1', status: 'ok', scope, issues: [], result: {
    operation: 'exact', source: { kind: 'live-read', startedAt: start, endedAt: end },
    coverage: { kind: 'complete' }, matches: [{ evidence, provenance: { kind: 'exact', queryKind: 'literal', matcherVersion: '15.2.0' } }],
  } };
}
function ranked() {
  return { version: 1, requestId: 'r1', status: 'ok', scope, issues: [], result: {
    operation: 'discover',
    source: {
      kind: 'index', generationId: 'g1', manifestHash: other, publishedAt: start, scanStartedAt: start, scanEndedAt: start,
      coverage: 'eligible-scan-complete', failedFiles: 0, observedAt: end, generationAgeMs: 1000, clockSkew: false,
      lastUpdateOutcome: { kind: 'failed', attemptId: 'a2', completedAt: end, issue: issue('STORAGE_FULL') },
    },
    selection: { kind: 'ranked', requestedLimit: 1, limitReached: true, degraded: false },
    execution: { kind: 'complete' },
    hits: [{ evidence, generationId: 'g1', rank: 1, liveVerification: { kind: 'not-requested' }, provenance: [{ kind: 'lexical', configFingerprint: other }] }],
  } };
}
function rejected(fn: () => unknown, invariant?: string) {
  assert.throws(fn, error => error instanceof ContractError && (invariant === undefined || error.invariant === invariant));
}

test('valid literal request and exact result at the limit can be complete', () => {
  assert.equal(parseResponse(exact(), parseRequest(request)).status, 'ok');
  assert.equal(assertEvidenceSource(evidence, Buffer.from('abc')).fileSha256, digest);
});
test('unknown fields, protocol versions and overflowing counts are rejected', () => {
  for (const input of [{ ...request, arbitraryRoot: '/tmp' }, { ...request, version: 2 }, { ...request, maxMatches: 1001 }]) {
    rejected(() => parseRequest(input));
  }
});
test('UTF-8 query budgets count bytes rather than JavaScript characters', () => {
  rejected(() => parseRequest({ ...request, query: { ...request.query, text: 'é'.repeat(4097) } }), 'utf8-byte-budget');
  rejected(() => parseRequest({ ...request, query: { ...request.query, text: '\ud800' } }), 'well-formed-unicode');
});
test('line-oriented exact requests reject newline and NUL input', () => {
  for (const text of ['a\nb', 'a\rb', '\u0000']) rejected(() => parseRequest({ ...request, query: { ...request.query, text } }));
});
test('relative-path shape rejects traversal, absolute, ambiguous and control paths', () => {
  for (const path of ['/etc/passwd', '../a', 'a/../b', './a', 'a//b', 'a/', 'a\\b', 'a\0b', 'a\nb']) {
    assert.equal(PathSchema.safeParse(path).success, false, path);
  }
  assert.equal(PathSchema.safeParse('src/é.ts').success, true);
});
test('read requests cannot reverse ranges, exceed budget or accept an arbitrary root', () => {
  const read = { ...envelope, operation: 'read-fresh', path: 'src/a.ts', range: { start: 0, end: 3 }, byteBudget: 3 };
  assert.equal(parseRequest(read).operation, 'read-fresh');
  rejected(() => parseRequest({ ...read, range: { start: 3, end: 2 } }), 'ordered-range');
  rejected(() => parseRequest({ ...read, byteBudget: 2 }), 'read-byte-budget');
});
test('complete exact result cannot conceal a read failure', () => {
  rejected(() => parseResponse({ ...exact(), issues: [issue('READ_FAILED')] }, parseRequest(request)), 'complete-with-failure');
  rejected(() => parseResponse({ ...exact(), scope: { ...scope, counts: { ...scope.counts, failed: { value: 1, reason: null } } } }, parseRequest(request)));
});
test('partial reasons need matching issues and cannot repeat', () => {
  const f = exact();
  const partial = { ...f, issues: [issue('SOURCE_MUTATED')], result: { ...f.result, coverage: { kind: 'partial', reasons: ['source-mutated'] } } };
  assert.equal(parseResponse(partial, parseRequest(request)).status, 'ok');
  rejected(() => parseResponse({ ...partial, issues: [] }, parseRequest(request)), 'partial-reason-issue');
  rejected(() => parseResponse({ ...partial, result: { ...partial.result, coverage: { kind: 'partial', reasons: ['source-mutated', 'source-mutated'] } } }, parseRequest(request)), 'unique-values');
});
test('response must identify its request, scope and operation', () => {
  rejected(() => parseResponse({ ...exact(), requestId: 'r2' }, parseRequest(request)), 'request-id');
  rejected(() => parseResponse({ ...exact(), scope: { ...scope, workspaceId: 'other' } }, parseRequest(request)), 'scope-identity');
  rejected(() => parseResponse(ranked(), parseRequest(request)), 'response-operation');
});
test('missing index is an error, not successful empty discovery', () => {
  const error = issue('INDEX_MISSING');
  assert.equal(parseResponse({ version: 1, requestId: 'r1', status: 'error', error }, parseRequest(discovery)).status, 'error');
  rejected(() => parseResponse({ ...ranked(), issues: [error] }, parseRequest(discovery)), 'fatal-is-not-success');
});
test('failed refresh is retained while older indexed evidence remains usable', () => {
  const r = parseResponse(ranked(), parseRequest(discovery));
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok' || r.result.operation !== 'discover') assert.fail();
  assert.equal(r.result.source.lastUpdateOutcome.kind, 'failed');
  assert.equal(r.result.source.generationAgeMs, 1000);
});
test('generation age, scan coverage, ranks and generation isolation are validated', () => {
  const f = ranked();
  for (const source of [{ ...f.result.source, generationAgeMs: 0 }, { ...f.result.source, failedFiles: 1 }]) {
    rejected(() => parseResponse({ ...f, result: { ...f.result, source } }, parseRequest(discovery)));
  }
  for (const patch of [{ rank: 2 }, { generationId: 'g2' }]) {
    rejected(() => parseResponse({ ...f, result: { ...f.result, hits: f.result.hits.map(h => ({ ...h, ...patch })) } }, parseRequest(discovery)), 'rank-generation');
  }
});
test('optional provider failure requires visible degradation', () => {
  const f = { ...ranked(), issues: [issue('PROVIDER_FAILED')] };
  rejected(() => parseResponse(f, parseRequest(discovery)), 'provider-degradation');
  assert.equal(parseResponse({ ...f, result: { ...f.result, selection: { ...f.result.selection, degraded: true } } }, parseRequest(discovery)).status, 'ok');
});
test('live matched/changed claims must agree with observed digests and request', () => {
  const f = ranked();
  for (const liveVerification of [{ kind: 'matched', checkedAt: end, observedFileSha256: other }, { kind: 'changed', checkedAt: end, observedFileSha256: digest }]) {
    rejected(() => parseResponse({ ...f, result: { ...f.result, hits: f.result.hits.map(h => ({ ...h, liveVerification })) } }, parseRequest({ ...discovery, verifyLive: true })), 'verification-digest');
  }
  rejected(() => parseResponse(f, parseRequest({ ...discovery, verifyLive: true })), 'verification-request');
});
test('cancellation before useful work does not suggest retrying', () => {
  rejected(() => parseResponse({ version: 1, requestId: 'r1', status: 'error', error: { ...issue('CANCELLED'), retryable: true } }, parseRequest(request)), 'cancel-no-retry');
});
test('source verifier rejects wrong full-file hashes and same-length fabricated excerpts', () => {
  rejected(() => assertEvidenceSource(evidence, Buffer.from('abd')), 'source-digest');
  rejected(() => assertEvidenceSource({ ...evidence, excerpt: { ...evidence.excerpt, text: 'xyz' } }, Buffer.from('abc')), 'source-excerpt');
});
test('source verifier preserves UTF-8 and CRLF, rejects split code points and out-of-file ranges', () => {
  const bytes = Buffer.from('é\r\nx');
  const e = { ...evidence, fileSha256: createHash('sha256').update(bytes).digest('hex'), range: { start: 0, end: 2 }, excerpt: { range: { start: 0, end: 2 }, text: 'é', truncated: false } };
  assert.equal(assertEvidenceSource(e, bytes).excerpt.text, 'é');
  rejected(() => assertEvidenceSource({ ...e, range: { start: 1, end: 2 } }, bytes), 'utf8-boundary');
  rejected(() => assertEvidenceSource({ ...e, range: { start: 0, end: 99 }, excerpt: { ...e.excerpt, truncated: true } }, bytes), 'source-range');
});
test('excerpt truncation cannot be hidden', () => {
  rejected(() => assertEvidenceSource({ ...evidence, excerpt: { range: { start: 0, end: 1 }, text: 'a', truncated: false } }, Buffer.from('abc')), 'excerpt-truncation');
});
test('verified source read refuses a silently replaced revision', () => {
  const read = parseRequest({ ...envelope, operation: 'read-verified', path: evidence.path, expectedFileSha256: other, range: evidence.range, byteBudget: 3 });
  rejected(() => parseResponse({ version: 1, requestId: 'r1', status: 'ok', scope, issues: [], result: { operation: 'read-verified', evidence, capturedAt: end } }, read), 'read-revision');
});
test('administration declaration does not accept implicit root on index requests', () => {
  assert.equal(AdminRequestSchema.safeParse({ ...envelope, operation: 'index-create', refreshMode: 'manual', configFingerprint: other }).success, true);
  assert.equal(AdminRequestSchema.safeParse({ ...envelope, operation: 'index-create', absoluteRoot: '/tmp' }).success, false);
});
