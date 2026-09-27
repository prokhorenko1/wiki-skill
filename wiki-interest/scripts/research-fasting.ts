import { randomUUID } from 'node:crypto';
import { executeOperation } from '../src/operations/index.js';
import { createServices } from '../src/research.js';
import { checkEnvironment } from '../src/environment.js';
import { HttpClient } from '../src/http.js';

// Перевірений зміст URL — intermittent fasting; QID і мовні статті щоразу перевіряє API.
const services = createServices({ transport: new HttpClient() });
const scenarioId = randomUUID(), environment = await checkEnvironment();
let result;
if (!environment.liveReady) {
  result = { status: 'blocked', scenarioId, checks: environment.checks.filter(c => c.status === 'blocked'), runId: null, reportPdf: null, networkRequests: 0 };
} else {
  const resolved = await executeOperation('resolve', { articleUrl: 'https://en.wikipedia.org/wiki/Intermittent_fasting', queryLanguage: 'uk', languages: ['pl', 'cs'] }, services);
  const candidate = (resolved.summary.candidates as { qid: string }[] | undefined)?.[0];
  if (resolved.status !== 'ok' || !candidate) result = { status: 'blocked', scenarioId, resolution: resolved };
  else {
    const research = await executeOperation('research', { analysis: { mode: 'article', topics: [{ topicId: 'intermittent-fasting', label: 'Інтервальне голодування', concepts: [{ qid: candidate.qid, resolutionId: resolved.identifiers.resolutionId }] }], languages: ['pl', 'cs'], queryLanguage: 'uk', criterion: 'yearOverYear' } }, services);
    result = { status: research.summary.executionStatus === 'completed' ? 'passed' : 'blocked', scenarioId, research };
  }
}
const path = await services.store.write(['smoke', scenarioId, 'research-fasting.json'], result);
process.stdout.write(`${JSON.stringify({ ...result, artifact: path })}\n`);
if (result.status !== 'passed') process.exitCode = 1;
