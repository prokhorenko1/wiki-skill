import { randomUUID } from 'node:crypto';
import { runtimeRoot } from './environment.js';
import { AppError } from './errors.js';
import { systemClock, getPeriod, type Clock } from './calendar.js';
import { SCHEMA_VERSION, METHODOLOGY_VERSION, analyzeSchema, idSchema, warning, type AnalyzeInput, type ResolveInput, type ReviseInput, type Output, type Warning, type SourceOptions } from './schemas.js';
import { FileStore, canonical, sha256, type SnapshotRef } from './storage.js';
import { HttpClient, type Transport } from './http.js';
import { FixtureTransport } from './fixtures.js';
import { DataGateway } from './gateway.js';
import { Resolver, buildCoverage, type Candidate } from './resolver.js';
import { SeriesLoader, type Series } from './series.js';
import { aggregatePages, calculate } from './calculations.js';
import { datasetSchema, manifestSchema, resolutionSchema, type Dataset, type Manifest } from './models.js';
import { buildAnalysis, seriesCsv } from './analysis.js';
import { topicPlanSchema, type TopicPlan } from './topic-plan.js';
import { buildTopicStudy } from './topic-analysis.js';
import type { Completion } from './completion-types.js';
import { useReviewedSources } from './source-operations.js';
import { sourceSummary } from './source-evidence.js';
import { compactSources } from './source-links.js';
import { requestSchema, projectName } from './requests.js';

export interface Services {
  store: FileStore; clock: Clock; transport?: Transport; fixtureTransport?: Transport;
  log: (message: string) => void;
}
export function createServices(overrides: Partial<Services> = {}): Services {
  return { store: new FileStore(runtimeRoot), clock: systemClock, log: message => process.stderr.write(`${message}\n`), ...overrides };
}
export function gateway(services: Services, options: SourceOptions, replay?: SnapshotRef[], maxRequests?: number, preferredRefs?: SnapshotRef[]): DataGateway {
  const transport = options.source === 'fixtures' ? services.fixtureTransport ?? new FixtureTransport() : services.transport ?? new HttpClient({ clock: services.clock, log: services.log });
  return new DataGateway(services.store, options, services.clock, transport, replay, maxRequests, preferredRefs);
}
const dedupeWarnings = (warnings: Warning[]): Warning[] => [...new Map(warnings.map(w => [canonical(w), w])).values()];

export async function resolveOperation(input: ResolveInput, services: Services, originalRequest: unknown = input): Promise<Output> {
  const data = gateway(services, input);
  const candidates = await new Resolver(data).resolve(input);
  const resolutionId = randomUUID();
  const saved = resolutionSchema.parse({ schemaVersion: SCHEMA_VERSION, resolutionId, createdAt: services.clock.now().toISOString(), source: input.source, query: originalRequest, candidates, snapshots: data.snapshots });
  const path = await services.store.write(['resolutions', `${resolutionId}.json`], saved);
  await services.store.write(['logs', `${resolutionId}.json`], { operation: 'resolve', resolutionId, createdAt: saved.createdAt, source: input.source, candidateCount: candidates.length, dataAccess: data.stats });
  const warnings = dedupeWarnings(candidates.flatMap(c => c.warnings));
  if (input.source === 'fixtures') warnings.unshift(warning('SYNTHETIC_DATA', 'Це синтетичні fixtures, а не живі дані Wikimedia.'));
  return { status: candidates.length ? (input.qid || input.articleUrl ? 'ok' : 'needs_selection') : 'needs_selection', identifiers: { resolutionId },
    summary: { source: input.source, candidates: candidates.map(c => ({ qid: c.qid, requestedQid: c.requestedQid, label: c.label, description: c.description, sitelinkCount: c.sitelinkCatalog?.length, articles: c.articles.map(a => ({ ...a, source: a.source && sourceSummary(a.source), evidence: a.evidence && { ...a.evidence, candidates: a.evidence.candidates.map(sourceSummary) } })), missingLanguages: c.articles.filter(a => a.status !== 'found').map(a => a.language) })), dataAccess: data.stats },
    warnings, artifacts: [{ kind: 'resolution', path }], nextAction: { operation: candidates.length ? 'analyze' : 'resolve', message: candidates.length ? 'Явно виберіть QID; не вважайте перший результат правильним автоматично.' : 'Уточніть формулювання або задайте відомий QID.' } };
}

