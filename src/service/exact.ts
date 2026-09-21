import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { RequestContextSchema } from '../contracts/schemas.js';
import type { Evidence, Issue, Request, Response } from '../contracts/schemas.js';
import { parseRequest, parseResponse } from '../contracts/validation.js';
import { WorkspaceRegistry, WorkspaceError } from '../workspace/registry.js';
import { fingerprint } from '../workspace/policy.js';
import { WorkerError } from '../worker/client.js';

type Scoped = Awaited<ReturnType<WorkspaceRegistry['search']>>;
const requestIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const mappings: Record<string, Issue['code']> = {
  REGEX_INVALID: 'INVALID_REQUEST', MATCH_ENCODING: 'CAPABILITY_UNAVAILABLE',
  ENTRY_LIMIT: 'LIMIT_REACHED', DEPTH_LIMIT: 'LIMIT_REACHED',
  WORKER_EXIT: 'UNAVAILABLE', WORKER_PROTOCOL: 'UNAVAILABLE', WORKER_BUSY: 'UNAVAILABLE',
  WORKER_CLOSED: 'UNAVAILABLE', WORKER_RESTARTING: 'UNAVAILABLE', ROOT_CHANGED: 'UNAVAILABLE',
  WORKSPACE_UNAVAILABLE: 'UNAVAILABLE', REGISTRY_CLOSED: 'UNAVAILABLE',
};
const codes = new Set<string>(['UNSUPPORTED_VERSION', 'INVALID_REQUEST', 'OUT_OF_SCOPE', 'REVISION_MISMATCH', 'READ_FAILED', 'SOURCE_MUTATED', 'POLICY_CHANGED', 'LIMIT_REACHED', 'BYTE_LIMIT', 'CANCELLED', 'DEADLINE']);
function issue(code: string): Issue {
  const mapped = mappings[code] ?? (codes.has(code) ? code as Issue['code'] : 'UNAVAILABLE');
  return { code: mapped, stage: ['INVALID_REQUEST', 'UNSUPPORTED_VERSION'].includes(mapped) ? 'validation' : 'workspace', retryable: false,
    message: mapped, nextAction: mapped === 'INVALID_REQUEST' ? 'fix-request' : 'none' };
}
const reasons: Partial<Record<Issue['code'], 'limit' | 'cancelled' | 'read-failure' | 'deadline' | 'policy-changed' | 'source-mutated'>> = {
  LIMIT_REACHED: 'limit', BYTE_LIMIT: 'limit', CANCELLED: 'cancelled', READ_FAILED: 'read-failure',
  DEADLINE: 'deadline', POLICY_CHANGED: 'policy-changed', SOURCE_MUTATED: 'source-mutated',
};
function evidence(scoped: Scoped, hit: Omit<Evidence, 'id'>): Evidence {
  return { id: fingerprint({ version: 1, workspaceId: scoped.workspaceId, policyHash: scoped.policyHash,
    path: hit.path, fileSha256: hit.fileSha256, range: hit.range }), ...hit };
}
function scope(scoped: Scoped): Extract<Response, { status: 'ok' }>['scope'] {
  const known = (value: number) => ({ value, reason: null });
  const unknown = (reason: string) => ({ value: null, reason });
  const result = scoped.result;
  if (result.status !== 'ok') throw new Error('scope requires success');
  return { workspaceId: scoped.workspaceId, policyId: scoped.scopePolicyId, policyHash: scoped.policyHash,
    include: [...(scoped.scope.includeGroups[1]?.length ? scoped.scope.includeGroups[1] : scoped.policy.include)],
    includeGroups: scoped.scope.includeGroups.map(g => [...g]), exclude: [...scoped.scope.exclude],
    effectivePolicyHash: scoped.effectivePolicyHash, policySnapshotHash: result.policySnapshotHash,
    hidden: scoped.policy.hidden, respectIgnore: scoped.policy.respectIgnore, symlinks: 'reject', encoding: 'utf-8',
    maxFileBytes: scoped.policy.maxFileBytes,
    counts: { searched: known(result.counts.searched), failed: known(result.counts.failed),
      indexed: unknown('No index is consulted'), excluded: unknown('Worker counts pruned entries, not excluded descendant files'),
      unsupported: unknown('Worker exclusions are not yet categorized'), oversized: unknown('Worker exclusions are not yet categorized') } };
}

