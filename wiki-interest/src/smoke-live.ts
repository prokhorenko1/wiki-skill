import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { analysisSchema } from './analysis.js';
import { asError, AppError } from './errors.js';
import { checkEnvironment } from './environment.js';
import { HttpClient, type Transport } from './http.js';
import { resolutionSchema } from './models.js';
import { executeOperation } from './operations/index.js';
import { readRun, type Services } from './research.js';
import { canonical } from './storage.js';
import type { Output } from './schemas.js';

export function assertSmokeSelection(candidates: z.infer<typeof resolutionSchema>['candidates']) {
  // Фіксована концепція лише для smoke; пошук і незалежна перевірка QID обов’язкові.
  const candidate = candidates.find(c => c.qid === 'Q333' && c.label?.toLowerCase() === 'astronomy' && /celestial|cosmos/i.test(c.description ?? ''));
  if (!candidate) throw new AppError('SMOKE_SELECTION_CHANGED', 'Живий пошук не підтвердив зафіксовану концепцію астрономії Q333 за назвою та описом. Потрібна ручна перевірка, перший результат не вибирається.');
  if (candidate.articles.length !== 1 || candidate.articles.some(a => a.language !== 'uk' || a.status !== 'found')) throw new AppError('SMOKE_ARTICLE_UNAVAILABLE', 'Жива перевірка української статті не завершилася успішно.', { articles: candidate.articles, warnings: candidate.warnings });
  return candidate;
}