export function runOutput(manifest: Manifest, services: Services): Output {
  const criterion = manifest.request.criterion;
  const comparison = manifest.report.map(row => {
    const periodSummary = row.recovery?.periodSummary ?? row.metrics;
    const annual = row.recovery?.yearOverYear ?? row.metrics.yearOverYear, recent = row.recovery?.lastThreeMonths ?? row.metrics.lastThreeMonths;
    const metric = criterion === 'views' ? periodSummary.totalViews : criterion === 'yearOverYear' ? annual.changePercent : annual.relativeChangePercent;
    return { topicId: row.topicId, language: row.language, sourceIds: manifest.topics.find(t => t.topic.topicId === row.topicId)?.coverage.pages[row.language]?.flatMap(p => p.source ? [p.source.sourceId] : []) ?? [], criterion, metric, totalViews: periodSummary.totalViews,
      dailyAverage: periodSummary.dailyAverage, perMillion: periodSummary.perMillion, periodMethod: row.recovery?.periodSummary?.method,
      yearOverYear: { ...annual, excludedDates: undefined, excludedDateCount: row.recovery?.yearOverYear.excludedDates.length }, lastThreeMonths: { ...recent, excludedDates: undefined, excludedDateCount: row.recovery?.lastThreeMonths.excludedDates.length }, quality: row.metrics.quality };
  }).sort((a, b) => {
    if (a.metric.value === null && b.metric.value !== null) return 1;
    if (b.metric.value === null && a.metric.value !== null) return -1;
    return (b.metric.value ?? 0) - (a.metric.value ?? 0) || a.topicId.localeCompare(b.topicId, 'en') || a.language.localeCompare(b.language, 'en');
  });
  const partial = manifest.report.some(r => !r.metrics.quality.complete) || manifest.topics.some(t => t.coverage.excludedQids.length > 0);
  const warnings = manifest.warnings.slice(0, 20);
  if (comparison.length > 10) warnings.push(warning('COMPARISON_TRUNCATED', 'У summary показано перші 10 рядків; усі результати доступні в manifest.', { total: comparison.length }));
  if (manifest.warnings.length > 20) warnings.push(warning('WARNINGS_TRUNCATED', 'Повний перелік попереджень збережено у manifest.', { total: manifest.warnings.length }));
  return { status: partial ? 'partial' : 'ok', identifiers: { runId: manifest.runId, ...(manifest.parentRunId ? { parentRunId: manifest.parentRunId } : {}) },
    summary: { source: manifest.source, dataMode: manifest.mode === 'replay' ? 'replay' : manifest.request.source, mode: manifest.mode, period: manifest.request.period, criterion,
      researchMode: manifest.request.mode ?? 'article', compositionVersion: manifest.topicPlan?.compositionVersion, completion: manifest.completion ? { ...manifest.completion, mapping: manifest.completion.mapping.map(m => ({ ...m, evidence: undefined })) } : undefined, articleSources: compactSources(manifest),
      comparison: comparison.slice(0, 10), comparisonCount: comparison.length, coverage: manifest.topics.slice(0, 10).map(t => ({ topicId: t.topic.topicId, label: t.topic.label, includedQids: t.coverage.includedQids, excludedQids: t.coverage.excludedQids, matrix: t.coverage.matrix, pageCounts: Object.fromEntries(Object.entries(t.coverage.pages).map(([l, pages]) => [l, pages.length])) })),
      dataAccess: manifest.dataAccess, schemaVersion: manifest.schemaVersion, methodologyVersion: manifest.methodologyVersion, diagnosticVersion: manifest.diagnosticVersion, diagnostics: manifest.diagnostics?.slice(0, 10) },
    warnings, artifacts: [{ kind: 'manifest', path: services.store.path('runs', manifest.runId, 'manifest.json') }, { kind: 'series', path: services.store.path('runs', manifest.runId, 'series.json') }, ...(manifest.analysisChecksum ? [{ kind: 'analysis', path: services.store.path('runs', manifest.runId, 'analysis.json') }, { kind: 'csv', path: services.store.path('runs', manifest.runId, 'series.csv') }] : []), ...Object.keys(manifest.artifactChecksums ?? {}).map(name => ({ kind: name, path: services.store.path('runs', manifest.runId, name) }))],
    nextAction: { operation: 'revise', message: 'Змініть припущення через revise; старе дослідження залишиться незмінним.' } };
}

