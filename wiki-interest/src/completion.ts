import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { analyzeSchema, languageSchema, warning, type AnalyzeInput, type Output } from './schemas.js';
import { completionSchema, languagePolicySchema, type Completion } from './completion-types.js';
import { analyzeOperation, gateway, readRun, type Services } from './research.js';
import { reportOperation, reportSchema } from './reporting/report.js';
import { Resolver, type Candidate } from './resolver.js';
import { SeriesLoader, type Series } from './series.js';
import { aggregatePages } from './calculations.js';
import { recoverComparisons } from './recovery.js';
import { analysisSchema } from './analysis.js';
import { getPeriod } from './calendar.js';
import { HttpClient, type Transport } from './http.js';
import { FixtureTransport } from './fixtures.js';
import { AppError, asError } from './errors.js';
import { canonical, sha256 } from './storage.js';
import { topicPlanSchema } from './topic-plan.js';
import { resolutionSchema } from './models.js';
import { useReviewedSources } from './source-operations.js';

export const researchSchema = z.strictObject({
  parentRunId: z.uuid().optional(),
  analysis: analyzeSchema.refine(a => a.languages.length <= 10, 'До десяти запитаних мов; до двох додаткових додає мовна політика.'),
  languagePolicy: languagePolicySchema.default('auto-supplement'),
  supplementalPriority: z.array(languageSchema).max(10).default(['uk', 'en', 'de', 'fr']).refine(v => new Set(v).size === v.length),
  maxSupplementalLanguages: z.number().int().min(0).max(2).default(2),
  maxNetworkRequests: z.number().int().min(1).max(2000).default(600),
  report: reportSchema.default({}),
});
export type ResearchInput = z.infer<typeof researchSchema>;

