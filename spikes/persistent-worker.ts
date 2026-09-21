import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir, cpus, release } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { NativeWorker } from '../src/worker/client.js';

const files = Number(process.argv[2] ?? 10_000);
const samples = Number(process.argv[3] ?? 200);
assert(Number.isInteger(files) && files > 0 && files <= 10_000);
assert(Number.isInteger(samples) && samples > 0 && samples <= 1000);
const root = await mkdtemp(join(tmpdir(), 'jev-worker-bench-'));
const worker = new NativeWorker(root);
const timings: number[] = [];
let coldMs = 0;
try {
  for (let i = 0; i < files; i++) {
    const header = `group-${String(i % 1000).padStart(4, '0')}\n`;
    await writeFile(join(root, `file-${i}.txt`), header + 'x'.repeat(5119 - header.length) + '\n');
  }
  const run = async (i: number): Promise<number> => {
    const positive = i % 2 === 0;
    const group = i % 1000;
    const pattern = positive ? `group-${String(group).padStart(4, '0')}` : `absent-${i}`;
    const start = performance.now();
    const response = await worker.search({ pattern, deadlineMs: 30_000 });
    const ms = performance.now() - start;
    assert.equal(response.status, 'ok');
    assert.equal(response.coverage, 'complete');
    assert.equal(response.counts.searched, files);
    assert.equal(response.counts.bytesRead, files * 5120);
    assert.equal(response.matches.length, positive && group < files ? Math.floor((files - 1 - group) / 1000) + 1 : 0);
    return ms;
  };
  coldMs = await run(0);
  const pid = worker.pid;
  for (let i = 0; i < 10; i++) await run(i);
  for (let i = 0; i < samples; i++) {
    timings.push(await run(i)); assert.equal(worker.pid, pid);
    if ((i + 1) % 25 === 0) process.stderr.write(`${i + 1}/${samples} samples\n`);
  }
  const sorted = [...timings].sort((a,b) => a-b);
  const percentile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1]!;
  const memory = await readFile(`/proc/${pid}/status`, 'utf8');
  const report = {
    fixture: 'generated synthetic ASCII, no user data', files, bytes: files * 5120, lines: files * 2,
    samples, warmups: 10, coldMs, p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99),
    warmP95Under500Ms: percentile(.95) <= 500, failures: 0,
    scope: 'Parent request through response validation; fresh enumeration, confined capture, SHA-256, matching and IPC on every request',
    limitations: 'Prototype excludes hidden files; no ignore/glob policy, public transport or persistent index; synthetic workload on uncalibrated host, not release acceptance',
    environment: { node: process.version, kernel: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, matcher: 'grep-regex-0.1.14', workerVmHwm: memory.match(/^VmHWM:.*$/m)?.[0] },
    timingsMs: timings,
  };
  await mkdir('spikes/results', { recursive: true });
  await writeFile(`spikes/results/persistent-worker-${files}.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ files, samples, coldMs, p50Ms: report.p50Ms, p95Ms: report.p95Ms, p99Ms: report.p99Ms }));
} finally { worker.close(); await rm(root, { recursive: true, force: true }); }
