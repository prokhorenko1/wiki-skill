import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServices, gateway, readRun, type Services } from '../src/research.js';
import { FileStore } from '../src/storage.js';
import { FixtureTransport } from '../src/fixtures.js';
import { Resolver } from '../src/resolver.js';
import { PageVerifier } from '../src/page-verifier.js';
import { applySourceReview } from '../src/source-evidence.js';
import { requestUrl, type ApiRequest } from '../src/requests.js';
import { executeOperation } from '../src/operations/index.js';
import { analysisSchema } from '../src/analysis.js';
import { verifyPdf } from '../src/reporting/pdf.js';
import { AppError } from '../src/errors.js';

let services: Services, root: string;
const options = { source: 'fixtures', fixtureId: 'demo-v1', cachePolicy: 'reuse' } as const;
const fixture = new FixtureTransport();
const input = { ...options, qid: 'Q333', queryLanguage: 'uk', languages: ['uk'] };
const plan = { ...options, topics: [{ topicId: 'astronomy', label: 'Астрономія', concepts: [{ qid: 'Q333' }] }], languages: ['uk'], period: { start: '2021-01-01', end: '2022-12-31' } };
beforeEach(async () => { root = await mkdtemp(join(await realpath(tmpdir()), 'wiki-sources-')); services = createServices({ store: new FileStore(root), clock: { now: () => new Date('2023-01-15T00:00:00Z') }, log: () => {} }); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const change = (fn: (request: ApiRequest, data: any) => void) => { services.fixtureTransport = { get: async r => { const response = await fixture.get(r), data = JSON.parse(response.body); fn(r, data); return { ...response, body: JSON.stringify(data) }; } }; };
it('sitelink → info URL, pageprops, поточна revision; каталог усіх мов не дорівнює перевіреним сторінкам', async () => {
  const c = await new Resolver(gateway(services, options)).candidate('Q333', 'uk', ['uk']);
  expect(c.sitelinkCatalog).toHaveLength(3); expect(c.articles).toHaveLength(1);
  expect(c.articles[0]!.source).toMatchObject({ language: 'uk', title: 'Астрономія', wikidataId: 'Q333', qidStatus: 'confirmed', urlMethod: 'info', revisionId: 1, semantic: { status: 'pending', matchType: 'ambiguous' } });
  expect(decodeURI(c.articles[0]!.source!.articleUrl)).toBe('https://uk.wikipedia.org/wiki/Астрономія');
});
it('мовний label без sitelink не стає статтею; успішний пошук має історичний знімок', async () => {
  const c = await new Resolver(gateway(services, options)).candidate('Q413', 'uk', ['cs']);
  const a = c.articles[0]!; expect(a.status).toBe('missing_sitelink'); expect(a.evidence).toMatchObject({ sitelinkPresent: false, status: 'not_found_after_search', searchCompleted: true, searchTruncated: false });
  expect(a.evidence!.queries[0]!.snapshotIds).toHaveLength(1); expect(a.evidence!.queries[0]!.searchUrl).toContain('Special%3ASearch');
});
it('langlinks continuation зберігає наступні мови; бюджет явно позначає неповноту', async () => {
  services.fixtureTransport = { get: async r => r.kind === 'langlinks' ? { url: requestUrl(r), body: JSON.stringify({ ...(r.continuation ? {} : { continue: { llcontinue: '100|pl', continue: '||' } }), query: { pages: [{ langlinks: [{ lang: r.continuation ? 'pl' : 'uk', title: 'Astronomia', url: `https://${r.continuation ? 'pl' : 'uk'}.wikipedia.org/wiki/Astronomia` }] }] } }) } : fixture.get(r) };
  const verifier = new PageVerifier(gateway(services, options));
  const first = await verifier.langlinks('uk', 'Астрономія', 1); expect(first.complete).toBe(false);
  const all = await verifier.langlinks('uk', 'Астрономія'); expect(all.links.map(l => l.lang)).toEqual(['uk', 'pl']); expect(all.complete).toBe(true); expect(all.independentEvidence).toBe(false);
});
it('QID-конфлікт видимий; ширший кандидат не отримує exact лише через заголовок', async () => {
  change((r, raw) => { if (r.kind === 'page') raw.query.pages[0].pageprops.wikibase_item = 'Q413'; });
  const c = await new Resolver(gateway(services, options)).candidate('Q333', 'uk', ['uk']);
  const a = c.articles[0]!; expect(a.status).toBe('invalid_page'); expect(a.source!.qidStatus).toBe('conflict');
  expect(() => applySourceReview(a.source!, { sourceId: a.source!.sourceId, revisionId: 1, matchType: 'exact', subject: 'Інша тема', rationale: 'Нібито та сама тема попри QID', context: 'Перевірка', evidenceQuote: 'Синтетичний вступ' })).toThrowError('конфлікт');
});
it('перенаправлення сутності перевіряється окремо від іншого QID', async () => {
  change((r, raw) => { if (r.kind === 'page') raw.query.pages[0].pageprops.wikibase_item = 'Q999999'; });
  const c = await new Resolver(gateway(services, options)).candidate('Q333', 'uk', ['uk']);
  expect(c.articles[0]!.source).toMatchObject({ wikidataId: 'Q999999', canonicalQid: 'Q333', qidStatus: 'redirected' }); expect(c.articles[0]!.status).toBe('found');
});
it.each(['broader', 'section_only'] as const)('%s не потрапляє в точне порівняння та не завантажує перегляди', async matchType => {
  const get = vi.fn(fixture.get.bind(fixture)); services.fixtureTransport = { get };
  const r = await executeOperation('resolve', input, services);
  const saved = JSON.parse((await services.store.readBytes(['resolutions', `${r.identifiers.resolutionId}.json`])).toString());
  const source = saved.candidates[0].articles[0].source;
  const reviewed = await executeOperation('review', { resolutionId: r.identifiers.resolutionId, reviews: [{ sourceId: source.sourceId, revisionId: 1, matchType, subject: 'Ширша тестова тема', rationale: 'Запит охоплює лише частину цієї сторінки.', context: 'Вузький тестовий контекст', evidenceQuote: 'Синтетичний вступ', ...(matchType === 'section_only' ? { section: 'Тестовий розділ' } : {}) }] }, services);
  expect(reviewed.error).toBeUndefined(); get.mockClear();
  const result = await executeOperation('analyze', { ...plan, topics: [{ ...plan.topics[0], concepts: [{ qid: 'Q333', resolutionId: reviewed.identifiers.resolutionId }] }] }, services);
  expect(result.status).toBe('partial'); expect(get.mock.calls.some(([r]) => r.kind === 'article')).toBe(false);
});
it('пошукова API-помилка не стає not_found і не кешується як відсутність', async () => {
  let failed = true;
  services.fixtureTransport = { get: async r => { if (r.kind === 'wiki-search' && failed) throw new AppError('NETWORK_ERROR', 'Тестова помилка'); return fixture.get(r); } };
  const c = await new Resolver(gateway(services, options)).candidate('Q413', 'uk', ['cs']);
  expect(c.articles[0]!.evidence).toMatchObject({ status: 'search_incomplete', searchCompleted: false });
  failed = false;
  const next = await new Resolver(gateway(services, options)).candidate('Q413', 'uk', ['cs']); expect(next.articles[0]!.evidence!.status).toBe('not_found_after_search');
});
it('TTL метаданих оновлює негативний пошук після доби; cooldown збережений', async () => {
  const get = vi.fn(fixture.get.bind(fixture)); services.transport = { get };
  const live = { source: 'live', cachePolicy: 'reuse' } as const;
  const request = { kind: 'wiki-search', language: 'cs', query: 'Фізика' } as const;
  await gateway(services, live).get(request); await gateway(services, live).get(request); expect(get).toHaveBeenCalledTimes(1);
  services.clock = { now: () => new Date('2023-01-17T00:00:00Z') };
  await services.store.write(['network', 'wikimedia', 'cooldown.json'], { retryAt: '2023-01-18T00:00:00Z' });
  await expect(gateway(services, live).get(request)).rejects.toMatchObject({ code: 'RATE_LIMITED' }); expect(get).toHaveBeenCalledTimes(1);
  services.clock = { now: () => new Date('2023-01-19T00:00:00Z') };
  await gateway(services, live).get(request); expect(get).toHaveBeenCalledTimes(2);
});
it('відсутнє поле sitelinks не означає відсутню статтю', async () => {
  change((r, raw) => { if (r.kind === 'entity') delete raw.entities[r.qid].sitelinks; });
  await expect(new Resolver(gateway(services, options)).candidate('Q333', 'uk', ['uk'])).rejects.toMatchObject({ code: 'SITELINKS_NOT_RETURNED' });
});
it('exact review зберігається в analyze та replay без зовнішнього resolution; підміна статті не приєднує старі дані', async () => {
  const r = await executeOperation('resolve', input, services);
  const saved = JSON.parse((await services.store.readBytes(['resolutions', `${r.identifiers.resolutionId}.json`])).toString()), source = saved.candidates[0].articles[0].source;
  const reviewed = await executeOperation('review', { resolutionId: r.identifiers.resolutionId, reviews: [{ sourceId: source.sourceId, revisionId: 1, matchType: 'exact', subject: 'Астрономія', rationale: 'Синтетична тема відповідає тестовій концепції.', context: 'Тестова стаття загалом', evidenceQuote: 'Синтетичний вступ' }] }, services);
  const run = await executeOperation('analyze', { ...plan, sourceResolutionIds: [reviewed.identifiers.resolutionId] }, services), id = run.identifiers.runId!;
  expect(run.error).toBeUndefined(); expect(run.warnings.some(w => w.code === 'CONTENT_REVIEW_REQUIRED')).toBe(false);
  const before = await services.store.readBytes(['runs', id, 'manifest.json']);
  await rm(services.store.path('resolutions'), { recursive: true });
  const get = vi.fn().mockRejectedValue(new Error('network forbidden')); services.fixtureTransport = { get };
  const replay = await executeOperation('revise', { mode: 'replay' }, services, id); expect(replay.error).toBeUndefined(); expect(get).not.toHaveBeenCalled();
  expect((await readRun(replay.identifiers.runId!, services)).manifest.topics[0]!.candidates[0]!.articles[0]!.source!.semantic.matchType).toBe('exact');
  change((req, raw) => { if (req.kind === 'page' && req.details) raw.query.pages[0].pageid = 98765; });
  const changed = await executeOperation('sources', {}, services, id); expect(changed.error?.code).toBe('ARTICLE_SELECTION_CHANGED');
  expect(await services.store.readBytes(['runs', id, 'manifest.json'])).toEqual(before);
}, 15000);
it('новий disambiguation у details не приховується старим кешем pageprops', async () => {
  change((r, raw) => { if (r.kind === 'page' && r.details) raw.query.pages[0].pageprops.disambiguation = ''; });
  const candidate = await new Resolver(gateway(services, options)).candidate('Q333', 'uk', ['uk']);
  expect(candidate.articles[0]!.status).toBe('disambiguation');
});
it('URL іншого заголовка не може позначати джерело чисел', async () => {
  change((r, raw) => { if (r.kind === 'page' && r.details) raw.query.pages[0].fullurl = 'https://uk.wikipedia.org/wiki/Інша_тема'; });
  const candidate = await new Resolver(gateway(services, options)).candidate('Q333', 'uk', ['uk']);
  expect(candidate.articles[0]!.status).toBe('unavailable'); expect(candidate.articles[0]!.evidence!.errors[0]!.code).toBe('ARTICLE_URL_MISMATCH');
});
it('пошуковий continuation обробляється у зафіксованому бюджеті', async () => {
  services.fixtureTransport = { get: async r => {
    if (r.kind === 'wiki-search') return { url: requestUrl(r), body: JSON.stringify({ ...(r.continuation ? {} : { continue: { continue: '-||', sroffset: 20 } }), query: { search: r.continuation ? [{ title: 'Astronomia' }] : [] } }) };
    const response = await fixture.get(r), raw = JSON.parse(response.body);
    if (r.kind === 'entity' && r.qid === 'Q333') delete raw.entities.Q333.sitelinks.plwiki;
    return { ...response, body: JSON.stringify(raw) };
  } };
  const c = await new Resolver(gateway(services, options)).candidate('Q333', 'uk', ['pl']);
  expect(c.articles[0]!.status).toBe('found'); expect(c.articles[0]!.evidence!.queries[0]!.snapshotIds).toHaveLength(2); expect(c.articles[0]!.evidence!.searchTruncated).toBe(false);
});
it('sourceIds/URL збігаються у метриках, JSON, CLI, HTML і справжніх PDF-анотаціях; старий run незмінний', async () => {
  const run = await executeOperation('analyze', plan, services), id = run.identifiers.runId!;
  const before = await services.store.readBytes(['runs', id, 'manifest.json']);
  const old = await readRun(id, services);
  const a = await services.store.read(['runs', id, 'analysis.json'], analysisSchema), page = a.articleSources!.pages[0]!;
  expect(a.entries[0]!.sourceIds).toEqual([page.sourceId]); expect(a.findings.every(f => f.sourceIds?.includes(page.sourceId))).toBe(true);
  expect((run.summary.articleSources as any).pages[0].articleUrl).toBe(page.articleUrl);
  expect(old.manifest.pageviewRequests!.filter(r => r.kind === 'article').every(r => r.sourceId === page.sourceId && r.title === page.title && r.project === page.project)).toBe(true);
  const report = await executeOperation('report', {}, services, id); expect(report.error).toBeUndefined();
  expect((report.summary.articleSources as any).pages[0].articleUrl).toBe(page.articleUrl);
  const base = ['reports', id, report.identifiers.reportId!];
  const html = (await services.store.readBytes([...base, 'report.html'])).toString(); expect(html).toContain(page.sourceId); expect(html).toContain(page.articleUrl);
  const verified = await verifyPdf(await services.store.readBytes([...base, 'report.pdf']), [page.sourceId], [], [page.articleUrl, page.wikidataUrl!]);
  expect(verified.pages).toBeLessThanOrEqual(3);
  await expect(verifyPdf(await services.store.readBytes([...base, 'report.pdf']), [], [], ['https://en.wikipedia.org/wiki/Unrelated'])).rejects.toMatchObject({ code: 'PDF_LINK_MISSING' });
  expect(await services.store.readBytes(['runs', id, 'manifest.json'])).toEqual(before);
}, 30000);
