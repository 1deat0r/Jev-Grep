import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { AdminRequestSchema, CapabilitiesSchema, EvidenceSchema, RequestSchema, ResponseSchema } from '../src/contracts/schemas.js';

const mode = process.argv[2];
if (mode !== '--write' && mode !== '--check') throw new Error('Use --write or --check');
const schemas = { request: RequestSchema, response: ResponseSchema, evidence: EvidenceSchema, administration: AdminRequestSchema, capabilities: CapabilitiesSchema };
if (mode === '--write') await mkdir('schemas', { recursive: true });
for (const [name, schema] of Object.entries(schemas)) {
  const output = JSON.stringify({
    ...z.toJSONSchema(schema, { target: 'draft-2020-12', reused: 'ref' }),
    $id: `urn:jev-grep:v1:${name}`,
    $comment: 'Structural schema only. Enforce cross-field, UTF-8 byte, source, scope and authorization invariants in the runtime boundary. See docs/CONTRACTS.md.',
  }, null, 2) + '\n';
  const file = `schemas/${name}.schema.json`;
  if (mode === '--write') await writeFile(file, output);
  else if (await readFile(file, 'utf8') !== output) throw new Error(`Schema drift: ${file}`);
}
console.log(mode === '--write' ? 'Schemas generated.' : 'Schemas match the authority.');