export async function saveRun(manifest: Manifest, dataset: Dataset, services: Services): Promise<Output> {
  manifest.pageviewRequests = [];
  const pages = manifest.topics.flatMap(t => Object.values(t.coverage.pages).flat());
  for (const ref of manifest.snapshots.filter(s => s.url.includes('/metrics/pageviews/'))) {
    const snapshot = await services.store.loadSnapshot(ref), request = requestSchema.parse(snapshot.request);
    if (request.kind !== 'article' && request.kind !== 'project') continue;
    const page = request.kind === 'article' ? pages.find(p => p.language === request.language && p.title === request.title) : undefined;
    manifest.pageviewRequests.push({ sourceId: page?.source?.sourceId ?? null, kind: request.kind, project: projectName(request.language), title: request.kind === 'article' ? request.title : null,
      access: request.filters.access, agent: request.filters.agent, granularity: request.granularity ?? 'daily', start: request.period.start, end: request.period.end,
      requestUrl: ref.url, fetchedAt: ref.receivedAt, snapshotId: ref.snapshotId, snapshotPath: `snapshots/${ref.snapshotId}.json` });
  }
  const checkedData = datasetSchema.parse(dataset);
  manifest.seriesChecksum = sha256(`${canonical(checkedData)}\n`);
  const analysis = buildAnalysis(manifest, checkedData);
  for (const row of manifest.report) {
    const recovery = analysis.entries.find(e => e.topicId === row.topicId && e.language === row.language)?.recovery;
    if (recovery) row.recovery = recovery;
  }
  manifest.analysisChecksum = sha256(`${canonical(analysis)}\n`);
  manifest.diagnosticVersion = '3.0.0';
  manifest.diagnostics = analysis.entries.map(e => ({ id: e.id, kind: e.diagnostic.kind, status: e.diagnostic.status, reasons: e.diagnostic.reasons }));
  if (manifest.topicPlan && analysis.topicStudy) {
    const files = { 'topic-plan.json': manifest.topicPlan, 'discovery.json': manifest.topicPlan.discovery, 'coverage.json': analysis.topicStudy.coverage,
      'contributions.json': analysis.topicStudy.languages.map(l => ({ language: l.language, contributions: l.contributions, sum: l.contributionSum })),
      'sensitivity.json': analysis.topicStudy.languages.map(l => ({ language: l.language, comparisons: l.comparisons, ...l.sensitivity })) };
    manifest.artifactChecksums = {};
    for (const [filename, value] of Object.entries(files)) { await services.store.write(['runs', manifest.runId, filename], value); manifest.artifactChecksums[filename] = sha256(`${canonical(value)}\n`); }
  }
  const catalog = [...new Map(manifest.topics.flatMap(t => t.candidates).map(c => [c.qid, { qid: c.qid, complete: c.sitelinkCatalogComplete ?? false, links: c.sitelinkCatalog ?? [], note: 'Знайдені метадані, не перелік проаналізованих статей.' }])).values()];
  await services.store.write(['runs', manifest.runId, 'source-catalog.json'], catalog);
  manifest.artifactChecksums = { ...manifest.artifactChecksums, 'source-catalog.json': sha256(`${canonical(catalog)}\n`) };
  const checked = manifestSchema.parse(manifest);
  await services.store.write(['runs', checked.runId, 'series.json'], checkedData);
  await services.store.write(['runs', checked.runId, 'analysis.json'], analysis);
  await services.store.writeBytes(['runs', checked.runId, 'series.csv'], seriesCsv(analysis, checkedData));
  await services.store.write(['logs', `${checked.runId}.json`], { operation: checked.mode, runId: checked.runId, parentRunId: checked.parentRunId, createdAt: checked.createdAt, source: checked.source, dataAccess: checked.dataAccess, warningCodes: [...new Set(checked.warnings.map(w => w.code))] });
  await services.store.write(['runs', checked.runId, 'manifest.json'], checked);
  const output = runOutput(checked, services);
  if (analysis.recoveryEnabled) { output.summary.recoveredMetrics = analysis.entries.map(e => ({ id: e.id, language: e.language, recovery: e.recovery ? { yearOverYear: { ...e.recovery.yearOverYear, excludedDates: undefined, excludedDateCount: e.recovery.yearOverYear.excludedDates.length }, lastThreeMonths: { ...e.recovery.lastThreeMonths, excludedDates: undefined, excludedDateCount: e.recovery.lastThreeMonths.excludedDates.length } } : null })); }
  if (analysis.topicStudy) { output.summary.topic = analysis.topicStudy.languages.map(l => ({ language: l.language, conclusion: l.conclusion, comparisons: l.comparisons, quality: l.quality, coveragePercent: l.coveragePercent })); if (analysis.topicStudy.languages.some(l => l.quality.stability !== 'stable')) output.status = 'partial'; }
  return output;
}

