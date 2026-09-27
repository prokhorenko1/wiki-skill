import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { analysisSchema, buildAnalysis, seriesCsv, type Analysis } from '../analysis.js';
import { AppError, asError } from '../errors.js';
import { datasetSchema, manifestSchema, type Dataset, type Manifest } from '../models.js';
import { readRun, type Services } from '../research.js';
import { idSchema, type Output } from '../schemas.js';
import { canonical, FileStore, sha256 } from '../storage.js';
import { renderChart } from './charts.js';
import { printPdf, verifyPdf } from './pdf.js';
import { dependencyVersions, fontCss } from './resources.js';
import { buildHtml, selectPresentation, type Presentation } from './template.js';
import { compactSources } from '../source-links.js';

const uniqueIds = (max: number) => z.array(z.string().min(1).max(220)).min(1).max(max).refine(ids => new Set(ids).size === ids.length, 'ID не повинні повторюватися.');
export const reportSchema = z.strictObject({
  locale: z.enum(['uk', 'en', 'ru']).optional(), rowIds: uniqueIds(4).optional(), findingIds: uniqueIds(3).optional(), replayReportId: idSchema.optional(),
}).refine(input => !input.replayReportId || (!input.locale && !input.rowIds && !input.findingIds), 'Відтворення звіту не допускає зміни представлення.');
const reportManifestSchema = z.object({
  schemaVersion: z.enum(['2.0.0', '3.0.0']), templateVersion: z.enum(['1.0.0', '3.0.0', '4.0.0', '5.0.0']), reportId: idSchema, runId: idSchema, parentReportId: idSchema.optional(), createdAt: z.iso.datetime(),
  presentation: z.object({ locale: z.enum(['uk', 'en', 'ru']), rowIds: z.array(z.string()), findingIds: z.array(z.string()) }),
  renderer: z.object({ dependencies: z.record(z.string(), z.string()), browserVersion: z.string() }),
  chartMode: z.enum(['both', 'absolute', 'relative']),
  artifacts: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  omittedRows: z.array(z.string()), omittedFindings: z.array(z.string()), shortenedLabels: z.array(z.string()),
  verification: z.object({ pages: z.number().int().min(1).max(3), widthPoints: z.number(), heightPoints: z.number(), requiredSectionsVerified: z.boolean(), numbersVerified: z.number(), pdfRendered: z.boolean(), visualReview: z.literal('pending'), layoutHeight: z.number(), layoutLimit: z.number() }),
});

