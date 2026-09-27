import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServices, readRun, type Services } from '../src/research.js';
import { executeOperation } from '../src/operations/index.js';
import { FileStore, canonical } from '../src/storage.js';
import { FixtureTransport } from '../src/fixtures.js';
import { discoverySchema, topicPlanSchema } from '../src/topic-plan.js';
import { analysisSchema } from '../src/analysis.js';
import { requestUrl } from '../src/requests.js';

let services: Services, root: string;
beforeEach(async () => { root = await mkdtemp(join(await realpath(tmpdir()), 'wiki-topic-')); services = createServices({ store: new FileStore(root), clock: { now: () => new Date('2023-01-15T00:00:00Z') }, log: () => {} }); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
const discover = { query: 'демо-хімія', queryLanguage: 'uk', languages: ['uk'], source: 'fixtures', fixtureId: 'demo-v1', seedQids: ['Q2329', 'Q91000001', 'Q91000002', 'Q91000003', 'Q91000004'] };
const planInput = (discoveryId: string) => ({ discoveryId, basketId: 'demo', label: 'Хімія', question: 'Курс?', productContext: 'навчання', boundaries: 'навчальні поняття', subtopics: [{ id: 'a', label: 'Розділи', rationale: 'Зміст' }, { id: 'b', label: 'Основи', rationale: 'Зміст' }], period: { start: '2021-01-01', end: '2022-12-31' }, assumptions: ['Вступне навчання'], limitations: ['Синтетичні значення'], decisions: [ ['Q2329', 'root', undefined], ['Q91000001', 'core', 'a'], ['Q91000002', 'core', 'a'], ['Q91000003', 'core', 'b'], ['Q91000004', 'core', 'b'] ].map(([candidateId, role, subtopic]) => ({ candidateId, role, subtopic, status: 'selected', reason: 'Вибрано за змістом до аналізу.' })) });
it('discover перевіряє сторінки, aliases, pagination та явні ліміти, не запитує перегляди', async () => {
  const fixture = new FixtureTransport(), get = vi.spyOn(fixture, 'get'); services.fixtureTransport = fixture;
  const output = await executeOperation('discover', { ...discover, linkTitles: ['Хімія'], categoryTitles: ['Категорія:Хімія'] }, services);
  expect(output.status).toBe('needs_selection');
  const d = await services.store.read(['discoveries', `${output.identifiers.discoveryId}.json`], discoverySchema);
  expect(d.candidates.filter(c => c.qid === 'Q2329')).toHaveLength(1);
  expect(d.candidates.find(c => c.qid === 'Q2329')!.sources.map(s => s.kind)).toEqual(expect.arrayContaining(['seed', 'wikidata', 'search', 'link', 'category']));
  expect(get.mock.calls.some(([r]) => r.kind === 'links' && r.continuation?.plcontinue)).toBe(true);
  expect(get.mock.calls.some(([r]) => r.kind === 'category' && r.continuation?.cmcontinue)).toBe(true);
  expect(get.mock.calls.some(([r]) => r.kind === 'wiki-search' && r.continuation?.sroffset)).toBe(true);
  expect(get.mock.calls.some(([r]) => r.kind === 'article' || r.kind === 'project')).toBe(false);
  const limited = await executeOperation('discover', { ...discover, limits: { candidates: 2, requests: 8, depth: 0 } }, services);
  expect(limited.summary.discoveryTruncated).toBe(true); expect(Number(limited.summary.logicalRequests)).toBeLessThanOrEqual(8);
  expect(limited.warnings[0]!.code).toBe('DISCOVERY_TRUNCATED');
});
it('порожня сторінка pagination не обриває category; глибина обмежена', async () => {
  const fixture = new FixtureTransport();
  const get = vi.fn(async (request: Parameters<FixtureTransport['get']>[0]) => {
    if (request.kind === 'category' && !request.continuation) return { url: requestUrl(request), body: JSON.stringify({ continue: { continue: '-||', cmcontinue: 'next' }, query: { categorymembers: [] } }) };
    if (request.kind === 'category') return { url: requestUrl(request), body: JSON.stringify({ query: { categorymembers: [{ ns: 14, title: 'Категорія:Дочірня', pageid: 9 }] } }) };
    return fixture.get(request);
  }); services.fixtureTransport = { get };
  const r = await executeOperation('discover', { ...discover, categoryTitles: ['Категорія:Хімія'], limits: { candidates: 40, requests: 160, depth: 0 } }, services);
  expect(r.summary.truncationReasons).toContain('category_depth_limit'); expect(get.mock.calls.filter(([r]) => r.kind === 'category')).toHaveLength(2);
});
it('фіксує план, проходить analyze пакетом, повторно використовує кеш і власні знімки', async () => {
  const fixture = new FixtureTransport(), get = vi.spyOn(fixture, 'get'); services.fixtureTransport = fixture;
  const d = await executeOperation('discover', discover, services), p = await executeOperation('plan', planInput(d.identifiers.discoveryId!), services);
  expect(p.status, JSON.stringify(p.error)).toBe('ok');
  const frozen = await services.store.read(['plans', `${p.identifiers.topicPlanId}.json`], topicPlanSchema);
  expect(frozen.members).toHaveLength(5);
  const input = { mode: 'topic', topicPlanId: p.identifiers.topicPlanId, languages: ['uk'], source: 'fixtures', fixtureId: 'demo-v1' };
  const first = await executeOperation('analyze', input, services); expect(first.status, JSON.stringify(first.error)).toBe('partial');
  const runId = first.identifiers.runId!, before = await services.store.readBytes(['runs', runId, 'manifest.json']);
  const saved = await readRun(runId, services), a = await services.store.read(['runs', runId, 'analysis.json'], analysisSchema);
  expect(a.topicStudy!.languages[0]!.comparisons.core).toBeCloseTo(12);
  expect(a.topicStudy!.languages[0]!.comparisons.root).toBe(-50);
  expect(a.topicStudy!.languages[0]!.contributions.map(c => c.percentagePoints)).toEqual([20, -20, 0, 12]);
  expect(saved.dataset.series.filter(s => s.kind === 'project')).toHaveLength(1);
  const calls = get.mock.calls.length;
  const second = await executeOperation('analyze', input, services); expect(second.status).toBe('partial'); expect(get).toHaveBeenCalledTimes(calls);
  const altered = planInput(d.identifiers.discoveryId!); altered.decisions[4]!.status = 'excluded';
  const p2 = await executeOperation('plan', { ...altered, parentPlanId: p.identifiers.topicPlanId }, services);
  expect(p2.status).toBe('ok');
  await rm(join(root, 'cache'), { recursive: true, force: true }); get.mockRejectedValue(new Error('Network forbidden'));
  const revised = await executeOperation('revise', { changes: { topicPlanId: p2.identifiers.topicPlanId } }, services, runId);
  expect(revised.status, JSON.stringify(revised.error)).not.toBe('error'); expect(revised.identifiers.parentRunId).toBe(runId); expect(get).toHaveBeenCalledTimes(calls);
  const child = await readRun(revised.identifiers.runId!, services); expect(child.manifest.topicPlan!.compositionVersion).not.toBe(frozen.compositionVersion);
  expect(await services.store.readBytes(['runs', runId, 'manifest.json'])).toEqual(before);
  const replay = await executeOperation('revise', { mode: 'replay' }, services, runId);
  expect(replay.status, JSON.stringify(replay.error)).not.toBe('error');
  expect(canonical((await readRun(replay.identifiers.runId!, services)).dataset)).toBe(canonical(saved.dataset));
}, 30000);
it('відхиляє невиявлені концепції, дубльовані рішення та зміну періоду поза планом', async () => {
  const d = await executeOperation('discover', discover, services), input = planInput(d.identifiers.discoveryId!);
  const bad = structuredClone(input); bad.decisions[0]!.candidateId = 'invented';
  expect((await executeOperation('plan', bad, services)).error?.code).toBe('CANDIDATE_NOT_FOUND');
  expect((await executeOperation('plan', { ...input, decisions: [...input.decisions, input.decisions[1]] }, services)).error?.code).toBe('PLAN_DUPLICATE');
  const p = await executeOperation('plan', input, services);
  expect((await executeOperation('analyze', { mode: 'topic', topicPlanId: p.identifiers.topicPlanId, languages: ['uk'], period: { start: '2022-01-01', end: '2022-12-31' }, source: 'fixtures', fixtureId: 'demo-v1' }, services)).error?.code).toBe('PLAN_MISMATCH');
});

it('успадковує нестандартні фільтри плану, але не дозволяє явно підмінити їх', async () => {
  const d = await executeOperation('discover', discover, services);
  const p = await executeOperation('plan', { ...planInput(d.identifiers.discoveryId!), filters: { access: 'desktop', agent: 'user' } }, services);
  const input = { mode: 'topic', topicPlanId: p.identifiers.topicPlanId, languages: ['uk'], source: 'fixtures', fixtureId: 'demo-v1' };
  const output = await executeOperation('analyze', input, services);
  expect(output.error).toBeUndefined();
  expect((await readRun(output.identifiers.runId!, services)).manifest.request.filters.access).toBe('desktop');
  expect((await executeOperation('analyze', { ...input, filters: { access: 'all-access', agent: 'user' } }, services)).error?.code).toBe('PLAN_MISMATCH');
}, 30000);
