import { createHash } from 'node:crypto';
import { EvidenceSchema, LIMITS, RequestSchema, ResponseSchema } from './schemas.js';
import type { ByteRange, Evidence, Issue, Request, Response } from './schemas.js';

/** Messages intentionally contain only invariant names, never source/query bytes. */
export class ContractError extends Error {
  constructor(readonly invariant: string) { super(`Contract invariant: ${invariant}`); this.name = 'ContractError'; }
}
function requireInvariant(ok: boolean, name: string): asserts ok {
  if (!ok) throw new ContractError(name);
}
function byteText(text: string, max: number): void {
  requireInvariant(text.isWellFormed(), 'well-formed-unicode');
  requireInvariant(Buffer.byteLength(text, 'utf8') <= max, 'utf8-byte-budget');
}
function range(r: ByteRange): void { requireInvariant(r.start <= r.end, 'ordered-range'); }
function unique(items: readonly string[]): void { requireInvariant(new Set(items).size === items.length, 'unique-values'); }
function chronological(start: string, end: string): void { requireInvariant(Date.parse(start) <= Date.parse(end), 'chronological-times'); }
function evidenceShape(e: Evidence): void {
  byteText(e.path, 4096); byteText(e.excerpt.text, LIMITS.excerptBytes);
  range(e.range); range(e.excerpt.range);
  requireInvariant(Buffer.byteLength(e.excerpt.text) === e.excerpt.range.end - e.excerpt.range.start, 'excerpt-byte-length');
  const contains = e.excerpt.range.start <= e.range.start && e.excerpt.range.end >= e.range.end;
  requireInvariant(e.excerpt.truncated === !contains, 'excerpt-truncation');
}
export function parseRequest(input: unknown): Request {
  const parsed = RequestSchema.safeParse(input);
  if (!parsed.success) throw new ContractError('request-shape');
  const r = parsed.data;
  if (r.narrow) for (const p of [...r.narrow.include, ...r.narrow.exclude]) byteText(p, LIMITS.patternBytes);
  switch (r.operation) {
    case 'exact': {
      const q = r.query.kind === 'literal' ? r.query.text : r.query.pattern;
      byteText(q, LIMITS.queryBytes);
      requireInvariant(!/[\r\n\u0000]/u.test(q), 'line-oriented-query');
      break;
    }
    case 'discover':
      byteText(r.question, LIMITS.queryBytes);
      for (const a of r.anchors) byteText(a, LIMITS.anchorBytes);
      break;
    case 'read-verified': case 'read-fresh':
      byteText(r.path, 4096); range(r.range);
      requireInvariant(r.range.end - r.range.start <= r.byteBudget, 'read-byte-budget');
  }
  return r;
}
const reasonCodes: Readonly<Record<string, readonly Issue['code'][]>> = {
  limit: ['LIMIT_REACHED', 'BYTE_LIMIT'], 'byte-limit': ['BYTE_LIMIT'], cancelled: ['CANCELLED'],
  'read-failure': ['READ_FAILED'], deadline: ['DEADLINE'], 'policy-changed': ['POLICY_CHANGED'], 'source-mutated': ['SOURCE_MUTATED'],
};
function partialReasons(reasons: string[], issues: Issue[]): void {
  unique(reasons);
  for (const reason of reasons) requireInvariant(issues.some(i => reasonCodes[reason]?.includes(i.code) === true), 'partial-reason-issue');
}
export function parseResponse(input: unknown, request: Request): Response {
  const parsed = ResponseSchema.safeParse(input);
  if (!parsed.success) throw new ContractError('response-shape');
  const r = parsed.data;
  requireInvariant(r.requestId === request.requestId, 'request-id');
  requireInvariant(Buffer.byteLength(JSON.stringify(r)) <= LIMITS.responseBytes, 'response-hard-cap');
  if (r.status === 'error') {
    if (r.error.code === 'CANCELLED') requireInvariant(!r.error.retryable && r.error.nextAction === 'none', 'cancel-no-retry');
    return r;
  }
  requireInvariant(r.scope.workspaceId === request.workspaceId && r.scope.policyId === request.scopePolicyId, 'scope-identity');
  const result = r.result;
  requireInvariant(result.operation === request.operation, 'response-operation');
  const fatalCodes: Issue['code'][] = ['INVALID_REQUEST', 'UNSUPPORTED_VERSION', 'INDEX_MISSING', 'INDEX_INCOMPATIBLE', 'INDEX_UNAVAILABLE'];
  requireInvariant(!r.issues.some(i => fatalCodes.includes(i.code)), 'fatal-is-not-success');
  for (const pattern of [...r.scope.include, ...r.scope.exclude]) byteText(pattern, LIMITS.patternBytes);
  if (result.operation === 'exact' && request.operation === 'exact') {
    chronological(result.source.startedAt, result.source.endedAt);
    requireInvariant(result.matches.length <= request.maxMatches, 'exact-count');
    if (result.coverage.kind === 'partial') partialReasons(result.coverage.reasons, r.issues);
    const interruptions: Issue['code'][] = ['READ_FAILED', 'SOURCE_MUTATED', 'POLICY_CHANGED', 'LIMIT_REACHED', 'BYTE_LIMIT', 'CANCELLED', 'DEADLINE'];
    if (result.coverage.kind === 'complete') {
      requireInvariant(!r.issues.some(i => interruptions.includes(i.code)) && r.scope.counts.failed.value === 0, 'complete-with-failure');
    }
    for (const hit of result.matches) {
      evidenceShape(hit.evidence);
      requireInvariant(hit.provenance.queryKind === request.query.kind, 'query-provenance');
    }
  } else if (result.operation === 'discover' && request.operation === 'discover') {
    const source = result.source;
    chronological(source.scanStartedAt, source.scanEndedAt); chronological(source.scanEndedAt, source.publishedAt);
    const delta = Date.parse(source.observedAt) - Date.parse(source.publishedAt);
    requireInvariant(source.generationAgeMs === Math.max(0, delta) && source.clockSkew === (delta < 0), 'generation-age');
    requireInvariant((source.coverage === 'eligible-scan-incomplete') === (source.failedFiles > 0), 'scan-failure-coverage');
    requireInvariant(result.hits.length <= request.maxHits && result.selection.requestedLimit === request.maxHits, 'ranked-count');
    requireInvariant(result.selection.limitReached === (result.hits.length === request.maxHits), 'ranked-limit');
    requireInvariant(result.selection.degraded === r.issues.some(i => i.code === 'PROVIDER_FAILED'), 'provider-degradation');
    if (result.execution.kind === 'partial') partialReasons(result.execution.reasons, r.issues);
    if (result.execution.kind === 'complete') requireInvariant(!r.issues.some(i => ['BYTE_LIMIT', 'CANCELLED', 'DEADLINE'].includes(i.code)), 'complete-execution-with-interruption');
    result.hits.forEach((hit, index) => {
      evidenceShape(hit.evidence); unique(hit.provenance.map(p => p.kind));
      requireInvariant(hit.generationId === source.generationId && hit.rank === index + 1, 'rank-generation');
      const v = hit.liveVerification;
      requireInvariant(request.verifyLive === (v.kind !== 'not-requested'), 'verification-request');
      if (v.kind === 'matched' || v.kind === 'changed') requireInvariant((v.observedFileSha256 === hit.evidence.fileSha256) === (v.kind === 'matched'), 'verification-digest');
    });
  } else if ((result.operation === 'read-verified' || result.operation === 'read-fresh') && (request.operation === 'read-verified' || request.operation === 'read-fresh')) {
    evidenceShape(result.evidence);
    requireInvariant(result.evidence.path === request.path, 'read-path');
    requireInvariant(result.evidence.range.start === request.range.start && result.evidence.range.end === request.range.end, 'read-range');
    requireInvariant(!result.evidence.excerpt.truncated && result.evidence.excerpt.range.start === request.range.start && result.evidence.excerpt.range.end === request.range.end, 'read-exact-excerpt');
    if (request.operation === 'read-verified') requireInvariant(result.evidence.fileSha256 === request.expectedFileSha256, 'read-revision');
  }
  return r;
}

/** Requires the complete captured file, not a snippet supplied by a model. */
export function assertEvidenceSource(input: unknown, captured: Uint8Array): Evidence {
  const parsed = EvidenceSchema.safeParse(input);
  if (!parsed.success) throw new ContractError('evidence-shape');
  const e = parsed.data;
  evidenceShape(e);
  requireInvariant(captured.byteLength <= LIMITS.fileBytes, 'source-hard-cap');
  requireInvariant(createHash('sha256').update(captured).digest('hex') === e.fileSha256, 'source-digest');
  try { new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(captured); }
  catch { throw new ContractError('source-utf8'); }
  requireInvariant(!captured.includes(0), 'source-binary');
  for (const r of [e.range, e.excerpt.range]) {
    requireInvariant(r.end <= captured.length, 'source-range');
    for (const offset of [r.start, r.end]) {
      const byte = captured[offset];
      requireInvariant(byte === undefined || (byte & 0xc0) !== 0x80, 'utf8-boundary');
    }
  }
  const excerpt = Buffer.from(captured.subarray(e.excerpt.range.start, e.excerpt.range.end));
  requireInvariant(excerpt.equals(Buffer.from(e.excerpt.text, 'utf8')), 'source-excerpt');
  return e;
}
