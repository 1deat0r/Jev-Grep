import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LIMITS } from '../contracts/schemas.js';

const pattern = z.string().min(1).max(1024).refine(p => p.isWellFormed() && Buffer.byteLength(p) <= 1024
  && !/^[!/]|[\\\0\r\n]/u.test(p) && !p.split('/').some(s => s === '' || s === '.' || s === '..'));
const patterns = z.array(pattern).max(64);
export const PolicyInputSchema = z.strictObject({
  include: patterns.default([]), exclude: patterns.default([]), hidden: z.boolean().default(false),
  respectIgnore: z.boolean().default(true), maxFileBytes: z.int().min(1).max(LIMITS.fileBytes).default(1_048_576),
});
export const NarrowSchema = z.strictObject({ include: patterns, exclude: patterns });
export type Narrow = z.infer<typeof NarrowSchema>;
export type Policy = Readonly<{
  version: 1; dialect: 'globset-0.4.20-root-relative'; ignoreDialect: 'ignore-0.4.33-workspace-only';
  include: readonly string[]; exclude: readonly string[]; hidden: boolean; respectIgnore: boolean;
  maxFileBytes: number; symlinks: 'reject'; encoding: 'utf-8'; excludedDirectories: readonly string[];
}>;
const canonicalPatterns = (values: string[]) => Object.freeze([...new Set(values)].sort());
export const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createPolicy(input: unknown = {}): { policy: Policy; policyHash: string } {
  const parsed = PolicyInputSchema.parse(input);
  const policy: Policy = Object.freeze({ version: 1, dialect: 'globset-0.4.20-root-relative',
    ignoreDialect: 'ignore-0.4.33-workspace-only', include: canonicalPatterns(parsed.include),
    exclude: canonicalPatterns(parsed.exclude), hidden: parsed.hidden, respectIgnore: parsed.respectIgnore,
    maxFileBytes: parsed.maxFileBytes, symlinks: 'reject', encoding: 'utf-8', excludedDirectories: Object.freeze(['.git', '.jev-grep']) });
  return { policy, policyHash: fingerprint(policy) };
}
export function narrowPolicy(policy: Policy, input: unknown = { include: [], exclude: [] }) {
  const narrow = NarrowSchema.parse(input);
  // OR within each group, AND across groups. Unioning includes would expand authority.
  return Object.freeze({
    includeGroups: Object.freeze([policy.include, canonicalPatterns(narrow.include)]),
    exclude: Object.freeze([...new Set([...policy.exclude, ...narrow.exclude])].sort()),
    hidden: policy.hidden, respectIgnore: policy.respectIgnore,
  });
}
