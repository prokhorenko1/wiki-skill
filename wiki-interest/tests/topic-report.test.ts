import { expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServices } from '../src/research.js';
import { FileStore } from '../src/storage.js';
import { executeOperation } from '../src/operations/index.js';
import { FixtureTransport } from '../src/fixtures.js';
import { printPdf, verifyPdf } from '../src/reporting/pdf.js';
import { analysisSchema } from '../src/analysis.js';
import { buildHtml, selectPresentation } from '../src/reporting/template.js';
import { fontCss } from '../src/reporting/resources.js';
import { knownDataIssues } from '../src/data-issues.js';

for (const locale of ['uk', 'en', 'ru'] as const) it(`topic PDF ${locale}: змістовні 2/3 сторінки, Unicode, усі PNG та власний replay`, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'wiki-topic-pdf-')), fixture = new FixtureTransport();
  const services = createServices({ store: new FileStore(root), clock: { now: () => new Date('2023-01-15T00:00:00Z') }, log: () => {}, fixtureTransport: { get: async request => {
    const r = await fixture.get(request), raw = JSON.parse(r.body);
    if (request.kind === 'article') for (const row of raw.items) row.views = row.timestamp < '2022' ? 100 : 200;
    if (request.kind === 'project') for (const row of raw.items) row.views = 100000;
    if (request.kind === 'entity' && locale !== 'uk') raw.entities[request.qid].labels.uk.value = 'Українська довга назва Český Łódź Русский English <script> '.repeat(3);
    return { ...r, body: JSON.stringify(raw) };
  } } });
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network'));
  try {
    const d = await executeOperation('discover', { query: 'Астрономія', seedQids: ['Q333', 'Q413'], languages: ['uk'], source: 'fixtures', fixtureId: 'demo-v1' }, services);
    const p = await executeOperation('plan', { discoveryId: d.identifiers.discoveryId, basketId: 'sample', label: 'Тематичний навчальний набір', question: 'Якою є динаміка вибраного набору?', productContext: 'Вступне навчання', boundaries: 'Дві синтетичні концепції', subtopics: [{ id: 'a', label: 'Підтема Český', rationale: 'Зміст' }, { id: 'b', label: 'Підтема Łódź', rationale: 'Зміст' }], decisions: [{ candidateId: 'Q333', status: 'selected', role: 'core', subtopic: 'a', reason: 'Зміст' }, { candidateId: 'Q413', status: 'selected', role: locale === 'uk' ? 'core' : 'extended', subtopic: 'b', reason: 'Зміст' }], period: { start: '2021-01-01', end: '2022-12-31' }, assumptions: ['Тестова вибірка'], limitations: ['Синтетичні дані'] }, services);
    expect(p.error).toBeUndefined();
    const a = await executeOperation('analyze', { mode: 'topic', topicPlanId: p.identifiers.topicPlanId, languages: ['uk'], source: 'fixtures', fixtureId: 'demo-v1' }, services);
    expect(a.error).toBeUndefined();
    const r = await executeOperation('report', { locale }, services, a.identifiers.runId);
    expect(r.error, JSON.stringify(r.error)).toBeUndefined();
    expect(r.summary.verification).toMatchObject({ pages: locale === 'uk' ? 2 : 3 });
    expect(r.artifacts.filter(a => /^report-page-\d.png$/.test(a.kind))).toHaveLength(locale === 'uk' ? 2 : 3);
    const pdf = await readFile(r.artifacts.find(a => a.kind === 'report.pdf')!.path), checked = await verifyPdf(pdf, ['Český', 'Łódź'], []);
    expect(checked.pages).toBe(locale === 'uk' ? 2 : 3);
    const html = await readFile(r.artifacts.find(a => a.kind === 'report.html')!.path, 'utf8'); expect(html).not.toContain('<script>');
    const replay = await executeOperation('report', { replayReportId: r.identifiers.reportId }, services, a.identifiers.runId);
    expect(replay.error, JSON.stringify(replay.error)).toBeUndefined(); expect(replay.summary.verification).toMatchObject({ pages: checked.pages });
    if (locale === 'uk') {
      // Layout stress fixture, not an extra analytical dataset: 25 distinct labels and all five issue notices.
      const dense = await services.store.read(['runs', a.identifiers.runId!, 'analysis.json'], analysisSchema);
      const study = dense.topicStudy!, cell = study.coverage[0]!;
      study.coverage = Array.from({ length: 25 }, (_, i) => ({ ...cell, qid: `Q${i + 10000}`, label: `Навчальна концепція ${i + 1}: довга українська назва теми`, url: `https://uk.wikipedia.org/wiki/Тест_${i + 1}` }));
      study.languages[0]!.plannedCore = 25; study.languages[0]!.includedCore = 25;
      study.issues = knownDataIssues({ start: '2024-09-01', end: '2026-08-31' });
      const html = buildHtml(dense, selectPresentation(dense, 'uk'), { absolute: '<svg></svg>', relative: '<svg></svg>' }, await fontCss());
      const printed = await printPdf(html.html);
      expect((await verifyPdf(printed.pdf, [...html.requiredText, 'концепція 25'], html.expectedNumbers)).pages).toBe(3);
    }
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); await rm(root, { recursive: true, force: true }); }
}, 60000);
