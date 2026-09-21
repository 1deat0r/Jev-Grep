import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { FRAME_CAP, validateWorkerResponse, WorkerReadySchema, WorkerRequestSchema } from './protocol.js';
import type { WorkerInput, WorkerRequest, WorkerResponse } from './protocol.js';

export class WorkerError extends Error {
  constructor(readonly code: 'CANCELLED' | 'DEADLINE' | 'WORKER_EXIT' | 'WORKER_PROTOCOL' | 'WORKER_BUSY' | 'WORKER_CLOSED' | 'WORKER_RESTARTING' | 'ROOT_CHANGED' | 'INVALID_REQUEST') {
    super(code); this.name = 'WorkerError';
  }
}
type Pending = {
  request: WorkerRequest; startedAt: number; timer: NodeJS.Timeout;
  cleanup: () => void; resolve: (value: WorkerResponse) => void; reject: (error: WorkerError) => void;
};

/** Serial child worker; interruption invalidates the process instead of trusting its IPC loop. */
export class NativeWorker {
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending: Pending | undefined;
  private ready = false;
  private disposed = false;
  private retiring = false;
  private input = Buffer.alloc(0);
  private sequence = 0;
  private rootIdentity: string | undefined;
  readonly binary: string;
  constructor(readonly root: string, binary = resolve('native/worker/target/release/jev-worker-prototype')) {
    if (!isAbsolute(root) || root.includes('\0')) throw new WorkerError('INVALID_REQUEST');
    this.binary = binary;
  }
  get pid(): number | undefined { return this.child?.pid; }

  search(input: WorkerInput, options: { signal?: AbortSignal } = {}): Promise<WorkerResponse> {
    if (this.disposed) return Promise.reject(new WorkerError('WORKER_CLOSED'));
    if (this.pending) return Promise.reject(new WorkerError('WORKER_BUSY'));
    if (this.retiring) return Promise.reject(new WorkerError('WORKER_RESTARTING'));
    if (options.signal?.aborted) return Promise.reject(new WorkerError('CANCELLED'));
    const parsed = WorkerRequestSchema.omit({ v: true, id: true }).safeParse({
      kind: 'literal', caseSensitive: true,
      maxMatches: 100, maxFileBytes: 1_048_576, responseBytes: 65_536, deadlineMs: 10_000,
      maxEntries: 100_000, maxDepth: 64, ...input,
    });
    if (!parsed.success || !parsed.data.pattern.isWellFormed() || Buffer.byteLength(parsed.data.pattern) > 8192
      || /[\r\n\0]/u.test(parsed.data.pattern)) return Promise.reject(new WorkerError('INVALID_REQUEST'));
    const request: WorkerRequest = { ...parsed.data, v: 1, id: `q-${++this.sequence}` };
    const startedAt = performance.now();
    return new Promise((resolvePromise, rejectPromise) => {
      const abort = () => this.fail('CANCELLED');
      const timer = setTimeout(() => this.fail('DEADLINE'), request.deadlineMs);
      this.pending = {
        request, startedAt, timer, resolve: resolvePromise, reject: rejectPromise,
        cleanup: () => options.signal?.removeEventListener('abort', abort),
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) { this.fail('CANCELLED'); return; }
      if (!this.child) this.start();
      else if (this.ready) this.send();
    });
  }
  private start(): void {
    this.input = Buffer.alloc(0); this.ready = false;
    const child = spawn(this.binary, [this.root], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LANG: 'C.UTF-8' } });
    this.child = child;
    child.stderr.resume(); // Drain bounded by the OS; never copy source-bearing diagnostics into errors/logs.
    child.on('error', () => { if (this.child === child) this.fail('WORKER_EXIT'); });
    child.stdin.on('error', () => { if (this.child === child) this.fail('WORKER_EXIT'); });
    child.on('close', () => { if (this.child === child) this.fail('WORKER_EXIT'); });
    child.stdout.on('data', (data: Buffer) => {
      if (this.child !== child) return;
      try {
        if (this.input.length + data.length > FRAME_CAP + 4) throw new Error('frame cap');
        this.input = Buffer.concat([this.input, data]);
        while (this.input.length >= 4) {
          const size = this.input.readUInt32BE(0);
          if (size === 0 || size > FRAME_CAP) throw new Error('invalid frame');
          if (this.input.length < size + 4) break;
          const frame = this.input.subarray(4, size + 4);
          this.input = this.input.subarray(size + 4);
          const message: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame));
          if (!this.ready) {
            const hello = WorkerReadySchema.parse(message);
            if (hello.pid !== child.pid) throw new Error('pid mismatch');
            const identity = `${hello.rootDev}:${hello.rootIno}`;
            if (this.rootIdentity !== undefined && this.rootIdentity !== identity) { this.fail('ROOT_CHANGED'); return; }
            this.rootIdentity = identity; this.ready = true; this.send();
          } else {
            const pending = this.pending;
            if (!pending) throw new Error('unsolicited frame');
            const response = validateWorkerResponse(message, pending.request, size);
            if (performance.now() - pending.startedAt >= pending.request.deadlineMs) { this.fail('DEADLINE'); return; }
            clearTimeout(pending.timer); pending.cleanup(); this.pending = undefined;
            pending.resolve(response);
          }
        }
      } catch { this.fail('WORKER_PROTOCOL'); }
    });
  }
  private send(): void {
    const pending = this.pending;
    if (!pending || !this.child) return;
    const remaining = Math.floor(pending.request.deadlineMs - (performance.now() - pending.startedAt));
    if (remaining <= 0) { this.fail('DEADLINE'); return; }
    const body = Buffer.from(JSON.stringify({ ...pending.request, deadlineMs: remaining }));
    const frame = Buffer.allocUnsafe(body.length + 4);
    frame.writeUInt32BE(body.length); body.copy(frame, 4);
    this.child.stdin.write(frame);
  }
  private fail(code: WorkerError['code']): void {
    const child = this.child;
    this.child = undefined; this.ready = false; this.input = Buffer.alloc(0);
    if (child && child.exitCode === null && child.signalCode === null) {
      this.retiring = true;
      child.once('close', () => { this.retiring = false; });
      child.kill('SIGKILL');
    }
    const pending = this.pending; this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.cleanup(); pending.reject(new WorkerError(code)); }
  }
  close(): void { this.disposed = true; this.fail('WORKER_CLOSED'); }
}
