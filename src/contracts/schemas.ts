import { z } from 'zod';

/** Structural authority. Cross-field/source invariants live in validation.ts. */
export const LIMITS = Object.freeze({
  hits: 1_000, responseBytes: 1_048_576, fileBytes: 16_777_216,
  queryBytes: 8_192, anchorBytes: 256, patternBytes: 1_024,
  deadlineMs: 30_000, excerptBytes: 4_096,
});
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.iso.datetime();
const count = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = z.int().min(1);
export const PathSchema = z.string().min(1).max(4096)
  .regex(/^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[^\u0000\\\r\n/]+(?:\/[^\u0000\\\r\n/]+)*$/);
export const RangeSchema = z.strictObject({ start: count, end: count });
const patterns = z.array(z.string().min(1).max(LIMITS.patternBytes)).max(64);
const envelope = {
  version: z.literal(1), requestId: id, workspaceId: id, scopePolicyId: id,
  narrow: z.strictObject({ include: patterns, exclude: patterns }).optional(),
};
export const ExactRequestSchema = z.strictObject({
  ...envelope, operation: z.literal('exact'),
  query: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('literal'), text: z.string().min(1).max(LIMITS.queryBytes), caseSensitive: z.boolean() }),
    z.strictObject({ kind: z.literal('regex'), pattern: z.string().min(1).max(LIMITS.queryBytes), caseSensitive: z.boolean() }),
  ]),
  maxMatches: positive.max(LIMITS.hits),
});
export const DiscoveryRequestSchema = z.strictObject({
  ...envelope, operation: z.literal('discover'),
  question: z.string().min(1).max(LIMITS.queryBytes),
  anchors: z.array(z.string().min(1).max(LIMITS.anchorBytes)).max(16),
  maxHits: positive.max(LIMITS.hits), verifyLive: z.boolean(),
});
const readFields = { ...envelope, path: PathSchema, range: RangeSchema, byteBudget: positive.max(LIMITS.responseBytes) };
export const ReadVerifiedRequestSchema = z.strictObject({
  ...readFields, operation: z.literal('read-verified'), expectedFileSha256: DigestSchema,
});
export const ReadFreshRequestSchema = z.strictObject({ ...readFields, operation: z.literal('read-fresh') });
export const RequestSchema = z.discriminatedUnion('operation', [
  ExactRequestSchema, DiscoveryRequestSchema, ReadVerifiedRequestSchema, ReadFreshRequestSchema,
]);

