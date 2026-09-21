import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

// Synthetic captured bytes only. This does not search or index the user's workspace.
const files = Number(process.argv[2] ?? 1000);
if (!Number.isSafeInteger(files) || files < 1 || files > 10_000) throw new Error('Expected 1..10000 files');
const version = execFileSync('rg', ['--version'], { encoding: 'utf8', timeout: 5000 }).split('\n')[0];
if (!version?.startsWith('ripgrep 15.2.0 ')) throw new Error('Spike requires pinned ripgrep 15.2.0');
const content = Buffer.from(`const needle = 'captured';\n// ${'x'.repeat(4980)}\n`);
const env = { ...process.env, RIPGREP_CONFIG_PATH: '' };
const args = ['--no-config', '--engine=default', '--fixed-strings', '--case-sensitive', '--json', '-e', 'needle'];
let hashes = 0;
const perFileStart = performance.now();
for (let i = 0; i < files; i++) {
  createHash('sha256').update(content).digest('hex'); hashes++;
  const output = execFileSync('rg', [...args, '-'], { input: content, env, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  if (!output.includes('"type":"match"')) throw new Error('Expected synthetic match');
}
const perFileMs = performance.now() - perFileStart;
const temp = await mkdtemp(join(tmpdir(), 'jev-matcher-'));
let stagingMs: number;
let batchedMs: number;
try {
  const stageStart = performance.now();
  for (let i = 0; i < files; i++) {
    createHash('sha256').update(content).digest('hex');
    await writeFile(join(temp, `${i}.ts`), content, { mode: 0o400, flag: 'wx' });
  }
  stagingMs = performance.now() - stageStart;
  const batchStart = performance.now();
  const output = execFileSync('rg', [...args, '--', temp], { env, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  batchedMs = performance.now() - batchStart;
  if (output.split('\n').filter(line => line.startsWith('{"type":"match"')).length !== files) throw new Error('Incomplete batch');
} finally { await rm(temp, { recursive: true, force: true }); }
const report = {
  kind: 'synthetic-feasibility-not-release-acceptance', runAt: new Date().toISOString(), files, bytes: files * content.byteLength, lines: files * 2, hashes,
  fixtureSha256: createHash('sha256').update(content).digest('hex'),
  environment: { node: process.version, kernel: release(), cpu: cpus()[0]?.model, cpus: availableParallelism(), matcher: version },
  perFileHashAndProcessMs: Number(perFileMs.toFixed(3)),
  immutableStagingMs: Number(stagingMs.toFixed(3)), batchedMatchMs: Number(batchedMs.toFixed(3)),
  stagedTotalMs: Number((stagingMs + batchedMs).toFixed(3)),
  limitations: ['One run, no p95 claim', 'Source bytes preallocated; excludes real enumeration and confined reads',
    'Temporary staged copies are a comparison, not the selected production adapter',
    'Reference hardware differs from the specification; not an acceptance benchmark'],
};
await mkdir('spikes/results', { recursive: true });
await writeFile(`spikes/results/matcher-${files}.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
