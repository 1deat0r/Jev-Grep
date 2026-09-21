import { randomUUID } from 'node:crypto';
import { realpath, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { DigestSchema, PathSchema, RangeSchema } from '../contracts/schemas.js';
import { NativeWorker } from '../worker/client.js';
import { createPolicy, fingerprint, narrowPolicy, NarrowSchema } from './policy.js';
import type { Policy } from './policy.js';

export class WorkspaceError extends Error {
  constructor(readonly code: 'INVALID_REQUEST' | 'WORKSPACE_UNAVAILABLE' | 'OUT_OF_SCOPE' | 'REGISTRY_CLOSED' | 'REGISTRY_FULL') {
    super(code); this.name = 'WorkspaceError';
  }
}
const SearchSchema = z.strictObject({
  workspaceId: z.string().uuid(), scopePolicyId: z.string().uuid(),
  pattern: z.string(), kind: z.enum(['literal', 'regex']).default('literal'), caseSensitive: z.boolean().default(true),
  maxMatches: z.int().min(1).max(1000).default(100), deadlineMs: z.int().min(1).max(30_000).default(10_000),
  read: z.strictObject({ path: PathSchema, range: RangeSchema, expectedFileSha256: DigestSchema.optional() }).optional(),
  responseBytes: z.int().min(2048).max(1_048_576).default(65_536), narrow: NarrowSchema.optional(),
});
type Registration = Readonly<{ workspaceId: string; scopePolicyId: string; policyHash: string; policy: Policy }>;
type Entry = { registration: Registration; worker: NativeWorker; rootLease: FileHandle };

/** In-memory authority. Registration is administrative; search accepts IDs, never roots. */
export class WorkspaceRegistry {
  #entries = new Map<string, Entry>();
  #closed = false;
  #registering = 0;
  async register(absoluteRoot: string, policyInput: unknown = {}): Promise<Registration> {
    if (this.#closed) throw new WorkspaceError('REGISTRY_CLOSED');
    if (typeof absoluteRoot !== 'string' || !isAbsolute(absoluteRoot) || absoluteRoot.includes('\0')) throw new WorkspaceError('INVALID_REQUEST');
    let compiled: ReturnType<typeof createPolicy>;
    try { compiled = createPolicy(policyInput); } catch { throw new WorkspaceError('INVALID_REQUEST'); }
    if (this.#entries.size + this.#registering >= 32) throw new WorkspaceError('REGISTRY_FULL');
    this.#registering++;
    let worker: NativeWorker | undefined;
    let rootLease: FileHandle | undefined;
    try {
      const canonical = await realpath(absoluteRoot);
      rootLease = await open(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const before = await rootLease.stat({ bigint: true });
      if (!before.isDirectory()) throw new Error('not directory');
      if (this.#closed) throw new WorkspaceError('REGISTRY_CLOSED');
      worker = new NativeWorker(canonical, undefined, `${before.dev}:${before.ino}`);
      await worker.open();
      const scope = narrowPolicy(compiled.policy);
      const checked = await worker.search({ pattern: 'scope-validation', validateScopeOnly: true,
        maxFileBytes: compiled.policy.maxFileBytes,
        scope: { ...scope, includeGroups: scope.includeGroups.map(g => [...g]), exclude: [...scope.exclude] } });
      if (checked.status !== 'ok') throw new WorkspaceError('INVALID_REQUEST');
      if (this.#closed) throw new WorkspaceError('REGISTRY_CLOSED');
      const registration = Object.freeze({ workspaceId: randomUUID(), scopePolicyId: randomUUID(), ...compiled });
      this.#entries.set(registration.workspaceId, { registration, worker, rootLease });
      return registration;
    } catch (error) {
      worker?.close();
      await rootLease?.close();
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError('WORKSPACE_UNAVAILABLE');
    } finally { this.#registering--; }
  }
  async search(input: unknown, options: { signal?: AbortSignal } = {}) {
    if (this.#closed) throw new WorkspaceError('REGISTRY_CLOSED');
    const parsed = SearchSchema.safeParse(input);
    if (!parsed.success) throw new WorkspaceError('INVALID_REQUEST');
    const request = parsed.data;
    const entry = this.#entries.get(request.workspaceId);
    if (!entry || entry.registration.scopePolicyId !== request.scopePolicyId) throw new WorkspaceError('OUT_OF_SCOPE');
    const scope = narrowPolicy(entry.registration.policy, request.narrow);
    const result = await entry.worker.search({ pattern: request.pattern, kind: request.kind, caseSensitive: request.caseSensitive,
      maxMatches: request.maxMatches, deadlineMs: request.deadlineMs, responseBytes: request.responseBytes,
      maxFileBytes: entry.registration.policy.maxFileBytes,
      ...(request.read ? { read: request.read } : {}),
      scope: { ...scope, includeGroups: scope.includeGroups.map(g => [...g]), exclude: [...scope.exclude] },
    }, options);
    return { workspaceId: request.workspaceId, scopePolicyId: request.scopePolicyId, policyHash: entry.registration.policyHash,
      effectivePolicyHash: fingerprint({ version: 1, policyHash: entry.registration.policyHash, scope }), policy: entry.registration.policy, scope, result };
  }
  unregister(workspaceId: string): void {
    const entry = this.#entries.get(workspaceId);
    if (!entry) throw new WorkspaceError('OUT_OF_SCOPE');
    entry.worker.close(); void entry.rootLease.close().catch(() => {}); this.#entries.delete(workspaceId);
  }
  close(): void {
    this.#closed = true;
    for (const entry of this.#entries.values()) { entry.worker.close(); void entry.rootLease.close().catch(() => {}); }
    this.#entries.clear();
  }
}