export async function reportOperation(runId: string, input: z.infer<typeof reportSchema>, services: Services): Promise<Output> {
  idSchema.parse(runId);
  const checked = reportSchema.parse(input), reportId = randomUUID(), base = ['reports', runId, reportId];
  const store = services.store;
  let manifest: Manifest, dataset: Dataset, analysis: Analysis, presentation: Presentation;
  let oldBase: string[] | undefined;
  let oldTemplateVersion: string | undefined;
  let chartMode: 'both' | 'absolute' | 'relative' = 'both';
  if (checked.replayReportId) {
    oldBase = ['reports', runId, checked.replayReportId];
    const old = await store.read([...oldBase, 'manifest.json'], reportManifestSchema);
    oldTemplateVersion = old.templateVersion;
    if (old.runId !== runId || old.reportId !== checked.replayReportId) throw new AppError('REPORT_ID_MISMATCH', 'Ідентифікатор звіту не відповідає manifest.');
    if (canonical(old.renderer.dependencies) !== canonical(dependencyVersions())) throw new AppError('RENDERER_VERSION_MISMATCH', 'Для відтворення потрібні збережені версії залежностей рендерингу.', { required: old.renderer.dependencies });
    for (const filename of Object.keys(old.artifacts)) {
      if (!old.artifacts[filename] || sha256(await store.readBytes([...oldBase, filename])) !== old.artifacts[filename]) throw new AppError('CHECKSUM_MISMATCH', 'Артефакт звіту не відповідає checksum.', { filename });
    }
    manifest = await store.read([...oldBase, 'source-manifest.json'], manifestSchema);
    dataset = await store.read([...oldBase, 'series.json'], datasetSchema);
    analysis = await store.read([...oldBase, 'analysis.json'], analysisSchema);
    if (manifest.runId !== runId || analysis.runId !== runId || sha256(`${canonical(dataset)}\n`) !== manifest.seriesChecksum) throw new AppError('CHECKSUM_MISMATCH', 'Дані звіту не відповідають дослідженню.');
    const ownStore = new FileStore(store.path(...oldBase));
    for (const ref of manifest.snapshots) await ownStore.loadSnapshot(ref);
    presentation = selectPresentation(analysis, old.presentation.locale, old.presentation.rowIds, old.presentation.findingIds);
    chartMode = old.chartMode;
  } else {
    ({ manifest, dataset } = await readRun(runId, services));
    analysis = manifest.analysisChecksum ? await store.read(['runs', runId, 'analysis.json'], analysisSchema) : buildAnalysis(manifest, dataset);
    presentation = selectPresentation(analysis, checked.locale ?? 'uk', checked.rowIds, checked.findingIds);
  }
  const artifacts: Record<string, string> = {};
  const write = async (filename: string, value: string | Uint8Array) => { await store.writeBytes([...base, filename], value); artifacts[filename] = sha256(value); };
  const json = async (filename: string, value: unknown) => write(filename, `${canonical(value)}\n`);
  services.log(`Створення локального звіту ${reportId}, мова ${presentation.locale}.`);
  try {
    await json('analysis.json', analysis); await json('series.json', dataset); await json('source-manifest.json', manifest);
    await json('source-catalog.json', [...new Map(manifest.topics.flatMap(t => t.candidates).map(c => [c.qid, { qid: c.qid, complete: c.sitelinkCatalogComplete ?? false, links: c.sitelinkCatalog ?? [], verification: 'discovered' }])).values()]);
    if (analysis.topicStudy && manifest.topicPlan) {
      await json('topic-plan.json', manifest.topicPlan); await json('discovery.json', manifest.topicPlan.discovery);
      await json('coverage.json', analysis.topicStudy.coverage);
      await json('contributions.json', analysis.topicStudy.languages.map(l => ({ language: l.language, contributions: l.contributions, sum: l.contributionSum })));
      await json('sensitivity.json', analysis.topicStudy.languages.map(l => ({ language: l.language, ...l.sensitivity })));
    }
    await write('series.csv', seriesCsv(analysis, dataset));
    const origin = oldBase ? new FileStore(store.path(...oldBase)) : store;
    for (const ref of manifest.snapshots) await store.write([...base, 'snapshots', `${ref.snapshotId}.json`], await origin.loadSnapshot(ref));
    const fonts = await fontCss(), rows = presentation.rowIds.map(id => analysis.entries.find(e => e.id === id)!);
    const labels = Object.fromEntries(analysis.topics.map(t => {
      const role = analysis.topicStudy?.rows.find(r => r.id.startsWith(`${t.topicId}:`))?.role;
      const label = role === 'core' ? { uk: 'Основний набір', en: 'Core basket', ru: 'Основной набор' }[presentation.locale] : role === 'root' ? { uk: 'Коренева стаття', en: 'Root article', ru: 'Корневая статья' }[presentation.locale] : t.label;
      return [t.topicId, label.length > 27 ? `${label.slice(0, 26)}…` : label];
    }));
    const absolute = oldBase ? (await store.readBytes([...oldBase, 'chart-absolute.svg'])).toString('utf8') : renderChart(rows, presentation.locale, 'absolute', fonts, labels);
    const relative = oldBase ? (await store.readBytes([...oldBase, 'chart-relative.svg'])).toString('utf8') : renderChart(rows, presentation.locale, 'relative', fonts, labels);
    await write('chart-absolute.svg', absolute); await write('chart-relative.svg', relative);
    let template = buildHtml(analysis, presentation, { absolute, relative }, fonts, chartMode);
    let html = oldBase ? (await store.readBytes([...oldBase, 'report.html'])).toString('utf8') : template.html;
    let printed;
    try { printed = await printPdf(html); }
    catch (error) {
      if (error instanceof AppError && error.code === 'REPORT_OVERFLOW' && !oldBase) {
        chartMode = analysis.criterion === 'relativeInterestChange' ? 'relative' : 'absolute';
        template = buildHtml(analysis, presentation, { absolute, relative }, fonts, chartMode); html = template.html;
        await write('report.html', html);
        printed = await printPdf(html);
      } else { await write('report.html', html); throw error; }
    }
    if (!artifacts['report.html']) await write('report.html', html);
    // A stored report replays its original HTML, not today's wording or row labels.
    const requiredText = oldBase ? [(await store.readBytes([...oldBase, 'report-text.txt'])).toString('utf8')] : template.requiredText;
    const requiredUrls = [...html.matchAll(/href="(https:[^"]+)"/g)].map(m => m[1]!.replaceAll('&amp;', '&').replaceAll('&#39;', "'").replaceAll('&quot;', '"'));
    const verified = await verifyPdf(printed.pdf, requiredText, template.expectedNumbers, requiredUrls);
    await json('link-verification.json', { status: 'passed', requiredUrls: [...new Set(requiredUrls)], pdfAnnotationUrls: verified.links, sourceIds: analysis.articleSources?.pages.map(s => s.sourceId) ?? [] });
    await write('report.pdf', printed.pdf); await write('report-preview.png', verified.preview); await write('report-text.txt', verified.text);
    for (const [i, preview] of verified.previews.entries()) await write(`report-page-${i + 1}.png`, preview);
    const saved = reportManifestSchema.parse({ schemaVersion: '3.0.0', templateVersion: oldTemplateVersion ?? '5.0.0', reportId, runId, parentReportId: checked.replayReportId, createdAt: services.clock.now().toISOString(), presentation,
      renderer: { dependencies: dependencyVersions(), browserVersion: printed.browserVersion }, artifacts,
      chartMode,
      omittedRows: template.omittedRows, omittedFindings: template.omittedFindings, shortenedLabels: template.shortenedLabels,
      verification: { pages: verified.pages, widthPoints: verified.widthPoints, heightPoints: verified.heightPoints, requiredSectionsVerified: true, numbersVerified: template.expectedNumbers.length, pdfRendered: true, visualReview: 'pending', layoutHeight: printed.layout.height, layoutLimit: printed.layout.limit },
    });
    await store.write([...base, 'manifest.json'], saved);
    return { status: analysis.entries.some(e => e.diagnostic.status !== 'stable') || template.omittedRows.length ? 'partial' : 'ok', identifiers: { runId, reportId, ...(checked.replayReportId ? { parentReportId: checked.replayReportId } : {}) },
      summary: { source: analysis.source, articleSources: compactSources(manifest), locale: presentation.locale, period: analysis.period, selectedRows: presentation.rowIds, selectedFindings: presentation.findingIds, omittedRows: template.omittedRows, omittedFindingCount: template.omittedFindings.length,
        displayedRows: analysis.entries.filter(e => !template.omittedRows.includes(e.id)).map(e => e.id), displayedFindingCount: analysis.findings.length - template.omittedFindings.length,
        quality: analysis.topicStudy ? analysis.topicStudy.languages.map(l => ({ language: l.language, ...l.quality, conclusion: l.conclusion })) : rows.map(e => ({ id: e.id, kind: e.diagnostic.kind, status: e.diagnostic.status, warningCodes: e.diagnostic.reasons.map(r => r.code) })), verification: saved.verification, networkRequests: 0 },
      warnings: [{ code: 'DIAGNOSTIC_HEURISTIC', message: 'Якість — діагностична евристика, не статистична ймовірність.' }, ...(analysis.source === 'fixtures' ? [{ code: 'SYNTHETIC_DATA', message: 'Звіт містить явно синтетичні тестові дані.' }] : []), ...(template.omittedRows.length ? [{ code: 'SHORT_REPRESENTATION', message: 'PDF містить коротке представлення; виключені рядки названі, повні дані збережені.' }] : []), { code: 'VISUAL_REVIEW_PENDING', message: 'PDF автоматично перевірено й відрендерено; перегляньте всі report-page-N.png для візуального контролю.' }],
      artifacts: ['manifest.json', ...Object.keys(artifacts)].map(filename => ({ kind: filename, path: store.path(...base, filename) })),
      nextAction: { operation: 'report', message: 'Перегляньте PDF і його PNG; іншу мову або вибір findings задайте новою операцією report.' },
    };
  } catch (error) {
    const problem = asError(error);
    await store.write([...base, 'failure.json'], { code: problem.code, message: problem.message, details: problem.details });
    throw new AppError(problem.code, problem.message, { ...problem.details, reportId, artifactsDirectory: store.path(...base) });
  }
}
