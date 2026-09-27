import { readFile } from 'node:fs/promises';
import { executeOperation } from '../src/operations/index.js';
import { createServices } from '../src/research.js';

const input: unknown = JSON.parse(await readFile(new URL('../examples/demo-offline.json', import.meta.url), 'utf8'));
const services = createServices({ clock: { now: () => new Date('2023-01-15T12:00:00Z') } });
const analyzed = await executeOperation('analyze', input, services);
const inspected = analyzed.status === 'error' ? analyzed : await executeOperation('inspect', { verifySnapshots: true }, services, analyzed.identifiers.runId);
const result = inspected.status === 'error' ? inspected : await executeOperation('report', {}, services, analyzed.identifiers.runId);
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status === 'error') process.exitCode = 1;