export async function researchOperation(input: ResearchInput, services: Services): Promise<Output> {
  const researchId = randomUUID();
  const original = input.analysis;
  const plan = original.mode === 'topic' ? await services.store.read(['plans', `${original.topicPlanId}.json`], topicPlanSchema) : undefined;
  if (plan && canonical(plan.languages) !== canonical(original.languages)) throw new AppError('PLAN_MISMATCH', 'Запитані мови research мають відповідати початковому topic plan.');
  if (plan && (original.period && canonical(original.period) !== canonical(plan.period) || canonical(original.filters) !== canonical(plan.filters))) throw new AppError('PLAN_MISMATCH', 'Період і фільтри research мають відповідати topic plan; користувацькі дати не змінюються мовчки.');
  const period = getPeriod(plan?.period ?? original.period, services.clock);
  const topics = plan ? [{ topicId: plan.basketId, label: plan.label, concepts: plan.members.map(m => ({ qid: m.qid })) }] : original.topics!;
  const filters = plan?.filters ?? original.filters, queryLanguage = plan?.queryLanguage ?? original.queryLanguage;
  const transport = original.source === 'fixtures' ? services.fixtureTransport ?? new FixtureTransport() : services.transport ?? new HttpClient({ clock: services.clock, log: services.log });
  let sent = 0; let blocked: AppError | undefined;
  const bounded: Transport = { get: async request => {
    if (blocked) throw blocked;
    if (sent >= input.maxNetworkRequests) { blocked = new AppError('NETWORK_BUDGET_EXHAUSTED', 'Вичерпано мережевий бюджет research; отримані дані збережено.', { limit: input.maxNetworkRequests }); throw blocked; }
    sent++;
    try { return await transport.get(request); } catch (error) {
      const problem = asError(error);
      if (['RATE_LIMITED', 'HTTP_TEMPORARY_ERROR', 'USER_AGENT_INVALID', 'USER_AGENT_CONTACT_MISSING'].includes(problem.code)) blocked = problem;
      throw error;
    }
  } };
  const scoped = { ...services, ...(original.source === 'fixtures' ? { fixtureTransport: bounded } : { transport: bounded }) };
  const parent = input.parentRunId ? await readRun(input.parentRunId, services) : undefined;
  const preferred = parent && parent.manifest.source === (original.source === 'fixtures' ? 'fixtures' : 'wikimedia') ? parent.manifest.snapshots : undefined;
  const data = gateway(scoped, original, undefined, undefined, preferred), resolver = new Resolver(data), loader = new SeriesLoader(data);
  const completion: Completion = { version: '1.0.0', researchId, languagePolicy: input.languagePolicy, requestedLanguages: original.languages,
    analyzedRequestedLanguages: [], unavailableLanguages: [], supplementalLanguages: [], selectionReasons: [], comparisonLanguages: [], mapping: [], requestCompletion: 'unavailable', ...(plan ? { originalPlanId: plan.planId } : {}) };
  let run: Output | undefined;
  const checkpoint = async (stage: string, error?: AppError) => services.store.write(['research', researchId, `${stage}.json`], {
    schemaVersion: '1.0.0', researchId, input, period, createdAt: services.clock.now().toISOString(), completion,
    runId: run?.identifiers.runId ?? null, snapshots: data.snapshots, dataAccess: data.stats, networkRequests: sent,
    ...(error ? { blocker: { code: error.code, message: error.message, details: error.details } } : {}),
  });
  try {
    const qids = [...new Set(topics.flatMap(t => t.concepts.map(c => c.qid)))];
    const requiredQids = plan ? plan.members.filter(m => m.role === 'core').map(m => m.qid) : qids;
    const candidates = new Map<string, Candidate>();
    const reviewed = new Map<string, Candidate>();
    for (const id of original.sourceResolutionIds ?? []) {
      const r = await services.store.read(['resolutions', `${id}.json`], resolutionSchema);
      if ((r.source === 'fixtures') !== (original.source === 'fixtures')) throw new AppError('SOURCE_MISMATCH', 'Походження review та дослідження відрізняється.');
      for (const c of r.candidates) reviewed.set(c.qid, c);
    }
    for (const concept of original.topics?.flatMap(t => t.concepts) ?? []) if (concept.resolutionId) {
      const r = await services.store.read(['resolutions', `${concept.resolutionId}.json`], resolutionSchema);
      const c = r.candidates.find(c => c.qid === concept.qid); if (c) reviewed.set(concept.qid, c);
    }
    for (const qid of qids) { const c = await resolver.candidate(qid, queryLanguage, original.languages); candidates.set(qid, reviewed.has(qid) ? useReviewedSources(c, reviewed.get(qid)!) : c); }
    const recordMappings = (values: Candidate[]) => {
      for (const c of values) for (const a of c.articles) if (!completion.mapping.some(m => m.qid === c.qid && m.language === a.language)) completion.mapping.push({ qid: c.qid, language: a.language, title: a.title, status: a.mappingStatus ?? (a.status === 'found' ? 'confirmed' : a.status), evidence: a.evidence });
    };
    recordMappings([...candidates.values()]);
    const pages = (language: string) => [...new Map([...candidates.values()].flatMap(c => c.articles.filter(a => a.language === language && a.status === 'found')).map(a => [a.pageId, a])).values()];
    const history = async (language: string): Promise<boolean> => {
      const project = await loader.load({ kind: 'project', language, filters, period });
      const articles: Series[] = [];
      for (const page of pages(language)) articles.push(await loader.load({ kind: 'article', language, title: page.title!, filters, period }));
      if ([project, ...articles].some(s => s.points.some(p => p.views === null))) for (const s of [project, ...articles]) await loader.monthly(s, s.kind === 'project' ? { kind: 'project', language, filters, period } : { kind: 'article', language, title: s.title!, filters, period });
      // Придатність історії без перевірки знака або величини зміни.
      const recovered = recoverComparisons([{ id: language, topic: aggregatePages(articles.map(a => a.points), period), project: project.points, projectSeries: project, articles }], period).get(language)!;
      return recovered.yearOverYear.method !== 'unavailable';
    };
    let direct = true;
    for (const language of original.languages) {
      if (pages(language).length) {
        completion.analyzedRequestedLanguages.push(language);
        if (await history(language)) completion.comparisonLanguages!.push(language);
        else { direct = false; completion.unavailableLanguages.push({ language, code: 'HISTORY_UNUSABLE', reason: 'Стаття підтверджена, але річна історія непридатна; доступні інші вікна й показники збережено окремо.' }); }
      } else {
        const mappings = completion.mapping.filter(m => m.language === language);
        const code = mappings.some(m => m.status === 'incomplete') ? 'MAPPING_INCOMPLETE' : mappings.some(m => m.status === 'ambiguous') ? 'MAPPING_AMBIGUOUS' : 'EQUIVALENT_NOT_FOUND';
        completion.unavailableLanguages.push({ language, code, reason: code === 'EQUIVALENT_NOT_FOUND' ? 'Після обмеженого пошуку відповідник не підтверджено; інтерес не дорівнює нулю.' : 'Відповідник не підтверджено; пошук неповний або неоднозначний.' }); direct = false;
      }
      const missingQids = requiredQids.filter(qid => !candidates.get(qid)?.articles.some(a => a.language === language && a.status === 'found'));
      if (missingQids.length) {
        direct = false;
        if (pages(language).length) completion.unavailableLanguages.push({ language, code: 'PARTIAL_CONCEPT_COVERAGE', reason: 'Доступна лише частина вибраних концепцій; дивіться матрицю покриття.', missingQids });
      }
    }
    if (!direct && input.languagePolicy === 'auto-supplement') for (const language of input.supplementalPriority.filter(l => !original.languages.includes(l))) {
      blocked ??= data.blocker;
      if (completion.supplementalLanguages.length >= input.maxSupplementalLanguages || blocked) break;
      const found: Candidate[] = [];
      for (const qid of qids) {
        const candidate = await resolver.candidate(qid, queryLanguage, [language]); if (reviewed.has(qid)) useReviewedSources(candidate, reviewed.get(qid)!); found.push(candidate);
        candidates.get(qid)!.articles.push(...candidate.articles);
      }
      recordMappings(found);
      const sameConcepts = requiredQids.every(qid => candidates.get(qid)?.articles.some(a => a.language === language && a.status === 'found'));
      const suitable = sameConcepts && await history(language);
      completion.selectionReasons.push({ language, selected: suitable, code: suitable ? 'SAME_CONCEPT_USABLE_HISTORY' : sameConcepts ? 'HISTORY_UNUSABLE' : 'EQUIVALENT_UNCONFIRMED', reason: suitable ? 'Підтверджено той самий склад концепцій і придатність історії; вибір за заданим порядком, без оцінювання зростання.' : 'Мова пропущена: немає підтвердженого складу або придатної історії.' });
      if (suitable) { completion.supplementalLanguages.push(language); completion.comparisonLanguages!.push(language); }
    }
    completion.requestCompletion = direct ? 'complete' : completion.analyzedRequestedLanguages.length ? 'partial' : 'unavailable';
    blocked ??= data.blocker;
    completionSchema.parse(completion);
    await checkpoint('selection');
    const languages = [...completion.analyzedRequestedLanguages, ...completion.supplementalLanguages];
    if (!languages.length) throw blocked ?? new AppError('NO_USABLE_EQUIVALENTS', 'Не знайдено придатних мовних відповідників. Перевірки й знімки збережено.');
    let derivedPlan = plan;
    if (plan && canonical(languages) !== canonical(plan.languages)) {
      derivedPlan = { ...plan, planId: randomUUID(), parentPlanId: plan.planId, languages, frozenAt: services.clock.now().toISOString(), compositionVersion: sha256(canonical({ members: plan.members, languages, parent: plan.compositionVersion })), assumptions: [...plan.assumptions, `research language policy: ${input.languagePolicy}; requested: ${original.languages.join(',')}`] };
      await services.store.write(['plans', `${derivedPlan.planId}.json`], derivedPlan);
    }
    const request: AnalyzeInput = analyzeSchema.parse({ ...original, languages, period, filters, queryLanguage, recoverGaps: true, ...(derivedPlan ? { topicPlanId: derivedPlan.planId } : {}) });
    run = await analyzeOperation(request, scoped, { completion, sharedGateway: data, topicPlan: derivedPlan, originalRequest: input, parentRunId: input.parentRunId, mode: input.parentRunId ? 'revise' : 'analyze', previousTopics: parent?.manifest.topics });
    const runId = run.identifiers.runId!;
    await checkpoint('analyzed', blocked);
    const analysis = await services.store.read(['runs', runId, 'analysis.json'], analysisSchema);
    const report = await reportOperation(runId, input.report, scoped);
    const usable = analysis.entries.some(e => e.metrics.totalViews.value !== null || e.recovery?.yearOverYear.method !== 'unavailable' && e.recovery !== undefined);
    const summary = { ...run.summary, executionStatus: blocked ? 'partial' : 'completed', requestCompletion: completion.requestCompletion,
      metricQuality: analysis.entries.map(e => ({ id: e.id, diagnostic: e.diagnostic.status, annualMethod: e.recovery?.yearOverYear.method, coveragePercent: e.recovery?.yearOverYear.coveragePercent })),
      requestedResult: { requestedLanguages: completion.requestedLanguages, analyzedRequestedLanguages: completion.analyzedRequestedLanguages, unavailableLanguages: completion.unavailableLanguages },
      supplementalComparison: { languages: completion.supplementalLanguages, selectionReasons: completion.selectionReasons },
      findings: analysis.findings.filter(f => ['annual_change', 'recent_change', 'relative_change'].includes(f.type)).map(f => ({ id: f.id, topicId: f.topicId, language: f.language, sourceIds: f.sourceIds, type: f.type, value: f.value, unit: f.unit, method: f.method, warnings: f.warnings })),
      report: report.summary, networkRequests: sent, ...(blocked ? { blocker: { code: blocked.code, message: blocked.message, details: blocked.details } } : {}) };
    await checkpoint('completed', blocked);
    return { ...run, status: !direct || blocked || !usable || run.status === 'partial' || report.status === 'partial' ? 'partial' : 'ok', identifiers: { ...run.identifiers, researchId, ...report.identifiers }, summary,
      warnings: [...run.warnings, ...report.warnings, ...(!direct ? [warning('REQUEST_PARTIALLY_FULFILLED', 'Додаткові мови не замінюють недоступні запитані мови або повні показники.')] : [])], artifacts: [...run.artifacts, ...report.artifacts], nextAction: { operation: null, message: blocked ? 'Доступний результат збережено. Продовжити можна після усунення вказаного блокера; автоматичного відкладеного запуску немає.' : 'Доступні результати й PDF створено. Пов’язані зміни виконуйте через runId.' } };
  } catch (error) {
    const problem = asError(error), path = await checkpoint('blocked', problem);
    return { status: run ? 'partial' : 'error', identifiers: { researchId, ...run?.identifiers }, summary: { ...run?.summary, executionStatus: 'blocked', requestCompletion: completion.requestCompletion, completion, blocker: { code: problem.code, message: problem.message, details: problem.details }, networkRequests: sent },
      warnings: [warning(problem.code, problem.message, problem.details)], artifacts: [...run?.artifacts ?? [], { kind: 'research-checkpoint', path }], ...(!run ? { error: { code: problem.code, message: problem.message, details: problem.details } } : {}),
      nextAction: { operation: run ? 'report' : 'research', message: run ? 'Аналіз збережено; після усунення блокера повторіть report для цього runId.' : 'Після усунення блокера повторіть той самий JSON; кеш і знімки збережені. Відкладеного запуску немає.' } };
  }
}