/** Shared in-process exact/read boundary. Transport adapters remain separate work. */
export class ExactService {
  readonly #caps: z.infer<typeof RequestContextSchema>;
  constructor(readonly registry: WorkspaceRegistry, deploymentCaps: unknown = {}) {
    const partial = z.strictObject({ deadlineMs: z.number().optional(), responseBytes: z.number().optional() }).parse(deploymentCaps);
    this.#caps = Object.freeze(RequestContextSchema.parse({ deadlineMs: partial.deadlineMs ?? 30_000, responseBytes: partial.responseBytes ?? 1_048_576 }));
  }
  async execute(input: unknown, contextInput: unknown = {}, options: { signal?: AbortSignal } = {}): Promise<Response> {
    const started = performance.now(); const startedAt = new Date().toISOString();
    let request: Request;
    let context: z.infer<typeof RequestContextSchema>;
    try { request = parseRequest(input); context = RequestContextSchema.parse(contextInput); }
    catch {
      const candidate = input && typeof input === 'object' && 'requestId' in input ? input.requestId : undefined;
      const id = requestIdSchema.safeParse(candidate);
      return { version: 1, requestId: id.success ? id.data : 'invalid', status: 'error', error: issue(input && typeof input === 'object' && 'version' in input && input.version !== 1 ? 'UNSUPPORTED_VERSION' : 'INVALID_REQUEST') };
    }
    context.deadlineMs = Math.min(context.deadlineMs, this.#caps.deadlineMs);
    context.responseBytes = Math.min(context.responseBytes, this.#caps.responseBytes);
    const error = (code: string): Response => parseResponse({ version: 1, requestId: request.requestId, status: 'error', error: issue(code) }, request);
    if (options.signal?.aborted) return error('CANCELLED');
    if (request.operation === 'discover') return { version: 1, requestId: request.requestId, status: 'error', error: { ...issue('UNAVAILABLE'), code: 'CAPABILITY_UNAVAILABLE' } };
    try {
      const remaining = Math.floor(context.deadlineMs - (performance.now() - started));
      if (remaining < 1) return error('DEADLINE');
      const scoped = await this.registry.search({ workspaceId: request.workspaceId, scopePolicyId: request.scopePolicyId,
        ...(request.narrow ? { narrow: request.narrow } : {}), deadlineMs: remaining, responseBytes: context.responseBytes,
        ...(request.operation === 'exact'
          ? { pattern: request.query.kind === 'literal' ? request.query.text : request.query.pattern, kind: request.query.kind,
              caseSensitive: request.query.caseSensitive, maxMatches: request.maxMatches }
          : { pattern: 'scoped-read', read: { path: request.path, range: request.range,
              ...(request.operation === 'read-verified' ? { expectedFileSha256: request.expectedFileSha256 } : {}) } }),
      }, options);
      if (options.signal?.aborted) return error('CANCELLED');
      if (performance.now() - started >= context.deadlineMs) return error('DEADLINE');
      const native = scoped.result;
      if (native.status === 'error') return error(native.code);
      const issues = native.reasons.map(issue).filter((item, index, all) => all.findIndex(other => other.code === item.code) === index);
      let response: Extract<Response, { status: 'ok' }>;
      if (request.operation === 'exact') {
        const partialReasons = [...new Set(issues.flatMap(i => reasons[i.code] ? [reasons[i.code]!] : []))];
        response = { version: 1, requestId: request.requestId, status: 'ok', scope: scope(scoped), issues,
          result: { operation: 'exact', source: { kind: 'live-read', startedAt, endedAt: new Date(Math.max(Date.parse(startedAt), Date.now())).toISOString() },
            coverage: partialReasons.length ? { kind: 'partial', reasons: partialReasons } : { kind: 'complete' },
            matches: native.matches.map(hit => ({ evidence: evidence(scoped, hit), provenance: { kind: 'exact', queryKind: request.query.kind, matcherVersion: native.matcherVersion } })) } };
        if (Buffer.byteLength(JSON.stringify(response)) > context.responseBytes && response.result.operation === 'exact') {
          if (!response.issues.some(i => i.code === 'BYTE_LIMIT')) response.issues.push(issue('BYTE_LIMIT'));
          response.result.coverage = { kind: 'partial', reasons: [...new Set([...partialReasons, 'limit' as const])] };
          const matches = response.result.matches;
          let low = 0; let high = matches.length;
          while (low < high) {
            if (performance.now() - started >= context.deadlineMs) return error('DEADLINE');
            const middle = Math.ceil((low + high) / 2);
            response.result.matches = matches.slice(0, middle);
            if (Buffer.byteLength(JSON.stringify(response)) <= context.responseBytes) low = middle;
            else high = middle - 1;
          }
          response.result.matches = matches.slice(0, low);
        }
      } else {
        const hit = native.matches[0]; if (!hit) return error('READ_FAILED');
        response = { version: 1, requestId: request.requestId, status: 'ok', scope: scope(scoped), issues,
          result: { operation: request.operation, evidence: evidence(scoped, hit), capturedAt: new Date().toISOString() } };
      }
      if (Buffer.byteLength(JSON.stringify(response)) > context.responseBytes) return error('BYTE_LIMIT');
      const validated = parseResponse(response, request);
      if (performance.now() - started >= context.deadlineMs) return error('DEADLINE');
      return validated;
    } catch (caught) {
      if (caught instanceof WorkspaceError || caught instanceof WorkerError) return error(caught.code);
      return error('UNAVAILABLE');
    }
  }
}
