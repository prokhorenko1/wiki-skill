import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixtureTransport } from '../src/fixtures.js';
import { createServices } from '../src/research.js';
import { FileStore } from '../src/storage.js';
import { runLiveSmoke } from '../src/smoke-live.js';
import { skillRoot, runtimeRoot } from '../src/environment.js';
import { runTopicSmoke } from '../src/smoke-topic.js';

it('тематичний live smoke із порожнім явним ENV blocked до мережі', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'wiki-topic-blocked-'));
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'));
  vi.stubEnv('WIKIMEDIA_USER_AGENT', '');
  try {
    const result = await runTopicSmoke(createServices({ store: new FileStore(root), log: () => {} }));
    expect(result).toMatchObject({ status: 'blocked', logicalRequests: 0, runId: null, error: { code: 'USER_AGENT_INVALID' } });
    expect(fetch).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); fetch.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

it('перевіряє оркестрацію smoke на явному mock transport, включно з PDF і повторними запитами; це НЕ live-тест', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'wiki-interest-smoke-mock-'));
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'));
  const fixtures = new FixtureTransport();
  const services = createServices({ store: new FileStore(root), clock: { now: () => new Date('2023-01-15T12:00:00Z') }, log: () => {}, transport: { get: async request => {
    const response = await fixtures.get(request);
    if (request.kind === 'entity') {
      const body = JSON.parse(response.body);
      body.entities[request.qid].labels.en = { language: 'en', value: 'astronomy' };
      body.entities[request.qid].descriptions.en = { language: 'en', value: 'MOCK: science of celestial objects' };
      response.body = JSON.stringify(body);
    }
    return response;
  } } });
  try {
    const result = await runLiveSmoke(services, async () => ({ schemaVersion: '1.0.0', nodeVersion: '24.21.0', skillRoot, runtimeRoot, offlineReady: true, liveReady: true, wikimediaIdentity: { source: 'application', detail: 'mock', valid: true }, checks: [] }));
    expect(result, JSON.stringify(result.error)).toMatchObject({ status: 'passed', logicalRequests: 57, reuse: { fetched: 0, attemptedNetworkRequests: 0, datasetUnchanged: true } });
    const saved = JSON.parse(await readFile(result.artifact!, 'utf8'));
    expect(saved.period).toEqual({ start: '2021-01-01', end: '2022-12-31' });
    expect(saved.report.verification).toMatchObject({ pages: 1, pdfRendered: true });
    expect(saved.findings.find((f: { type: string }) => f.type === 'annual_change').value).toBe(100);
    expect(saved.findings.find((f: { type: string }) => f.type === 'relative_change').value).toBeCloseTo(-20, 8);
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); await rm(root, { recursive: true, force: true }); }
}, 30000);