export async function readRun(runId: string, services: Services, verify = true): Promise<{ manifest: Manifest; dataset: Dataset }> {
  idSchema.parse(runId);
  const manifest = await services.store.read(['runs', runId, 'manifest.json'], manifestSchema);
  if (manifest.runId !== runId) throw new AppError('RUN_ID_MISMATCH', 'runId не відповідає manifest.');
  const dataset = await services.store.read(['runs', runId, 'series.json'], datasetSchema);
  if (sha256(`${canonical(dataset)}\n`) !== manifest.seriesChecksum) throw new AppError('CHECKSUM_MISMATCH', 'Розраховані ряди не відповідають контрольній сумі.');
  if (manifest.analysisChecksum && sha256(await services.store.readBytes(['runs', runId, 'analysis.json'])) !== manifest.analysisChecksum) throw new AppError('CHECKSUM_MISMATCH', 'analysis.json не відповідає контрольній сумі.');
  for (const [filename, checksum] of Object.entries(manifest.artifactChecksums ?? {})) if (sha256(await services.store.readBytes(['runs', runId, filename])) !== checksum) throw new AppError('CHECKSUM_MISMATCH', 'Артефакт тематичного дослідження змінено.', { filename });
  if (verify) for (const ref of manifest.snapshots) await services.store.loadSnapshot(ref);
  return { manifest, dataset };
}