export const IssueCodeSchema = z.enum([
  'INVALID_REQUEST', 'UNSUPPORTED_VERSION', 'UNAVAILABLE', 'OUT_OF_SCOPE',
  'REVISION_MISMATCH', 'READ_FAILED', 'SOURCE_MUTATED', 'POLICY_CHANGED',
  'LIMIT_REACHED', 'BYTE_LIMIT', 'CANCELLED', 'DEADLINE', 'INDEX_MISSING',
  'INDEX_INCOMPATIBLE', 'INDEX_UNAVAILABLE', 'INDEX_BUSY', 'STORAGE_FULL',
  'PROVIDER_FAILED', 'EGRESS_DENIED', 'CAPABILITY_UNAVAILABLE',
]);
export const IssueSchema = z.strictObject({
  code: IssueCodeSchema,
  stage: z.enum(['validation', 'workspace', 'read', 'match', 'index', 'retrieval', 'verify', 'provider', 'queue', 'serialization']),
  retryable: z.boolean(), message: z.string().min(1).max(512), path: PathSchema.optional(),
  nextAction: z.enum(['narrow-scope', 'retry-once', 'use-exact', 'request-index-create', 'request-rebuild', 'free-storage', 'fix-request', 'none']),
});
const reportedCount = z.union([
  z.strictObject({ value: count, reason: z.null() }),
  z.strictObject({ value: z.null(), reason: z.string().min(1).max(256) }),
]);
export const EffectiveScopeSchema = z.strictObject({
  workspaceId: id, policyId: id, policyHash: DigestSchema,
  include: patterns, exclude: patterns,
  respectIgnore: z.boolean(), hidden: z.boolean(), symlinks: z.literal('reject'),
  encoding: z.literal('utf-8'), maxFileBytes: positive.max(LIMITS.fileBytes),
  counts: z.strictObject({
    searched: reportedCount, indexed: reportedCount, excluded: reportedCount,
    unsupported: reportedCount, oversized: reportedCount, failed: reportedCount,
  }),
});
export const EvidenceSchema = z.strictObject({
  id, path: PathSchema, fileSha256: DigestSchema, range: RangeSchema,
  excerpt: z.strictObject({ range: RangeSchema, text: z.string().max(LIMITS.excerptBytes), truncated: z.boolean() }),
});
export const LiveVerificationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('not-requested') }),
  z.strictObject({ kind: z.literal('matched'), checkedAt: time, observedFileSha256: DigestSchema }),
  z.strictObject({ kind: z.literal('changed'), checkedAt: time, observedFileSha256: DigestSchema }),
  z.strictObject({ kind: z.literal('unavailable'), checkedAt: time, issue: IssueSchema }),
]);
const exactMatch = z.strictObject({
  evidence: EvidenceSchema,
  provenance: z.strictObject({ kind: z.literal('exact'), queryKind: z.enum(['literal', 'regex']), matcherVersion: id }),
});
const rankedHit = z.strictObject({
  evidence: EvidenceSchema, generationId: id, rank: positive.max(LIMITS.hits),
  liveVerification: LiveVerificationSchema,
  provenance: z.array(z.strictObject({ kind: z.enum(['lexical', 'vector']), configFingerprint: DigestSchema })).min(1).max(2),
});
const exactReason = z.enum(['limit', 'cancelled', 'read-failure', 'deadline', 'policy-changed', 'source-mutated']);
export const ExactResultSchema = z.strictObject({
  operation: z.literal('exact'),
  source: z.strictObject({ kind: z.literal('live-read'), startedAt: time, endedAt: time }),
  coverage: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('complete') }),
    z.strictObject({ kind: z.literal('partial'), reasons: z.array(exactReason).min(1).max(6) }),
  ]),
  matches: z.array(exactMatch).max(LIMITS.hits),
});
const updateOutcome = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('never-attempted') }),
  z.strictObject({ kind: z.literal('succeeded'), attemptId: id, completedAt: time }),
  z.strictObject({ kind: z.literal('failed'), attemptId: id, completedAt: time, issue: IssueSchema }),
]);
export const DiscoveryResultSchema = z.strictObject({
  operation: z.literal('discover'),
  source: z.strictObject({
    kind: z.literal('index'), generationId: id, manifestHash: DigestSchema,
    publishedAt: time, scanStartedAt: time, scanEndedAt: time,
    coverage: z.enum(['eligible-scan-complete', 'eligible-scan-incomplete']), failedFiles: count,
    observedAt: time, generationAgeMs: count, clockSkew: z.boolean(), lastUpdateOutcome: updateOutcome,
  }),
  selection: z.strictObject({ kind: z.literal('ranked'), requestedLimit: positive.max(LIMITS.hits), limitReached: z.boolean(), degraded: z.boolean() }),
  execution: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('complete') }),
    z.strictObject({ kind: z.literal('partial'), reasons: z.array(z.enum(['byte-limit', 'cancelled', 'deadline'])).min(1).max(3) }),
  ]),
  hits: z.array(rankedHit).max(LIMITS.hits),
});
const ReadResultSchema = z.strictObject({
  operation: z.enum(['read-verified', 'read-fresh']), evidence: EvidenceSchema,
  capturedAt: time,
});
export const ResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ version: z.literal(1), requestId: id, status: z.literal('error'), error: IssueSchema }),
  z.strictObject({
    version: z.literal(1), requestId: id, status: z.literal('ok'), scope: EffectiveScopeSchema,
    issues: z.array(IssueSchema).max(128),
    result: z.union([ExactResultSchema, DiscoveryResultSchema, ReadResultSchema]),
  }),
]);

// Administrative transport contracts are declared here; no operation is executed.
export const AdminRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ version: z.literal(1), requestId: id, operation: z.literal('register'), absoluteRoot: z.string().min(1).max(4096).regex(/^\//) }),
  z.strictObject({ ...envelope, operation: z.literal('index-create'), refreshMode: z.enum(['manual', 'enabled']), configFingerprint: DigestSchema }),
  z.strictObject({ ...envelope, operation: z.literal('index-refresh') }),
  z.strictObject({ ...envelope, operation: z.literal('index-rebuild'), configFingerprint: DigestSchema }),
  z.strictObject({ ...envelope, operation: z.literal('index-migrate'), targetFormat: positive }),
]);
export const CapabilitiesSchema = z.strictObject({
  version: z.literal(1), supportedVersions: z.array(z.literal(1)).length(1),
  operations: z.array(z.enum(['exact', 'discover', 'read-verified', 'read-fresh'])).max(4),
  indexState: z.enum(['missing', 'ready', 'incompatible', 'unavailable']),
  migration: z.literal('unavailable'), remoteProviders: z.literal('disabled'),
  regexDialect: z.literal('ripgrep-default-line-oriented'), matcherVersion: id,
});

export type Request = z.infer<typeof RequestSchema>;
export type Response = z.infer<typeof ResponseSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Issue = z.infer<typeof IssueSchema>;
export type ByteRange = z.infer<typeof RangeSchema>;
