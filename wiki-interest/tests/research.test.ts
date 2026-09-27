import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, sha256, canonical } from '../src/storage.js';
import { createServices, readRun, type Services } from '../src/research.js';
import { executeOperation } from '../src/operations/index.js';
import { FixtureTransport } from '../src/fixtures.js';
import { HttpClient } from '../src/http.js';
import { requestSchema, type ApiRequest } from '../src/requests.js';
import { AppError } from '../src/errors.js';

const plan = { source: 'fixtures', fixtureId: 'demo-v1', topics: [{ topicId: 'astronomy', label: 'Астрономія', concepts: [{ qid: 'Q333' }] }], languages: ['uk'], period: { start: '2021-01-01', end: '2022-12-31' } };
const fromUrl = (input: string | URL | Request): ApiRequest => {
  const url = new URL(String(input)), p = url.searchParams;
  if (p.get('action') === 'wbgetentities') return requestSchema.parse({ kind: 'entity', qid: p.get('ids'), language: p.get('languages')?.split('|')[0] });
  if (p.get('action') === 'wbsearchentities') return requestSchema.parse({ kind: 'search', query: p.get('search'), language: p.get('language') });
  const language = url.hostname.split('.')[0];
  if (p.get('meta') === 'siteinfo') return requestSchema.parse({ kind: 'site', language });
  if (p.get('action') === 'query') return requestSchema.parse({ kind: 'page', language, title: p.get('titles'), ...(p.get('inprop') === 'url' ? { details: true } : {}) });
  const path = url.pathname.split('/').map(decodeURIComponent);
  const article = path[5] === 'per-article';
  const date = (value: string) => `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  return requestSchema.parse({ kind: article ? 'article' : 'project', language: path[6]?.split('.')[0], ...(article ? { title: path[9]?.replaceAll('_', ' ') } : {}), filters: { access: path[7], agent: path[8] }, period: { start: date(path.at(-2)!), end: date(path.at(-1)!) } });
};

describe('Операції та незмінні дослідження', () => {
  let root: string, services: Services;
  beforeEach(async () => {
    root = await mkdtemp(join(await realpath(tmpdir()), 'wiki-interest-test-'));
    services = createServices({ store: new FileStore(root), clock: { now: () => new Date('2023-01-15T12:00:00Z') }, log: () => {} });
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
  it('проходить реальний offline pipeline без fetch і придатної мережевої конфігурації', async () => {
    vi.stubEnv('WIKIMEDIA_USER_AGENT', '');
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'));
    const result = await executeOperation('analyze', plan, services);
    expect(result.status).toBe('ok');
    expect(result.warnings.some(w => w.code === 'SYNTHETIC_DATA')).toBe(true);
    const saved = await readRun(result.identifiers.runId!, services);
    expect(saved.manifest.originalRequest).toEqual(plan);
    expect(saved.manifest.report[0]?.metrics.totalViews.value).toBe(109500);
    expect(saved.dataset.topics[0]?.points).toHaveLength(730);
    expect(saved.manifest.snapshots).toHaveLength(52);
    expect(saved.manifest.snapshots.every(s => s.origin === 'fixtures')).toBe(true);
    const inspect = await executeOperation('inspect', {}, services, result.identifiers.runId);
    expect(inspect.status).toBe('ok'); expect(network).not.toHaveBeenCalled();
    expect(JSON.stringify(inspect)).not.toContain('2021010100');
    const findings = await executeOperation('inspect', { view: 'findings', limit: 2 }, services, result.identifiers.runId);
    expect(findings.summary).toMatchObject({ total: 7, nextOffset: 2, findings: [{ type: 'volume', value: 109500 }, { type: 'daily_average', value: 150 }] });
    expect(JSON.stringify(findings)).not.toContain('sensitivity.points');
    const next = await executeOperation('inspect', { view: 'findings', offset: 2, limit: 14 }, services, result.identifiers.runId);
    expect(next.summary.nextOffset).toBeNull(); expect(next.summary.findings).toHaveLength(5);
  });
  it('повторно використовує HTTP-кеш; додавання мови не перезавантажує стару', async () => {
    const fixtures = new FixtureTransport();
    const fetcher = vi.fn<typeof fetch>(async input => new Response((await fixtures.get(fromUrl(input))).body));
    services.transport = new HttpClient({ userAgent: 'wiki-interest-tests/1.0 (https://contact.unit-fixture.dev)', fetch: fetcher });
    const { fixtureId: _fixtureId, ...live } = plan;
    const first = await executeOperation('analyze', { ...live, source: 'live' }, services);
    expect(first.status).toBe('ok'); expect(fetcher).toHaveBeenCalledTimes(52);
    const second = await executeOperation('analyze', { ...live, source: 'live' }, services);
    expect(second.status).toBe('ok'); expect(fetcher).toHaveBeenCalledTimes(52);
    const added = await executeOperation('revise', { changes: { languages: ['uk', 'pl'] } }, services, first.identifiers.runId);
    expect(added.status).toBe('ok'); expect(fetcher).toHaveBeenCalledTimes(103);
    const newCalls = fetcher.mock.calls.slice(52).map(([url]) => String(url));
    expect(newCalls.every(url => url.includes('pl.wikipedia.org'))).toBe(true);
    const offline = await executeOperation('analyze', { ...live, source: 'offline' }, services);
    expect(offline.status).toBe('ok'); expect(offline.summary.dataMode).toBe('offline'); expect(offline.summary.source).toBe('wikimedia'); expect(fetcher).toHaveBeenCalledTimes(103);
    const changed = await executeOperation('revise', { changes: { criterion: 'yearOverYear' } }, services, first.identifiers.runId);
    expect(changed.status).toBe('ok'); expect(fetcher).toHaveBeenCalledTimes(103);
  }, 15000);
  it('revise не змінює старий run; refresh створює нові знімки; replay не бере нові дані', async () => {
    const transport = new FixtureTransport();
    const get = vi.spyOn(transport, 'get'); services.fixtureTransport = transport;
    const first = await executeOperation('analyze', plan, services);
    const parentId = first.identifiers.runId!;
    const path = services.store.path('runs', parentId, 'manifest.json');
    const original = await readFile(path, 'utf8');
    const revised = await executeOperation('revise', { changes: { criterion: 'relativeInterestChange' } }, services, parentId);
    expect(revised.identifiers.parentRunId).toBe(parentId); expect(revised.identifiers.runId).not.toBe(parentId);
    expect(get).toHaveBeenCalledTimes(52);
    services.clock = { now: () => new Date('2023-01-16T00:00:00Z') };
    const refreshed = await executeOperation('revise', { cachePolicy: 'refresh' }, services, parentId);
    expect(refreshed.status).toBe('ok'); expect(get).toHaveBeenCalledTimes(104);
    const refreshedRun = await readRun(refreshed.identifiers.runId!, services);
    const parent = await readRun(parentId, services);
    expect(refreshedRun.manifest.snapshots[0]?.snapshotId).not.toBe(parent.manifest.snapshots[0]?.snapshotId);
    get.mockRejectedValue(new Error('network forbidden'));
    const replay = await executeOperation('revise', { mode: 'replay' }, services, parentId);
    expect(replay.status).toBe('ok'); expect(get).toHaveBeenCalledTimes(104);
    const replayed = await readRun(replay.identifiers.runId!, services);
    expect(replayed.manifest.report).toEqual(parent.manifest.report);
    expect(replayed.manifest.snapshots).toEqual(parent.manifest.snapshots);
    expect(await readFile(path, 'utf8')).toBe(original);
  });
  it('resolve вимагає вибору реального кандидата', async () => {
    const resolved = await executeOperation('resolve', { query: 'Астрономія', queryLanguage: 'uk', languages: ['uk'], source: 'fixtures', fixtureId: 'demo-v1' }, services);
    expect(resolved.status).toBe('needs_selection');
    const bad = await executeOperation('analyze', { ...plan, topics: [{ topicId: 'wrong', label: 'Хибний вибір', concepts: [{ qid: 'Q413', resolutionId: resolved.identifiers.resolutionId }] }] }, services);
    expect(bad.error?.code).toBe('CANDIDATE_NOT_FOUND');
    const good = await executeOperation('analyze', { ...plan, topics: [{ topicId: 'right', label: 'Вибрана тема', concepts: [{ qid: 'Q333', resolutionId: resolved.identifiers.resolutionId }] }] }, services);
    expect(good.status).toBe('ok');
    const missing = await executeOperation('resolve', { qid: 'Q123456789', queryLanguage: 'uk', languages: ['uk'], source: 'fixtures', fixtureId: 'demo-v1' }, services);
    expect(missing.error?.code).toBe('QID_NOT_FOUND');
  });
  it('показує спільний склад концепцій, а не різні набори за мовами', async () => {
    const result = await executeOperation('analyze', { ...plan, languages: ['uk', 'cs'], topics: [{ topicId: 'science', label: 'Науки', concepts: [{ qid: 'Q333' }, { qid: 'Q413' }] }] }, services);
    expect(result.status).toBe('partial');
    const run = await readRun(result.identifiers.runId!, services);
    expect(run.manifest.topics[0]?.coverage.includedQids).toEqual(['Q333']);
    expect(run.manifest.topics[0]?.coverage.excludedQids).toEqual(['Q413']);
    expect(run.manifest.report.map(r => r.metrics.totalViews.value)).toEqual([109500, 109500]);
  });
  it('дедуплікує сторінки і знаменник у наборах та між темами', async () => {
    const result = await executeOperation('analyze', { ...plan, topics: [
      { topicId: 'one', label: 'Одна', concepts: [{ qid: 'Q333' }, { qid: 'Q999999' }] },
      { topicId: 'two', label: 'Друга', concepts: [{ qid: 'Q333' }] },
    ] }, services);
    const run = await readRun(result.identifiers.runId!, services);
    expect(run.manifest.report.map(r => r.metrics.totalViews.value)).toEqual([109500, 109500]);
    expect(run.manifest.report[0]?.metrics.yearOverYear.currentPerMillion.value).toBe(800);
    expect(run.dataset.series.filter(s => s.kind === 'project')).toHaveLength(1);
    expect(run.manifest.warnings.some(w => w.code === 'DUPLICATE_PAGES_REMOVED')).toBe(true);
    expect(run.manifest.warnings.some(w => w.code === 'OVERLAPPING_TOPICS')).toBe(true);
  });
  it('позначає зміну основи порівняння у збереженому revise', async () => {
    const first = await executeOperation('analyze', { ...plan, topics: [{ topicId: 'science', label: 'Науки', concepts: [{ qid: 'Q333' }, { qid: 'Q413' }] }] }, services);
    const revised = await executeOperation('revise', { changes: { languages: ['uk', 'cs'] } }, services, first.identifiers.runId);
    expect(revised.warnings.some(w => w.code === 'COMPARISON_BASIS_CHANGED')).toBe(true);
    expect((await readRun(revised.identifiers.runId!, services)).manifest.warnings.some(w => w.code === 'COMPARISON_BASIS_CHANGED')).toBe(true);
  });
  it('прогалини зберігаються як partial, без нулів', async () => {
    const fixture = new FixtureTransport();
    services.fixtureTransport = { get: async request => {
      const result = await fixture.get(request);
      if (request.kind === 'article' && request.period.start === '2022-12-01') {
        const raw = JSON.parse(result.body) as { items: unknown[] }; raw.items.pop(); result.body = JSON.stringify(raw);
      }
      return result;
    } };
    const result = await executeOperation('analyze', plan, services);
    expect(result.status).toBe('partial');
    const run = await readRun(result.identifiers.runId!, services);
    expect(run.manifest.report[0]?.metrics.yearOverYear.current.value).toBeNull();
    expect(run.dataset.topics[0]?.points.at(-1)?.views).toBeNull();
  });
  it('зберігає нормалізацію та ланцюжок redirects без підсумовування назв', async () => {
    const fixture = new FixtureTransport();
    services.fixtureTransport = { get: async request => {
      if (request.kind === 'page') return { url: `https://uk.wikipedia.org/w/api.php`, body: JSON.stringify({ query: {
        normalized: [{ from: 'астрономія_тест', to: 'Астрономія тест' }],
        redirects: [{ from: 'Астрономія тест', to: 'Астрономія' }],
        pages: [{ title: 'Астрономія', ns: 0, pageid: 100, fullurl: 'https://uk.wikipedia.org/wiki/Астрономія', pageprops: { wikibase_item: 'Q333' }, revisions: [{ revid: 1, timestamp: '2010-01-01T00:00:00Z', slots: { main: { content: 'Тестовий зміст астрономії.' } } }] }],
      } }) };
      const result = await fixture.get(request);
      if (request.kind === 'entity') {
        const entity = JSON.parse(result.body); entity.entities.Q333.sitelinks.ukwiki.title = 'астрономія_тест'; result.body = JSON.stringify(entity);
      }
      return result;
    } };
    const result = await executeOperation('analyze', plan, services);
    const run = await readRun(result.identifiers.runId!, services);
    expect(run.manifest.topics[0]?.candidates[0]?.articles[0]).toMatchObject({ originalTitle: 'астрономія_тест', title: 'Астрономія', normalized: [{ from: 'астрономія_тест', to: 'Астрономія тест' }], redirects: [{ from: 'Астрономія тест', to: 'Астрономія' }] });
    expect(run.dataset.series.filter(s => s.kind === 'article').map(s => s.title)).toEqual(['Астрономія']);
  });
  it('порожній спільний набір не означає нуль переглядів', async () => {
    const result = await executeOperation('analyze', { ...plan, languages: ['uk', 'cs'], topics: [{ topicId: 'physics', label: 'Фізика', concepts: [{ qid: 'Q413' }] }] }, services);
    const run = await readRun(result.identifiers.runId!, services);
    expect(result.status).toBe('partial');
    expect(run.manifest.report.every(r => r.metrics.totalViews.value === null && r.metrics.totalViews.reason?.code === 'NO_COMMON_CONCEPTS')).toBe(true);
  });
  it('покритий кешем підперіод не потребує нових завантажень', async () => {
    const fixture = new FixtureTransport(); const get = vi.spyOn(fixture, 'get'); services.fixtureTransport = fixture;
    const first = await executeOperation('analyze', plan, services);
    const revised = await executeOperation('revise', { changes: { period: { start: '2022-01-15', end: '2022-02-10' } } }, services, first.identifiers.runId);
    expect(revised.status).toBe('ok'); expect(get).toHaveBeenCalledTimes(52);
    const run = await readRun(revised.identifiers.runId!, services);
    expect(run.manifest.report[0]?.metrics.totalViews.value).toBe(5400);
    expect(run.dataset.topics[0]?.points).toHaveLength(27);
    expect(run.manifest.request.period).toEqual({ start: '2022-01-15', end: '2022-02-10' });
  });
  it('відсутність даних відрізняє від відсутньої статті', async () => {
    const fixture = new FixtureTransport();
    services.fixtureTransport = { get: request => request.kind === 'article' ? Promise.reject(new AppError('DATA_NOT_FOUND', 'Немає даних.')) : fixture.get(request) };
    const result = await executeOperation('analyze', plan, services);
    const run = await readRun(result.identifiers.runId!, services);
    expect(run.manifest.topics[0]?.candidates[0]?.articles[0]?.status).toBe('found');
    expect(run.manifest.report[0]?.metrics.totalViews.value).toBeNull();
    expect(run.manifest.warnings.some(w => w.code === 'DATA_NOT_FOUND')).toBe(true);
  });
  it('offline ніколи не підміняє відсутній кеш fixtures', async () => {
    const fixture = new FixtureTransport(); const fixtureGet = vi.spyOn(fixture, 'get'); services.fixtureTransport = fixture;
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('forbidden'));
    const { fixtureId: _fixtureId, ...input } = plan;
    const result = await executeOperation('analyze', { ...input, source: 'offline' }, services);
    expect(result.error?.code).toBe('OFFLINE_CACHE_MISS'); expect(fixtureGet).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });
  it('відхиляє пошкоджений знімок під час inspect і replay', async () => {
    const result = await executeOperation('analyze', plan, services);
    const run = await readRun(result.identifiers.runId!, services);
    await writeFile(services.store.path('snapshots', `${run.manifest.snapshots[0]!.snapshotId}.json`), '{}');
    expect((await executeOperation('inspect', {}, services, result.identifiers.runId)).error?.code).toBe('CHECKSUM_MISMATCH');
    expect((await executeOperation('revise', { mode: 'replay' }, services, result.identifiers.runId)).error?.code).toBe('CHECKSUM_MISMATCH');
  });
  it('захищає шляхи, ідентифікатори і незмінні файли', async () => {
    expect(() => services.store.path('runs', '../outside')).toThrow();
    expect((await executeOperation('inspect', {}, services, '../../secret')).status).toBe('error');
    await symlink(await realpath(tmpdir()), join(root, 'escape'));
    await expect(services.store.write(['escape', 'file.json'], {})).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await services.store.write(['immutable.json'], { value: 1 });
    await expect(services.store.write(['immutable.json'], { value: 2 })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(sha256(await readFile(join(root, 'immutable.json'), 'utf8'))).toBe(sha256(`${canonical({ value: 1 })}\n`));
  });
  it('вхідні контракти відхиляють довільний URL, невідомі поля й конфліктний replay', async () => {
    for (const input of [{ ...plan, url: 'https://example.com' }, { ...plan, languages: ['uk', 'uk'] }, { ...plan, source: 'live' }]) expect((await executeOperation('analyze', input, services)).error?.code).toBe('VALIDATION_ERROR');
    expect((await executeOperation('revise', { mode: 'replay', changes: { criterion: 'views' } }, services, '00000000-0000-4000-8000-000000000000')).error?.code).toBe('VALIDATION_ERROR');
  });
});
