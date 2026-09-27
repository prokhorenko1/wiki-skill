import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { executeOperation } from '../src/operations/index.js';
import { createServices, readRun } from '../src/research.js';
import { analysisSchema } from '../src/analysis.js';
import { canonical, sha256 } from '../src/storage.js';
import { idSchema } from '../src/schemas.js';

const { values } = parseArgs({ options: { run: { type: 'string' }, live: { type: 'boolean', default: false } }, strict: true });
const runId = idSchema.parse(values.run), services = createServices(), auditId = randomUUID();
const originalBytes = await services.store.readBytes(['runs', runId, 'manifest.json']);
const parent = await readRun(runId, services), before = await services.store.read(['runs', runId, 'analysis.json'], analysisSchema);
const result = await executeOperation('sources', { mode: 'historical' }, services, runId);
if (!result.identifiers.runId) throw new Error(JSON.stringify(result.error));
const childId = result.identifiers.runId, child = await readRun(childId, services), after = await services.store.read(['runs', childId, 'analysis.json'], analysisSchema);
assert.equal(canonical(parent.dataset), canonical(child.dataset));
assert.equal(canonical(before.entries.map(e => ({ id: e.id, metrics: e.metrics, recovery: e.recovery }))), canonical(after.entries.map(e => ({ id: e.id, metrics: e.metrics, recovery: e.recovery }))));
assert.equal(child.manifest.dataAccess.fetched, 0);
const report = await executeOperation('report', {}, services, childId);
assert.equal(report.error, undefined, JSON.stringify(report.error));
const live: { qid?: string; status: string; result?: unknown }[] = [];
if (values.live) for (const qid of new Set(parent.manifest.topics.flatMap(t => t.candidates.map(c => c.qid)))) {
  const check = await executeOperation('resolve', { qid, queryLanguage: parent.manifest.request.queryLanguage, languages: [...new Set([...parent.manifest.completion?.requestedLanguages ?? [], ...parent.manifest.request.languages])], source: 'live', cachePolicy: 'refresh' }, services);
  live.push({ qid, status: check.error ? 'blocked' : 'passed', result: check });
  if (check.error) break;
}
assert.equal(sha256(await services.store.readBytes(['runs', runId, 'manifest.json'])), sha256(originalBytes));
const audit = { auditId, checkedAt: services.clock.now().toISOString(), scope: 'mapping_metadata_links_only', originalRunId: runId, runId: childId,
  originalManifestChecksum: sha256(originalBytes), unchangedDataset: true, unchangedMetrics: true, unchangedOriginalManifest: true, pageviewsRequestsSent: 0,
  sourceResult: result, report, live: values.live ? live : [{ status: 'not_run' }], nativeModelEvaluation: 'not_run' };
const path = await services.store.write(['audits', auditId, 'sources-audit.json'], audit);
process.stdout.write(JSON.stringify({ status: 'partial', auditId, path, runId: childId, reportId: report.identifiers.reportId, pdf: report.artifacts.find(a => a.kind === 'report.pdf')?.path, verification: report.summary.verification, unchangedDataset: true, unchangedMetrics: true, pageviewsRequestsSent: 0, live: audit.live.map(l => ({ status: l.status })) }) + '\n');