export async function runLiveSmoke(services: Services, readiness = () => checkEnvironment()) {
  const smokeId = randomUUID(), startedAt = services.clock.now().toISOString();
  const steps: { operation: string; identifiers: Record<string, string>; status: string }[] = [];
  let logicalRequests = 0, attemptedFollowupRequests = 0;
  const details: Record<string, unknown> = { schemaVersion: '1.0.0', smokeId, startedAt, source: 'wikimedia', steps, expectedConcept: { qid: 'Q333', label: 'astronomy', source: 'https://www.wikidata.org/wiki/Q333' }, modelCalls: 0 };
  let status: 'passed' | 'failed' | 'blocked' = 'failed';
  const transport = services.transport ?? new HttpClient({ maxAttempts: 3, timeoutMs: 15000, log: services.log });
  const counted: Transport = { get: async request => {
    if (++logicalRequests > 90) throw new AppError('SMOKE_REQUEST_BUDGET', 'Smoke зупинено після 90 логічних запитів (до 3 HTTP-спроб кожен).');
    return transport.get(request);
  } };
  const live = { ...services, transport: counted };
  const call = async (operation: string, input: unknown, runId?: string, current: Services = live): Promise<Output> => {
    const output = await executeOperation(operation, input, current, runId);
    steps.push({ operation, identifiers: output.identifiers, status: output.status });
    if (output.error) throw new AppError(output.error.code, output.error.message, output.error.details);
    return output;
  };
  try {
    const environment = await readiness(); details.environment = environment;
    if (!environment.liveReady) {
      const failed = environment.checks.filter(c => c.status === 'blocked');
      throw new AppError(failed[0]?.code ?? 'ENVIRONMENT_BLOCKED', 'Передумови живого сценарію не виконано. Перевірте doctor; fixtures не використовуються.', { checks: failed });
    }
    const resolved = await call('resolve', { query: 'astronomy', queryLanguage: 'en', languages: ['uk'], source: 'live', cachePolicy: 'refresh' });
    const resolution = await services.store.read(['resolutions', `${resolved.identifiers.resolutionId}.json`], resolutionSchema);
    const candidate = assertSmokeSelection(resolution.candidates);
    details.resolutionId = resolution.resolutionId;
    details.searchSources = resolution.snapshots;
    details.selectedCandidate = candidate;
    const analyzed = await call('analyze', { topics: [{ topicId: 'astronomy', label: 'Астрономія', concepts: [{ qid: candidate.qid, resolutionId: resolution.resolutionId }] }], queryLanguage: 'en', languages: ['uk'], source: 'live', cachePolicy: 'refresh', criterion: 'yearOverYear' });
    const runId = analyzed.identifiers.runId!; details.runId = runId;
    const saved = await readRun(runId, services);
    const analysis = await services.store.read(['runs', runId, 'analysis.json'], analysisSchema);
    details.period = saved.dataset.period; details.articles = saved.manifest.topics.map(t => t.coverage.pages);
    details.sources = saved.manifest.snapshots; details.metrics = saved.manifest.report;
    details.findings = analysis.findings; details.quality = analysis.entries.map(e => ({ id: e.id, diagnostic: { status: e.diagnostic.status, reasons: e.diagnostic.reasons } }));
    details.warnings = saved.manifest.warnings;
    if (saved.manifest.source !== 'wikimedia' || !saved.manifest.snapshots.length || saved.manifest.snapshots.some(s => s.origin !== 'wikimedia')) throw new AppError('SMOKE_SOURCE_MISMATCH', 'Живий сценарій не отримав винятково джерела Wikimedia.');
    if (saved.manifest.report.some(r => !r.metrics.quality.complete || r.metrics.yearOverYear.changePercent.value === null || r.metrics.yearOverYear.relativeChangePercent.value === null)) throw new AppError('SMOKE_INCOMPLETE_DATA', 'Живі ряди не дали повного річного й нормалізованого порівняння.', { warnings: saved.manifest.warnings });
    const report = await call('report', {}, runId);
    details.report = { identifiers: report.identifiers, artifacts: report.artifacts, verification: report.summary.verification };
    const withoutNetwork: Services = { ...services, transport: { get: async () => { attemptedFollowupRequests++; throw new AppError('SMOKE_UNEXPECTED_NETWORK', 'Повторний запит спробував використати мережу.'); } } };
    const revised = await call('revise', { changes: { criterion: 'views' } }, runId, withoutNetwork);
    const child = await readRun(revised.identifiers.runId!, services);
    if (child.manifest.dataAccess.fetched !== 0 || canonical(child.dataset) !== canonical(saved.dataset)) throw new AppError('SMOKE_REUSE_FAILED', 'Зміна критерію не зберегла вихідні дані.');
    const english = await call('report', { locale: 'en' }, runId, withoutNetwork);
    if (attemptedFollowupRequests) throw new AppError('SMOKE_UNEXPECTED_NETWORK', 'Повторні операції викликали мережу.');
    details.reuse = { criterionRunId: revised.identifiers.runId, fetched: child.manifest.dataAccess.fetched, localeReportId: english.identifiers.reportId, attemptedNetworkRequests: attemptedFollowupRequests, datasetUnchanged: true };
    status = 'passed';
  } catch (error) {
    const problem = asError(error);
    const blocked = /^(USER_AGENT_|NODE_|DEPENDENCY_|BROWSER_|WRITE_|ENVIRONMENT_|NETWORK_|HTTP_|RATE_LIMITED|SMOKE_ARTICLE_UNAVAILABLE|STORAGE_UNAVAILABLE)/.test(problem.code);
    status = blocked ? 'blocked' : 'failed'; details.error = { code: problem.code, message: problem.message, details: problem.details };
  }
  Object.assign(details, { status, finishedAt: services.clock.now().toISOString(), logicalRequests, attemptedFollowupRequests });
  let artifact: string | null = null;
  try { artifact = await services.store.write(['smoke', smokeId, 'smoke.json'], details); }
  catch (error) { const problem = asError(error); status = 'blocked'; details.persistenceError = { code: problem.code, message: problem.message }; }
  return { status, smokeId, runId: details.runId ?? null, logicalRequests, report: details.report ?? null, reuse: details.reuse ?? null, error: details.error ?? details.persistenceError ?? null, artifact, retryCommand: 'npm run smoke:live' };
}