export async function analyzeOperation(input: AnalyzeInput, services: Services, options: { parentRunId?: string; mode?: Manifest['mode']; replayRefs?: SnapshotRef[]; preferredRefs?: SnapshotRef[]; originalRequest?: unknown; skipResolutionCheck?: boolean; previousTopics?: Manifest['topics']; topicPlan?: TopicPlan; completion?: Completion; sharedGateway?: DataGateway } = {}): Promise<Output> {
  const topicPlan = input.mode === 'topic' ? options.topicPlan ?? await services.store.read(['plans', `${input.topicPlanId}.json`], topicPlanSchema) : undefined;
  if (topicPlan) {
    const raw = (options.originalRequest ?? input) as { filters?: AnalyzeInput['filters']; changes?: { filters?: AnalyzeInput['filters'] } };
    const explicitFilters = raw.filters ?? raw.changes?.filters;
    if (canonical(input.languages) !== canonical(topicPlan.languages) || input.period && canonical(input.period) !== canonical(topicPlan.period) || explicitFilters && canonical(explicitFilters) !== canonical(topicPlan.filters)) throw new AppError('PLAN_MISMATCH', 'Мови, період і фільтри мають відповідати плану. Змініть план і створіть дочірній run.');
    if ((input.source === 'fixtures') !== (topicPlan.discovery.request.source === 'fixtures')) throw new AppError('SOURCE_MISMATCH', 'Походження плану та аналізу відрізняється.');
    const plannedTopics = [{ topicId: topicPlan.basketId, label: topicPlan.label, concepts: topicPlan.members.map(m => ({ qid: m.qid })) }];
    input = { ...input, topics: plannedTopics, queryLanguage: topicPlan.queryLanguage, period: topicPlan.period, filters: topicPlan.filters };
  }
  const request = analyzeSchema.parse({ ...input, period: getPeriod(input.period, services.clock) });
  const period = request.period!;
  const data = options.sharedGateway ?? gateway(services, request, options.replayRefs, undefined, options.preferredRefs);
  const resolver = new Resolver(data), loader = new SeriesLoader(data);
  const reviewedByQid = new Map<string, Candidate>();
  const reviewRefs: SnapshotRef[] = [];
  for (const id of options.mode === 'replay' ? [] : request.sourceResolutionIds ?? []) {
    const resolution = await services.store.read(['resolutions', `${id}.json`], resolutionSchema);
    if ((resolution.source === 'fixtures') !== (request.source === 'fixtures')) throw new AppError('SOURCE_MISMATCH', 'Походження review та аналізу відрізняється.');
    for (const c of resolution.candidates) reviewedByQid.set(c.qid, c);
    reviewRefs.push(...resolution.snapshots);
  }
  const topics: Manifest['topics'] = [];
  const warnings: Warning[] = [];
  if (request.source === 'fixtures') warnings.push(warning('SYNTHETIC_DATA', 'Це синтетичні fixtures; результати не описують реальний інтерес у Wikipedia.'));
  for (const topic of request.topics ?? []) {
    const candidates: Candidate[] = [];
    for (const concept of topic.concepts) {
      let reviewed: Candidate | undefined = reviewedByQid.get(concept.qid);
      if (concept.resolutionId && !options.skipResolutionCheck) {
        const resolution = await services.store.read(['resolutions', `${concept.resolutionId}.json`], resolutionSchema);
        if ((resolution.source === 'fixtures') !== (request.source === 'fixtures')) throw new AppError('SOURCE_MISMATCH', 'Не можна змішувати fixture resolution із живим дослідженням.');
        if (!resolution.candidates.some(c => c.qid === concept.qid)) throw new AppError('CANDIDATE_NOT_FOUND', 'Вибраний QID не належить до кандидатів resolution.', { qid: concept.qid, resolutionId: concept.resolutionId });
        reviewed = resolution.candidates.find(c => c.qid === concept.qid);
        reviewRefs.push(...resolution.snapshots);
      }
      const frozen = options.mode === 'replay' ? options.previousTopics?.flatMap(t => t.candidates).find(c => c.qid === concept.qid || c.requestedQid === concept.qid) : undefined;
      const candidate = frozen ? structuredClone(frozen) : await resolver.candidate(concept.qid, request.queryLanguage, request.languages);
      if (reviewed) useReviewedSources(candidate, reviewed);
      candidates.push(candidate); warnings.push(...candidate.warnings);
    }
    const coverageLanguages = options.completion && !topicPlan ? request.languages.filter(l => candidates.some(c => c.articles.some(a => a.language === l && a.status === 'found'))) : request.languages;
    const coverage = buildCoverage(topic, candidates, coverageLanguages.length ? coverageLanguages : request.languages);
    topics.push({ topic, candidates, coverage }); warnings.push(...coverage.warnings);
  }
  if (new Set(topics.map(t => t.coverage.includedQids.length)).size > 1) warnings.push(warning('DIFFERENT_TOPIC_BREADTH', 'Теми мають різну кількість концепцій; обсяг набору впливає на порівняння.'));
  if (options.previousTopics && canonical(topics.map(t => [t.topic.topicId, t.coverage.includedQids])) !== canonical(options.previousTopics.map(t => [t.topic.topicId, t.coverage.includedQids]))) warnings.push(warning('COMPARISON_BASIS_CHANGED', 'Склад спільного порівняння змінився відносно батьківського дослідження; перевірте склад перед порівнянням run.'));
  const seen = new Map<string, string>();
  for (const topic of topics) for (const pages of Object.values(topic.coverage.pages)) for (const page of pages) {
    const key = `${page.project}:${page.pageId}`;
    const other = seen.get(key);
    if (other && other !== topic.topic.topicId) warnings.push(warning('OVERLAPPING_TOPICS', 'Теми мають спільні сторінки; їхні перегляди не можна додавати як незалежні аудиторії.', { topics: [other, topic.topic.topicId], title: page.title, language: page.language }));
    seen.set(key, topic.topic.topicId);
  }
  const series = new Map<string, Series>();
  const report: Manifest['report'] = [];
  const derived: Dataset['topics'] = [];
  for (const topic of topics) for (const language of request.languages) {
    const project = await loader.load({ kind: 'project', language, filters: request.filters, period });
    series.set(project.id, project);
    const articleSeries: Series[] = [];
    for (const article of topic.coverage.pages[language] ?? []) {
      const page = await loader.load({ kind: 'article', language, title: article.title!, filters: request.filters, period });
      series.set(page.id, page); articleSeries.push(page);
    }
    const points = aggregatePages(articleSeries.map(s => s.points), period);
    const metrics = calculate(points, project.points, period, topic.coverage.includedQids.length === 0);
    if (metrics.monthly.some(m => !m.fullMonth)) warnings.push(warning('PARTIAL_CALENDAR_MONTH', 'Крайові місяці включені частково та не використовуються як повні місяці у річних вікнах.'));
    report.push({ topicId: topic.topic.topicId, language, metrics }); derived.push({ topicId: topic.topic.topicId, language, points });
  }
  if (topicPlan) for (const candidate of topics.flatMap(t => t.candidates)) for (const article of candidate.articles.filter(a => a.status === 'found')) {
    const page = await loader.load({ kind: 'article', language: article.language, title: article.title!, filters: request.filters, period }); series.set(page.id, page);
  }
  if (request.recoverGaps && [...series.values()].some(s => s.points.some(p => p.views === null))) {
    for (const s of series.values()) await loader.monthly(s, s.kind === 'article' ? { kind: 'article', language: s.language, title: s.title!, period, filters: request.filters } : { kind: 'project', language: s.language, period, filters: request.filters });
  }
  for (const item of series.values()) warnings.push(...item.warnings.map(w => ({ ...w, details: { ...w.details, seriesId: item.id, language: item.language, title: item.title } })));
  const dataset: Dataset = { schemaVersion: SCHEMA_VERSION, period, series: [...series.values()], topics: derived };
  if (topicPlan) {
    const { study, rows } = buildTopicStudy(topicPlan, topics, dataset);
    const allCandidates = topics.flatMap(t => t.candidates); topics.splice(0); report.splice(0); derived.splice(0);
    for (const row of rows) {
      const topicId = row.id.slice(0, row.id.lastIndexOf(':'));
      report.push({ topicId, language: row.language, metrics: row.metrics }); derived.push({ topicId, language: row.language, points: row.points });
      let saved = topics.find(t => t.topic.topicId === topicId);
      if (!saved) {
        const qids = row.role === 'core' ? topicPlan.members.filter(m => m.role === 'core').map(m => m.qid) : row.qids;
        const selected = allCandidates.filter(c => qids.includes(c.qid) || qids.includes(c.requestedQid));
        // Empty subsets retain the planned concepts for explicit unavailable rows.
        const conceptIds = qids.length ? qids : topicPlan.members.filter(m => row.role === 'subtopic' && `${topicPlan.basketId}-${m.subtopic}` === topicId).map(m => m.qid);
        if (!conceptIds.length) conceptIds.push(topicPlan.members[0]!.qid);
        const topic = { topicId, label: row.label, concepts: conceptIds.map(qid => ({ qid })) };
        const coverage = buildCoverage(topic, selected, request.languages);
        coverage.includedQids = row.qids; coverage.excludedQids = qids.filter(qid => !row.qids.includes(qid));
        saved = { topic, candidates: selected, coverage }; topics.push(saved);
      }
      saved.coverage.pages[row.language] = allCandidates.filter(c => row.qids.includes(c.qid) || row.qids.includes(c.requestedQid)).flatMap(c => c.articles.filter(a => a.language === row.language && a.status === 'found'));
    }
    for (const l of study.languages) for (const flag of l.quality.flags) warnings.push(warning(flag, l.conclusion, { language: l.language }));
  }
  const manifest: Manifest = { schemaVersion: SCHEMA_VERSION, methodologyVersion: METHODOLOGY_VERSION, runId: randomUUID(), ...(topicPlan ? { topicPlan } : {}), ...(options.completion ? { completion: options.completion } : {}),
    ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}), createdAt: services.clock.now().toISOString(), mode: options.mode ?? 'analyze',
    source: request.source === 'fixtures' ? 'fixtures' : 'wikimedia', originalRequest: options.originalRequest ?? input, request, topics, report,
    warnings: dedupeWarnings(warnings), snapshots: [...new Map([...(topicPlan?.discovery.snapshots ?? []), ...options.replayRefs ?? [], ...reviewRefs, ...data.snapshots].map(s => [s.snapshotId, s])).values()], seriesChecksum: '', dataAccess: data.stats };
  return saveRun(manifest, dataset, services);
}

