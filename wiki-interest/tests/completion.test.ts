import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServices, readRun, type Services } from '../src/research.js';
import { FileStore } from '../src/storage.js';
import { FixtureTransport } from '../src/fixtures.js';
import { executeOperation } from '../src/operations/index.js';
import { analysisSchema } from '../src/analysis.js';
import { AppError } from '../src/errors.js';

const analysis = { mode: 'article', source: 'fixtures', fixtureId: 'demo-v1', topics: [{ topicId: 'physics', label: 'Фізика — тестова вибірка', concepts: [{ qid: 'Q413' }] }], languages: ['pl', 'cs'], period: { start: '2021-01-01', end: '2022-12-31' } };
describe('Research: доступні гілки, зіставлення, кеш, звіт', () => {
  let services: Services, root: string;
  beforeEach(async () => { root = await mkdtemp(join(await realpath(tmpdir()), 'wiki-completion-')); services = createServices({ store: new FileStore(root), clock: { now: () => new Date('2023-01-15T00:00:00Z') }, log: () => {} }); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  it('обидві мови доступні — немає додаткових, усі 7 findings потрапляють у PDF', async () => {
    const r = await executeOperation('research', { analysis: { ...analysis, topics: [{ topicId: 'astronomy', label: 'Астрономія', concepts: [{ qid: 'Q333' }] }] } }, services);
    expect(r.error).toBeUndefined(); expect(r.summary.executionStatus, JSON.stringify(r.summary.blocker)).toBe('completed');
    expect(r.summary.requestCompletion).toBe('complete');
    expect(r.summary.supplementalComparison).toMatchObject({ languages: [] });
    const manifest = await services.store.readBytes(['reports', r.identifiers.runId!, r.identifiers.reportId!, 'manifest.json']);
    expect(JSON.parse(manifest.toString()).omittedFindings).toEqual([]);
    const report = r.summary.report as { verification: { pages: number } }; expect(report.verification.pages).toBe(3);
  }, 30000);
  it('недоступна cs залишається недоступною; pl плюс окреме uk, без позитивного відбору', async () => {
    const r = await executeOperation('research', { analysis, supplementalPriority: ['uk'] }, services);
    expect(r.status).toBe('partial'); expect(r.summary.executionStatus, JSON.stringify(r.summary.blocker)).toBe('completed');
    expect(r.summary.requestedResult).toMatchObject({ requestedLanguages: ['pl', 'cs'], analyzedRequestedLanguages: ['pl'], unavailableLanguages: [{ language: 'cs', code: 'EQUIVALENT_NOT_FOUND' }] });
    expect(r.summary.supplementalComparison).toMatchObject({ languages: ['uk'] });
    const run = await readRun(r.identifiers.runId!, services);
    expect(run.manifest.topics[0]!.coverage.includedQids).toEqual(['Q413']);
    expect(run.manifest.request.languages).toEqual(['pl', 'uk']);
    const a = await services.store.read(['runs', r.identifiers.runId!, 'analysis.json'], analysisSchema);
    expect(a.findings.filter(f => f.type === 'relative_change').map(f => f.value)).toEqual([-40, -40]);
    const html = (await services.store.readBytes(['reports', r.identifiers.runId!, r.identifiers.reportId!, 'report.html'])).toString();
    for (const code of new Set(a.findings.flatMap(f => f.warnings))) expect(html).toContain(code);
    expect(html).toContain('Результат для запитаних мов'); expect(html).toContain('Додаткове порівняння');
  }, 30000);
  it('strict не додає мови; дві прогалини зберігають місячні показники, повтор без мережі', async () => {
    const fixture = new FixtureTransport();
    const get = vi.fn(async (request: Parameters<FixtureTransport['get']>[0]) => {
      const result = await fixture.get(request);
      if (request.kind === 'article' && !request.granularity) { const raw = JSON.parse(result.body); raw.items = raw.items.filter((p: { timestamp: string }) => !['2022071300', '2022120500'].includes(p.timestamp)); result.body = JSON.stringify(raw); }
      return result;
    }); services.fixtureTransport = { get };
    const first = await executeOperation('research', { analysis, languagePolicy: 'strict' }, services);
    expect(first.summary.executionStatus, JSON.stringify(first.summary.blocker)).toBe('completed');
    const runId = first.identifiers.runId!, saved = await services.store.readBytes(['runs', runId, 'manifest.json']);
    const a = await services.store.read(['runs', runId, 'analysis.json'], analysisSchema);
    expect(a.entries[0]!.recovery!.yearOverYear.method).toBe('api_monthly'); expect(a.entries[0]!.recovery!.yearOverYear.changePercent.value).toBe(50);
    expect(a.entries[0]!.metrics.totalViews.value).toBeNull();
    expect((await readRun(runId, services)).manifest.completion?.supplementalLanguages).toEqual([]);
    get.mockClear(); get.mockRejectedValue(new Error('network forbidden'));
    const again = await executeOperation('research', { analysis, languagePolicy: 'strict' }, services);
    expect(again.summary.executionStatus).toBe('completed'); expect(get).not.toHaveBeenCalled();
    for (const locale of ['en', 'ru']) {
      const report = await executeOperation('report', { locale }, services, runId);
      expect(report.error, JSON.stringify(report.error)).toBeUndefined(); expect(report.summary.verification).toMatchObject({ pages: 3 });
    }
    const revise = await executeOperation('revise', { changes: { criterion: 'views' } }, services, runId);
    expect(revise.identifiers.parentRunId).toBe(runId); expect(get).not.toHaveBeenCalled();
    expect(await services.store.readBytes(['runs', runId, 'manifest.json'])).toEqual(saved);
  }, 60000);
  it('URL Unicode → перевірений QID → інші мови; довільний хост відхилено', async () => {
    const r = await executeOperation('resolve', { articleUrl: 'https://uk.wikipedia.org/wiki/%D0%90%D1%81%D1%82%D1%80%D0%BE%D0%BD%D0%BE%D0%BC%D1%96%D1%8F', queryLanguage: 'uk', languages: ['pl', 'cs'], source: 'fixtures', fixtureId: 'demo-v1' }, services);
    expect(r.status).toBe('ok'); expect((r.summary.candidates as { qid: string }[])[0]?.qid).toBe('Q333');
    const bad = await executeOperation('resolve', { articleUrl: 'https://evil.test/wiki/Test', queryLanguage: 'uk', languages: ['uk'], source: 'fixtures', fixtureId: 'demo-v1' }, services);
    expect(bad.error?.code).toBe('INVALID_ARTICLE_URL');
  });
  it('додавання мови з parentRunId завантажує лише відсутню мову; replay звіту незалежний від run', async () => {
    const fixture = new FixtureTransport(), get = vi.fn(fixture.get.bind(fixture)); services.fixtureTransport = { get };
    const base = { ...analysis, languages: ['pl'], topics: [{ topicId: 'astronomy', label: 'Астрономія', concepts: [{ qid: 'Q333' }] }] };
    const first = await executeOperation('research', { analysis: base, languagePolicy: 'strict' }, services);
    expect(first.summary.executionStatus).toBe('completed');
    const runId = first.identifiers.runId!, before = await services.store.readBytes(['runs', runId, 'manifest.json']);
    get.mockClear();
    const next = await executeOperation('research', { parentRunId: runId, analysis: { ...base, languages: ['pl', 'cs'] } }, services);
    expect(next.identifiers.parentRunId).toBe(runId); expect(next.summary.executionStatus).toBe('completed');
    expect(get.mock.calls.length).toBe(51); expect(get.mock.calls.every(([request]) => 'language' in request && request.language === 'cs')).toBe(true);
    expect(await services.store.readBytes(['runs', runId, 'manifest.json'])).toEqual(before);
    get.mockClear(); get.mockRejectedValue(new Error('network forbidden'));
    await rm(services.store.path('runs', runId), { recursive: true }); await rm(services.store.path('cache'), { recursive: true }); await rm(services.store.path('snapshots'), { recursive: true });
    const replay = await executeOperation('report', { replayReportId: first.identifiers.reportId }, services, runId);
    expect(replay.error, JSON.stringify(replay.error)).toBeUndefined(); expect(replay.summary.verification).toMatchObject({ pages: 3 }); expect(get).not.toHaveBeenCalled();
  }, 60000);
  it('локальний пошук підтверджує лише ту саму концепцію; не повторює запити безкінечно', async () => {
    const fixture = new FixtureTransport(), get = vi.fn(async (request: Parameters<FixtureTransport['get']>[0]) => {
      const response = await fixture.get(request);
      if (request.kind === 'entity' && request.qid === 'Q333') { const raw = JSON.parse(response.body); delete raw.entities.Q333.sitelinks.plwiki; response.body = JSON.stringify(raw); }
      return response;
    }); services.fixtureTransport = { get };
    const r = await executeOperation('resolve', { qid: 'Q333', queryLanguage: 'uk', languages: ['pl'], source: 'fixtures', fixtureId: 'demo-v1' }, services);
    expect(r.summary.candidates).toMatchObject([{ articles: [{ status: 'found', mappingStatus: 'confirmed', mappingSource: 'local_search', title: 'Astronomia' }] }]);
    expect(get.mock.calls.filter(([r]) => r.kind === 'wiki-search').length).toBeLessThanOrEqual(2);
  });
  it('вичерпаний бюджет зберігає доступні дані і PDF із явним blocker', async () => {
    const r = await executeOperation('research', { analysis: { ...analysis, languages: ['pl'] }, maxNetworkRequests: 10, languagePolicy: 'strict' }, services);
    expect(r.summary.networkRequests).toBe(10); expect(r.summary.blocker).toMatchObject({ code: 'NETWORK_BUDGET_EXHAUSTED' });
    expect(r.identifiers.runId).toBeTruthy(); expect(r.artifacts.some(a => a.kind === 'report.pdf')).toBe(true);
    expect(r.status).toBe('partial'); expect(r.summary.requestCompletion).toBe('partial');
  }, 30000);
  it('topic plan з прогалинами зберігає склад, повертає recovery та PDF', async () => {
    const fixture = new FixtureTransport(); services.fixtureTransport = { get: async request => {
      const response = await fixture.get(request);
      if (request.kind === 'article' && !request.granularity) { const raw = JSON.parse(response.body); raw.items = raw.items.filter((row: { timestamp: string }) => row.timestamp !== '2022071300'); response.body = JSON.stringify(raw); }
      return response;
    } };
    const d = await executeOperation('discover', { query: 'Астрономія', seedQids: ['Q333', 'Q413'], languages: ['uk'], source: 'fixtures', fixtureId: 'demo-v1' }, services);
    const p = await executeOperation('plan', { discoveryId: d.identifiers.discoveryId, basketId: 'science', label: 'Навчальні теми', question: 'Які зміни набору?', productContext: 'Вступний курс', boundaries: 'Дві синтетичні теми', subtopics: [{ id: 'a', label: 'Астрономія', rationale: 'Зміст' }, { id: 'b', label: 'Фізика', rationale: 'Зміст' }], decisions: [{ candidateId: 'Q333', status: 'selected', role: 'core', subtopic: 'a', reason: 'Зміст' }, { candidateId: 'Q413', status: 'selected', role: 'core', subtopic: 'b', reason: 'Зміст' }], period: analysis.period, assumptions: ['Тест'], limitations: ['Синтетичні дані'] }, services);
    expect(p.error).toBeUndefined();
    const result = await executeOperation('research', { analysis: { mode: 'topic', topicPlanId: p.identifiers.topicPlanId, languages: ['uk'], source: 'fixtures', fixtureId: 'demo-v1' } }, services);
    expect(result.summary.executionStatus, JSON.stringify(result.summary.blocker)).toBe('completed');
    const a = await services.store.read(['runs', result.identifiers.runId!, 'analysis.json'], analysisSchema);
    const core = a.entries.find(e => e.topicId === 'science-core')!;
    expect(core.recovery!.yearOverYear.method).toBe('api_monthly');
    expect(core.recovery!.yearOverYear.previous.value).toBe(54750); expect(core.recovery!.yearOverYear.current.value).toBe(100375);
    expect(a.topicStudy!.languages[0]!.coreQids).toEqual(['Q333', 'Q413']);
    expect(result.summary.report).toMatchObject({ verification: { pages: 3 } });
  }, 30000);
  it('інша концепція у sitelink не є відповідником; мережевий збій пошуку ≠ not-found', async () => {
    const fixture = new FixtureTransport();
    services.fixtureTransport = { get: async req => {
      if (req.kind === 'wiki-search') throw new AppError('NETWORK_ERROR', 'Тестовий збій');
      const result = await fixture.get(req);
      if (req.kind === 'page' && req.language === 'pl') { const raw = JSON.parse(result.body); raw.query.pages[0].pageprops.wikibase_item = 'Q333'; result.body = JSON.stringify(raw); }
      return result;
    } };
    const r = await executeOperation('resolve', { qid: 'Q413', queryLanguage: 'uk', languages: ['pl', 'cs'], source: 'fixtures', fixtureId: 'demo-v1' }, services);
    expect(r.summary.candidates).toMatchObject([{ articles: [{ status: 'invalid_page', mappingStatus: 'ambiguous' }, { status: 'unavailable', mappingStatus: 'incomplete' }] }]);
  });
  it('cooldown припиняє мережу, але знімки та checkpoint залишаються', async () => {
    const fixture = new FixtureTransport(); let calls = 0;
    services.fixtureTransport = { get: async req => { calls++; if (calls === 3) throw new AppError('RATE_LIMITED', 'Тестовий cooldown', { retryAt: '2023-01-16T00:00:00Z' }); return fixture.get(req); } };
    const r = await executeOperation('research', { analysis }, services);
    expect(calls).toBe(3); expect(r.summary.executionStatus).toBe('blocked'); expect(r.artifacts.some(a => a.kind === 'research-checkpoint')).toBe(true);
    expect(r.summary.blocker).toMatchObject({ code: 'RATE_LIMITED' });
    const repeat = await executeOperation('research', { analysis }, services);
    expect(calls).toBe(3); expect(repeat.summary.executionStatus).toBe('blocked');
  });
  it('непридатна історія однієї запитаної мови не блокує додаткову мову', async () => {
    const fixture = new FixtureTransport(); services.fixtureTransport = { get: async request => {
      if ((request.kind === 'article' || request.kind === 'project') && request.language === 'pl') throw new AppError('DATA_NOT_FOUND', 'Тестова відсутність історії');
      return fixture.get(request);
    } };
    const result = await executeOperation('research', { analysis: { ...analysis, languages: ['pl'] }, supplementalPriority: ['uk'] }, services);
    expect(result.summary.executionStatus, JSON.stringify(result.summary.blocker)).toBe('completed');
    expect(result.summary.requestedResult).toMatchObject({ unavailableLanguages: [{ language: 'pl', code: 'HISTORY_UNUSABLE' }] });
    const a = await services.store.read(['runs', result.identifiers.runId!, 'analysis.json'], analysisSchema);
    expect(a.entries.find(e => e.language === 'pl')!.recovery!.yearOverYear.method).toBe('unavailable');
    expect(a.entries.find(e => e.language === 'uk')!.recovery!.yearOverYear.changePercent.value).toBe(50);
    expect(a.completion!.comparisonLanguages).toEqual(['uk']);
  }, 30000);
});
