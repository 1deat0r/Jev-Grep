import { z } from 'zod';
import { DigestSchema, PathSchema, RangeSchema } from '../contracts/schemas.js';

const globPatterns = z.array(z.string().min(1).max(1024)).max(64);
export const WorkerScopeSchema = z.strictObject({
  includeGroups: z.array(globPatterns).max(2), exclude: z.array(z.string().min(1).max(1024)).max(128),
  hidden: z.boolean(), respectIgnore: z.boolean(),
});
// Private, versioned prototype protocol. Not the public search API.
export const FRAME_CAP = 1_048_576;
export const WorkerRequestSchema = z.strictObject({
  v: z.literal(1), id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  pattern: z.string().min(1).max(8192), kind: z.enum(['literal', 'regex']), caseSensitive: z.boolean(),
  maxMatches: z.int().min(1).max(1000), maxFileBytes: z.int().min(1).max(16_777_216),
  responseBytes: z.int().min(2048).max(FRAME_CAP), deadlineMs: z.int().min(1).max(30_000),
  scope: WorkerScopeSchema.optional(),
  validateScopeOnly: z.boolean().optional(),
  read: z.strictObject({ path: PathSchema, range: RangeSchema, expectedFileSha256: DigestSchema.optional() }).optional(),
  maxEntries: z.int().min(1).max(100_000), maxDepth: z.int().min(1).max(64),
});
export const WorkerCodeSchema = z.enum(['INVALID_REQUEST', 'REGEX_INVALID', 'MATCH_ENCODING', 'READ_FAILED',
  'SOURCE_MUTATED', 'DEADLINE', 'LIMIT_REACHED', 'BYTE_LIMIT', 'ENTRY_LIMIT', 'DEPTH_LIMIT', 'POLICY_CHANGED', 'OUT_OF_SCOPE', 'REVISION_MISMATCH']);
const natural = z.int().min(0);
const WorkerHitSchema = z.strictObject({
  path: PathSchema, fileSha256: DigestSchema, range: RangeSchema,
  excerpt: z.strictObject({ range: RangeSchema, text: z.string().max(4096), truncated: z.boolean() }),
});
export const WorkerResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ v: z.literal(1), id: z.string().min(1).max(128), status: z.literal('error'), code: WorkerCodeSchema }),
  z.strictObject({
    v: z.literal(1), id: z.string().min(1).max(128), status: z.literal('ok'),
    coverage: z.enum(['complete', 'partial']), reasons: z.array(WorkerCodeSchema).max(14),
    matches: z.array(WorkerHitSchema).max(1000),
    counts: z.strictObject({ visited: natural, searched: natural, excluded: natural, failed: natural, bytesRead: natural }),
    policySnapshotHash: DigestSchema,
    elapsedMs: z.number().min(0), matcherVersion: z.literal('grep-regex-0.1.14'),
  }),
]);
export const WorkerReadySchema = z.strictObject({
  v: z.literal(1), status: z.literal('ready'), pid: z.int().positive(), matcher: z.literal('grep-regex-0.1.14'),
  rootDev: z.string().regex(/^\d+$/), rootIno: z.string().regex(/^\d+$/),
});
export type WorkerRequest = z.infer<typeof WorkerRequestSchema>;
export type WorkerResponse = z.infer<typeof WorkerResponseSchema>;
export type WorkerInput = Pick<WorkerRequest, 'pattern'> & Partial<Omit<WorkerRequest, 'v' | 'id' | 'pattern'>>;

export function validateWorkerResponse(input: unknown, request: WorkerRequest, byteLength: number): WorkerResponse {
  const result = WorkerResponseSchema.parse(input);
  if (result.id !== request.id || byteLength > request.responseBytes) throw new Error('worker response identity/budget');
  if (result.status === 'error') return result;
  if (result.matches.length > request.maxMatches || result.counts.visited > request.maxEntries
    || result.counts.searched > result.counts.visited || result.counts.bytesRead > result.counts.searched * request.maxFileBytes
    || new Set(result.reasons).size !== result.reasons.length
    || (result.coverage === 'complete') !== (result.reasons.length === 0)
    || (result.coverage === 'complete' && result.counts.failed > 0)) throw new Error('worker response invariants');
  for (const h of result.matches) {
    if (h.range.start > h.range.end || h.range.end > request.maxFileBytes
      || h.excerpt.range.start !== h.range.start || h.excerpt.range.end < h.range.start || h.excerpt.range.end > h.range.end
      || !h.excerpt.text.isWellFormed() || Buffer.byteLength(h.excerpt.text) > 4096
      || Buffer.byteLength(h.excerpt.text) !== h.excerpt.range.end - h.excerpt.range.start
      || h.excerpt.truncated !== (h.excerpt.range.end < h.range.end)) throw new Error('worker evidence invariants');
  }
  return result;
}