export async function reviseOperation(runId: string, input: ReviseInput, services: Services): Promise<Output> {
  const parent = await readRun(runId, services);
  const onlyCriterion = Object.keys(input.changes).every(k => k === 'criterion') && input.cachePolicy === 'reuse' && !input.source;
  if (input.mode === 'replay') {
    // Дані повторно розбираються зі знімків. Відсутні блоки залишаються невідомими.
    return analyzeOperation(parent.manifest.request, services, { parentRunId: runId, mode: 'replay', replayRefs: parent.manifest.snapshots, previousTopics: parent.manifest.topics, originalRequest: input, skipResolutionCheck: true, topicPlan: parent.manifest.topicPlan, completion: parent.manifest.completion });
  }
  if (onlyCriterion) {
    const manifest: Manifest = { ...parent.manifest, runId: randomUUID(), parentRunId: runId, createdAt: services.clock.now().toISOString(), mode: 'revise', originalRequest: input,
      request: analyzeSchema.parse({ ...parent.manifest.request, ...input.changes }), dataAccess: { cacheHits: 0, fetched: 0, replayed: parent.manifest.snapshots.length } };
    return saveRun(manifest, parent.dataset, services);
  }
  const source = input.source ?? parent.manifest.request.source;
  const nextPlan = input.changes.topicPlanId ? await services.store.read(['plans', `${input.changes.topicPlanId}.json`], topicPlanSchema) : undefined;
  const request = analyzeSchema.parse({ ...parent.manifest.request, ...(nextPlan ? { languages: nextPlan.languages, period: nextPlan.period, filters: nextPlan.filters, queryLanguage: nextPlan.queryLanguage } : {}), ...input.changes, source, fixtureId: source === 'fixtures' ? 'demo-v1' : undefined, cachePolicy: input.cachePolicy });
  return analyzeOperation(request, services, { parentRunId: runId, mode: 'revise', originalRequest: input, previousTopics: parent.manifest.topics, preferredRefs: source === parent.manifest.request.source ? parent.manifest.snapshots : undefined, topicPlan: nextPlan });
}
