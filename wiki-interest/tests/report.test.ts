import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeOperation } from '../src/operations/index.js';
import { createServices, readRun, type Services } from '../src/research.js';
import { FileStore, sha256 } from '../src/storage.js';
import { analysisSchema, buildAnalysis, seriesCsv, type Analysis } from '../src/analysis.js';
import { buildHtml, selectPresentation } from '../src/reporting/template.js';
import { renderChart } from '../src/reporting/charts.js';
import { fontCss } from '../src/reporting/resources.js';
import { printPdf, verifyPdf } from '../src/reporting/pdf.js';
import { escapeHtml, text, shorten } from '../src/reporting/locale.js';

const plan = { source: 'fixtures', fixtureId: 'demo-v1', topics: [{ topicId: 'astronomy', label: 'Астрономія — Český Łódź <script>alert(1)</script> & "Україна" '.repeat(3), concepts: [{ qid: 'Q333' }] }, { topicId: 'science', label: 'Науки', concepts: [{ qid: 'Q333' }, { qid: 'Q413' }] }], languages: ['uk', 'pl', 'cs'], period: { start: '2021-01-01', end: '2022-12-31' } };
describe('Локальний PDF та незмінні звіти', () => {
  let root: string, services: Services, runId: string, analysis: Analysis, fonts: string;
  const reports: { id: string; directory: string }[] = [];
  beforeAll(async () => {
    root = await mkdtemp(join(await realpath(tmpdir()), 'wiki-interest-report-'));
    services = createServices({ store: new FileStore(root), clock: { now: () => new Date('2023-01-15T12:00:00Z') }, log: () => {} });
    const created = await executeOperation('analyze', plan, services);
    expect(created.status, JSON.stringify(created.error)).toBe('partial'); runId = created.identifiers.runId!;
    analysis = await services.store.read(['runs', runId, 'analysis.json'], analysisSchema);
    fonts = await fontCss();
  }, 30000);
  afterAll(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

  for (const locale of ['uk', 'en', 'ru'] as const) it(`створює справжній A4 PDF із джерелами PDF ${locale}, без мережі та без перезапису`, async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'));
    const before = await services.store.readBytes(['runs', runId, 'manifest.json']);
    const result = await executeOperation('report', locale === 'uk' ? {} : { locale }, services, runId);
    expect(result.status, JSON.stringify(result.error)).toBe('partial');
    expect(result.summary.locale).toBe(locale); expect(result.summary.networkRequests).toBe(0);
    expect(result.summary.verification).toMatchObject({ pages: 2, numbersVerified: 18, pdfRendered: true });
    expect(network).not.toHaveBeenCalled(); network.mockRestore();
    const directory = services.store.path('reports', runId, result.identifiers.reportId!);
    reports.push({ id: result.identifiers.reportId!, directory });
    expect(new Set(reports.map(r => r.id)).size).toBe(reports.length);
    const pdf = await readFile(join(directory, 'report.pdf'));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const verified = await verifyPdf(pdf, [text[locale].title, text[locale].quality, runId, '109500', '-20%'], []);
    expect(verified.pages).toBe(2); expect(verified.widthPoints).toBeCloseTo(595, 0);
    expect(verified.text).toContain('Český'); expect(verified.text).toContain('Łódź');
    const html = await readFile(join(directory, 'report.html'), 'utf8');
    expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('overflow: hidden');
    const saved = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    expect(saved.omittedRows).toHaveLength(2); expect(saved.shortenedLabels).toEqual(['astronomy']);
    expect(saved.artifacts['analysis.json']).toBe(sha256(await readFile(join(directory, 'analysis.json'))));
    expect(await services.store.readBytes(['runs', runId, 'manifest.json'])).toEqual(before);
    const savedAnalysis = analysisSchema.parse(JSON.parse(await readFile(join(directory, 'analysis.json'), 'utf8')));
    expect(savedAnalysis.entries.map(e => e.language)).toEqual(['uk', 'pl', 'cs', 'uk', 'pl', 'cs']);
  }, 30000);

  it('відтворює звіт із власних знімків після видалення вихідного run та кешу', async () => {
    const original = reports[0]!;
    const bytes = await readFile(join(original.directory, 'manifest.json'));
    for (const folder of ['runs', 'cache', 'snapshots']) await rm(join(root, folder), { recursive: true, force: true });
    const replayed = await executeOperation('report', { replayReportId: original.id }, services, runId);
    expect(replayed.status, JSON.stringify(replayed.error)).toBe('partial');
    expect(replayed.identifiers.parentReportId).toBe(original.id);
    expect(replayed.identifiers.reportId).not.toBe(original.id);
    const copy = services.store.path('reports', runId, replayed.identifiers.reportId!);
    for (const file of ['analysis.json', 'series.json', 'chart-absolute.svg', 'chart-relative.svg', 'report.html', 'series.csv']) expect(await readFile(join(copy, file))).toEqual(await readFile(join(original.directory, file)));
    expect(await readFile(join(original.directory, 'manifest.json'))).toEqual(bytes);
    await writeFile(join(original.directory, 'analysis.json'), '{}');
    const corrupt = await executeOperation('report', { replayReportId: original.id }, services, runId);
    expect(corrupt.error?.code).toBe('CHECKSUM_MISMATCH');
  }, 30000);

  it('приймає лише знайдені findings і не дозволяє довільні числові значення', () => {
    expect(() => selectPresentation(analysis, 'uk', undefined, ['invented'])).toThrow();
    const id = analysis.findings.find(f => f.type === 'annual_change')!.id;
    expect(selectPresentation(analysis, 'uk', undefined, [id]).findingIds).toEqual([id]);
    expect(() => selectPresentation(analysis, 'uk', ['science:uk'], [id])).toThrow();
    expect(escapeHtml('<img src=x onerror="alert(1)"> &')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp;');
  });

  it('strict-вхід відхиляє числа моделі та зміну locale під час replay', async () => {
    expect((await executeOperation('report', { values: { views: 123 } }, services, runId)).error?.code).toBe('VALIDATION_ERROR');
    expect((await executeOperation('report', { replayReportId: reports[0]!.id, locale: 'en' }, services, runId)).error?.code).toBe('VALIDATION_ERROR');
  });

  it('відсутність даних зберігає пропуски, пояснення та PDF', async () => {
    const created = await executeOperation('analyze', { ...plan, topics: [{ topicId: 'missing', label: 'Відсутні дані', concepts: [{ qid: 'Q413' }] }], languages: ['cs'] }, services);
    const result = await executeOperation('report', {}, services, created.identifiers.runId);
    expect(result.status, JSON.stringify(result.error)).toBe('partial');
    const path = result.artifacts.find(a => a.kind === 'report.pdf')!.path;
    const verified = await verifyPdf(await readFile(path), ['немає даних', 'недостатньо даних'], []);
    expect(verified.pages).toBe(1);
  }, 30000);

  it('PDF містить повні рядки чисел із analysis; неправильне число не проходить перевірку', async () => {
    const pdf = await readFile(join(reports[1]!.directory, 'report.pdf'));
    await expect(verifyPdf(pdf, ['1. T1 / cs 999999 150 100% -20%'], [])).rejects.toMatchObject({ code: 'PDF_CONTENT_MISMATCH' });
    await expect(verifyPdf(new Uint8Array([1, 2, 3]), [], [])).rejects.toMatchObject({ code: 'PDF_INVALID' });
  });

  it('перевіряє переповнення до друку, не ховає вміст і не друкує лише сторінку 1', async () => {
    await expect(printPdf('<!doctype html><style>main{height:3300px;width:718px}</style><main>Завеликий вміст</main>')).rejects.toMatchObject({ code: 'REPORT_OVERFLOW' });
    const source = await readFile(new URL('../src/reporting/pdf.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('pageRanges');
  }, 30000);

  it('приймає 1–3 сторінки, рендерить кожну; відхиляє 4 та не-A4', async () => {
    for (const count of [1, 2, 3, 4]) {
      const printed = await printPdf(`<style>${fonts} @page{size:A4} main{width:600px}</style><main>${Array.from({ length: count }, (_, i) => `<p style="${i ? 'break-before:page' : ''}">Сторінка ${i + 1}</p>`).join('')}</main>`);
      if (count === 4) await expect(verifyPdf(printed.pdf, [], [])).rejects.toMatchObject({ code: 'PDF_PAGE_COUNT' });
      else { const verified = await verifyPdf(printed.pdf, [`Сторінка ${count}`], []); expect(verified.pages).toBe(count); expect(verified.previews).toHaveLength(count); }
    }
    const wrongSize = await printPdf(`<style>${fonts} @page{size:A5} main{width:400px}</style><main>Не A4</main>`);
    await expect(verifyPdf(wrongSize.pdf, [], [])).rejects.toMatchObject({ code: 'PDF_NOT_A4' });
  }, 30000);

  it('графіки мають однаковий календар, null не з’єднується; CSV не підміняє пропуски нулями', async () => {
    const created = await executeOperation('analyze', plan, services), saved = await readRun(created.identifiers.runId!, services);
    saved.dataset.topics[0]!.points[5]!.views = null;
    const partial = buildAnalysis(saved.manifest, saved.dataset);
    const row = partial.entries[0]!;
    expect(row.metrics.monthly[0]!.views.value).toBeNull();
    const svg = renderChart([row], 'uk', 'absolute', fonts);
    expect(svg).toContain('<svg'); expect(svg).toContain('Місячна сума'); expect(svg).toContain('data:font/woff2;base64,');
    expect(svg).not.toContain('<script');
    const different = structuredClone(row); different.metrics.monthly.pop();
    expect(() => renderChart([row, different], 'uk', 'absolute')).toThrow();
    const csv = seriesCsv(partial, saved.dataset);
    expect(csv).toContain('"2021-01-06",,"100000",');
    const template = buildHtml(partial, selectPresentation(partial, 'uk', [row.id]), { absolute: svg, relative: renderChart([row], 'uk', 'relative') }, fonts);
    expect(template.requiredText).toContain(`1. ${shorten(plan.topics[0]!.label, 42)} / uk — — — —`);
  }, 30000);
});
