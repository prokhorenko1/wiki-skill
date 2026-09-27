import { z } from 'zod';
import { aggregatePages, calculate, calculationSchema } from './calculations.js';
import { direction, median } from './diagnostics.js';
import { pairedMonthSensitivity, scenarioResult, scenarioSchema } from './sensitivity.js';
import { knownDataIssues } from './data-issues.js';
import type { Dataset, Manifest } from './models.js';
import type { DailyPoint } from './series.js';
import type { TopicPlan } from './topic-plan.js';

export const basketRowSchema = z.object({ id: z.string(), scope: z.enum(['article', 'basket', 'subtopic']), role: z.enum(['root', 'core', 'extended', 'subtopic', 'concept']), label: z.string(), language: z.string(), qids: z.array(z.string()), metrics: calculationSchema });
const contributionSchema = z.object({ qid: z.string(), label: z.string(), subtopic: z.string().nullable(), previous: z.number().nullable(), current: z.number().nullable(), delta: z.number().nullable(), percentagePoints: z.number().nullable(), annual: z.number().nullable(), lowBase: z.boolean() });
export const topicStudySchema = z.object({
  methodologyVersion: z.literal('3.0.0'), basketId: z.string(), compositionVersion: z.string(), question: z.string(), productContext: z.string(), boundaries: z.string(),
  rows: z.array(basketRowSchema),
  coverage: z.array(z.object({ qid: z.string(), label: z.string(), role: z.string(), subtopic: z.string().nullable(), language: z.string(), articleStatus: z.string(), title: z.string().nullable(), url: z.string().nullable(), dataUsable: z.boolean(), dataReason: z.string().nullable(), includedInCore: z.boolean(), duplicateOf: z.string().nullable(), createdAt: z.string().nullable() })),
  languages: z.array(z.object({ language: z.string(), plannedCore: z.number(), includedCore: z.number(), coveragePercent: z.number(), coreQids: z.array(z.string()), extendedQids: z.array(z.string()),
    counts: z.object({ growing: z.number(), declining: z.number(), unchanged: z.number(), unusable: z.number() }), medianChange: z.number().nullable(), largestShare: z.number().nullable(), topThreeShare: z.number().nullable(),
    contributions: z.array(contributionSchema), positiveContributions: z.array(z.string()), negativeContributions: z.array(z.string()), contributionSum: z.number().nullable(),
    sensitivity: z.object({ leaveOneOut: z.array(scenarioSchema), pairedMonths: z.array(scenarioSchema), maximumMonthImpactPoints: z.number().nullable(), maximumLeaveOneOutImpactPoints: z.number().nullable(), directionDependsOnConcept: z.boolean(), directionDependsOnMonth: z.boolean() }),
    comparisons: z.object({ root: z.number().nullable(), core: z.number().nullable(), extended: z.number().nullable(), normalized: z.number().nullable(), recent: z.number().nullable() }),
    quality: z.object({ completeness: z.enum(['complete', 'incomplete']), relevance: z.literal('agent_defined_not_representative'), crossLanguage: z.enum(['common_fixed_set', 'incomplete_plan']), stability: z.enum(['stable', 'mixed', 'fragile', 'insufficient']), flags: z.array(z.string()) }),
    conclusion: z.string(), hypotheses: z.array(z.object({ subtopic: z.string(), findingId: z.string(), suggestion: z.string() })) })),
  assumptions: z.array(z.string()), limitations: z.array(z.string()), issues: z.array(z.object({ id: z.string(), source: z.string(), reviewedAt: z.string(), period: z.object({ start: z.string(), end: z.string() }), status: z.string(), backfillCompleted: z.string().nullable(), note: z.string() })),
});
export type TopicStudy = z.infer<typeof topicStudySchema>;
export type BasketRow = z.infer<typeof basketRowSchema>;
export const TOPIC_POLICY = Object.freeze({ directionDeadbandPercent: 5, lowBaseViews: 1000, materialDifferencePoints: 10, concentratedMonthFraction: 0.25 });
const normalizedTitle = (s: string) => s.normalize('NFC').replaceAll('_', ' ').replace(/\s+/g, ' ').trim();

export function buildTopicStudy(plan: TopicPlan, topics: Manifest['topics'], dataset: Dataset): { study: TopicStudy; rows: (BasketRow & { points: DailyPoint[] })[] } {
  const candidates = topics.flatMap(t => t.candidates);
  const getCandidate = (qid: string) => candidates.find(c => c.qid === qid || c.requestedQid === qid);
  const seriesFor = (qid: string, language: string) => {
    const article = getCandidate(qid)?.articles.find(a => a.language === language);
    return dataset.series.find(s => s.kind === 'article' && s.language === language && normalizedTitle(s.title ?? '') === normalizedTitle(article?.title ?? ''));
  };
  const coverage: TopicStudy['coverage'] = plan.members.flatMap(member => plan.languages.map(language => {
    const article = getCandidate(member.qid)?.articles.find(a => a.language === language), series = seriesFor(member.qid, language);
    const newArticle = article?.createdAt && article.createdAt.slice(0, 10) > dataset.period.start;
    const complete = Boolean(series && calculate(series.points, series.points, dataset.period).totalViews.value !== null);
    const recoverable = Boolean(series?.apiMonthly && (series.apiMonthly.length > 0 && series.apiMonthly.every(m => m.status === 'usable') || series.points.filter(p => p.views !== null).length / series.points.length >= 0.95));
    return { qid: member.qid, label: getCandidate(member.qid)?.label ?? member.qid, role: member.role, subtopic: member.subtopic, language,
      articleStatus: article?.status ?? 'unavailable', title: article?.title ?? null, url: article?.source?.articleUrl ?? null,
      dataUsable: article?.status === 'found' && (complete || recoverable) && !newArticle, dataReason: article?.status !== 'found' ? 'ARTICLE_UNAVAILABLE' : newArticle ? 'NEW_ARTICLE' : complete ? null : recoverable ? 'RECOVERY_REQUIRED_NOT_DAILY_COMPLETE' : 'UNKNOWN_OR_INCOMPLETE_HISTORY',
      includedInCore: false, duplicateOf: null as string | null, createdAt: article?.createdAt ?? null };
  }));
  // First semantic owner in frozen order. A duplicate in any edition cannot count twice in the common set.
  const owners: typeof plan.members = [];
  for (const member of plan.members.filter(m => m.role !== 'root')) {
    const duplicate = owners.find(owner => plan.languages.some(language => {
      const a = getCandidate(member.qid)?.articles.find(p => p.language === language && p.status === 'found');
      const b = getCandidate(owner.qid)?.articles.find(p => p.language === language && p.status === 'found');
      return a && b && (a.pageId === b.pageId || normalizedTitle(a.title!) === normalizedTitle(b.title!));
    }) || getCandidate(owner.qid)?.qid === getCandidate(member.qid)?.qid);
    if (duplicate) for (const cell of coverage.filter(c => c.qid === member.qid)) cell.duplicateOf = duplicate.qid;
    else owners.push(member);
  }
  const usable = (qid: string, language: string) => coverage.some(c => c.qid === qid && c.language === language && c.dataUsable && !c.duplicateOf);
  const planned = plan.members.filter(m => m.role === 'core');
  const core = planned.filter(m => plan.languages.every(l => usable(m.qid, l))).map(m => m.qid);
  for (const cell of coverage) cell.includedInCore = core.includes(cell.qid);
  const rows: (BasketRow & { points: DailyPoint[] })[] = [], summaries: TopicStudy['languages'] = [];
  for (const language of plan.languages) {
    const project = dataset.series.find(s => s.kind === 'project' && s.language === language)?.points ?? [];
    const projectMetrics = calculate(project, project, dataset.period);
    const pointsFor = (qids: string[]) => aggregatePages(qids.map(qid => seriesFor(qid, language)?.points ?? []), dataset.period);
    const add = (role: BasketRow['role'], id: string, label: string, qids: string[]) => {
      const points = pointsFor(qids), metrics = calculate(points, project, dataset.period, !qids.length);
      const row = { id: `${id}:${language}`, scope: role === 'root' || role === 'concept' ? 'article' as const : role === 'subtopic' ? 'subtopic' as const : 'basket' as const, role, label, language, qids, metrics, points };
      rows.push(row); return row;
    };
    const coreRow = add('core', `${plan.basketId}-core`, `${plan.label}: основний набір`, core);
    const root = plan.members.find(m => m.role === 'root');
    const rootRow = root ? add('root', `${plan.basketId}-root`, `${getCandidate(root.qid)?.label ?? plan.label}: коренева стаття`, [root.qid]) : null;
    const extended = plan.members.filter(m => m.role !== 'root' && usable(m.qid, language)).map(m => m.qid);
    const extendedRow = plan.members.some(m => m.role === 'extended') || extended.join() !== core.join() ? add('extended', `${plan.basketId}-extended`, `${plan.label}: розширений набір (лише ${language})`, extended) : null;
    for (const subtopic of plan.subtopics) add('subtopic', `${plan.basketId}-${subtopic.id}`, subtopic.label, core.filter(qid => plan.members.some(m => m.qid === qid && m.subtopic === subtopic.id)));
    const components = plan.members.filter(m => m.role !== 'root').map(member => ({ member, row: add('concept', `${plan.basketId}-${member.qid.toLowerCase()}`, getCandidate(member.qid)?.label ?? member.qid, [member.qid]) }));
    const counts = { growing: 0, declining: 0, unchanged: 0, unusable: 0 }, changes: number[] = [];
    for (const { member, row } of components.filter(c => c.member.role === 'core')) {
      const change = row.metrics.yearOverYear.changePercent.value;
      if (!core.includes(member.qid) || change === null) counts.unusable++;
      else { changes.push(change); counts[direction(change) > 0 ? 'growing' : direction(change) < 0 ? 'declining' : 'unchanged']++; }
    }
    const previousBasket = coreRow.metrics.yearOverYear.previous.value;
    const contributions = components.filter(c => core.includes(c.member.qid)).map(({ member, row }) => {
      const previous = row.metrics.yearOverYear.previous.value, current = row.metrics.yearOverYear.current.value, delta = current !== null && previous !== null ? current - previous : null;
      return { qid: member.qid, label: row.label, subtopic: member.subtopic, previous, current, delta, percentagePoints: delta !== null && previousBasket !== null && previousBasket > 0 ? delta / previousBasket * 100 : null, annual: row.metrics.yearOverYear.changePercent.value, lowBase: previous !== null && previous < TOPIC_POLICY.lowBaseViews };
    });
    const leaveOneOut = core.map(qid => {
      const qids = core.filter(other => qid !== other), metrics = calculate(pointsFor(qids), project, dataset.period, !qids.length);
      return scenarioResult(`leave-out-${qid}`, [qid], metrics.yearOverYear.changePercent.value, metrics.yearOverYear.relativeChangePercent.value, coreRow.metrics);
    });
    const pairedMonths = pairedMonthSensitivity(coreRow.metrics, projectMetrics, dataset.period);
    const maxImpact = (scenarios: typeof leaveOneOut) => { const values = scenarios.flatMap(s => s.differencePoints === null ? [] : [Math.abs(s.differencePoints)]); return values.length ? Math.max(...values) : null; };
    const directionDependsOnConcept = leaveOneOut.some(s => s.directionChanged), directionDependsOnMonth = pairedMonths.some(s => s.directionChanged);
    const comparisons = { root: rootRow?.metrics.yearOverYear.changePercent.value ?? null, core: coreRow.metrics.yearOverYear.changePercent.value, extended: extendedRow?.metrics.yearOverYear.changePercent.value ?? null,
      normalized: coreRow.metrics.yearOverYear.relativeChangePercent.value, recent: coreRow.metrics.lastThreeMonths.changePercent.value };
    const flags: string[] = [];
    if (core.length < planned.length) flags.push('INCOMPLETE_PLAN_COVERAGE');
    if (!coreRow.metrics.quality.complete || comparisons.core === null || comparisons.normalized === null) flags.push('INCOMPLETE_DATA');
    if (directionDependsOnConcept) flags.push('CONCEPT_DIRECTION_DEPENDENCE');
    if (directionDependsOnMonth) flags.push('MONTH_DIRECTION_DEPENDENCE');
    if ((maxImpact(pairedMonths) ?? 0) >= 10) flags.push('MONTH_MATERIAL_IMPACT');
    if ((maxImpact(leaveOneOut) ?? 0) >= 10) flags.push('CONCEPT_MATERIAL_IMPACT');
    if (contributions.some(c => c.lowBase)) flags.push('LOW_COMPONENT_BASE');
    if (counts.growing && counts.declining) flags.push('MIXED_COMPONENTS');
    for (const [key, other] of Object.entries(comparisons)) if (key !== 'core' && other !== null && comparisons.core !== null && direction(other) !== direction(comparisons.core)) flags.push(`${key.toUpperCase()}_CORE_DISAGREEMENT`);
    const monthShare = coreRow.metrics.totalViews.value ? Math.max(...coreRow.metrics.monthly.map(m => m.views.value ?? 0)) / coreRow.metrics.totalViews.value : null;
    if (monthShare !== null && monthShare >= 0.25) flags.push('MONTH_CONCENTRATION_REVIEW');
    if (knownDataIssues(dataset.period).length) flags.push('KNOWN_DATA_ISSUE_OVERLAP');
    const insufficient = flags.includes('INCOMPLETE_PLAN_COVERAGE') || flags.includes('INCOMPLETE_DATA');
    const fragile = directionDependsOnConcept || directionDependsOnMonth || (maxImpact(pairedMonths) ?? 0) >= 10 || (maxImpact(leaveOneOut) ?? 0) >= 10;
    const mixed = flags.some(f => f.endsWith('DISAGREEMENT') || f === 'MIXED_COMPONENTS' || f === 'LOW_COMPONENT_BASE' || f === 'KNOWN_DATA_ISSUE_OVERLAP');
    const stability = insufficient ? 'insufficient' : fragile ? 'fragile' : mixed ? 'mixed' : 'stable';
    let conclusion = insufficient ? 'Даних недостатньо для узагальнення на заплановану тему; показано лише придатний незмінний піднабір.'
      : directionDependsOnConcept ? 'Напрям сумарної зміни залежить від однієї статті.'
      : counts.growing && counts.declining ? 'Динаміка вибраних підтем неоднорідна; сума не описує кожен компонент.'
      : comparisons.core !== null && direction(comparisons.core) < 0 && counts.declining > counts.growing ? 'У вибраному наборі спостерігається узгоджене зниження переглядів.'
      : comparisons.core !== null && direction(comparisons.core) > 0 && counts.growing > counts.declining ? 'У вибраному наборі спостерігається зростання переглядів.' : 'У вибраному наборі немає суттєвої сумарної зміни за евристичним порогом ±5%.';
    if (comparisons.root !== null && comparisons.core !== null && direction(comparisons.root) !== direction(comparisons.core)) conclusion += ' Динаміка кореневої статті відрізняється від набору.';
    if (counts.growing && counts.declining && !conclusion.includes('неоднорідна')) conclusion += ' Вибрані підтематики мають різноспрямовану динаміку.';
    if (directionDependsOnMonth) conclusion += ' Напрям змінюється у сценарії без узгодженої пари календарних місяців.';
    else if (fragile) conclusion += ' Величина зміни чутлива до складу або календарного місяця; див. числові сценарії.';
    if (flags.includes('NORMALIZED_CORE_DISAGREEMENT')) conclusion += ' Абсолютна й нормалізована динаміка мають різний напрям.';
    if (flags.includes('RECENT_CORE_DISAGREEMENT')) conclusion += ' Річне та нещодавнє вікна суперечать одне одному.';
    if (flags.includes('EXTENDED_CORE_DISAGREEMENT')) conclusion += ' Основний і розширений набори мають різний напрям.';
    if (flags.includes('KNOWN_DATA_ISSUE_OVERLAP')) conclusion += ' Період перетинається з відомим обмеженням Wikimedia; вплив на набір не доведено.';
    const total = coreRow.metrics.totalViews.value, volumes = components.filter(c => core.includes(c.member.qid)).map(c => c.row.metrics.totalViews.value ?? 0).sort((a, b) => b - a);
    summaries.push({ language, plannedCore: planned.length, includedCore: core.length, coveragePercent: core.length / planned.length * 100, coreQids: core, extendedQids: extended, counts, medianChange: changes.length ? median(changes) : null,
      largestShare: total ? (volumes[0] ?? 0) / total : null, topThreeShare: total ? volumes.slice(0, 3).reduce((a, b) => a + b, 0) / total : null,
      contributions, positiveContributions: contributions.filter(c => (c.percentagePoints ?? 0) > 0).sort((a, b) => b.percentagePoints! - a.percentagePoints!).slice(0, 3).map(c => c.qid), negativeContributions: contributions.filter(c => (c.percentagePoints ?? 0) < 0).sort((a, b) => a.percentagePoints! - b.percentagePoints!).slice(0, 3).map(c => c.qid),
      contributionSum: contributions.length && contributions.every(c => c.percentagePoints !== null) ? contributions.reduce((n, c) => n + c.percentagePoints!, 0) : null,
      sensitivity: { leaveOneOut, pairedMonths, maximumMonthImpactPoints: maxImpact(pairedMonths), maximumLeaveOneOutImpactPoints: maxImpact(leaveOneOut), directionDependsOnConcept, directionDependsOnMonth }, comparisons,
      quality: { completeness: insufficient ? 'incomplete' : 'complete', relevance: 'agent_defined_not_representative', crossLanguage: core.length < planned.length ? 'incomplete_plan' : 'common_fixed_set', stability, flags }, conclusion,
      hypotheses: rows.filter(r => r.language === language && r.role === 'subtopic').map(row => ({ subtopic: row.label, findingId: `v3:${row.id}:annual_change`, suggestion: (row.metrics.yearOverYear.changePercent.value ?? 0) > 5 ? `Перевірити попит на короткий навчальний модуль «${row.label}» через прототип завдання та добровільну заявку; окремо тестувати оплату.` : (row.metrics.yearOverYear.changePercent.value ?? 0) < -5 ? `Для «${row.label}» перевірити актуальну навчальну проблему та альтернативні джерела навчання перед інвестицією у повний модуль.` : `Для «${row.label}» порівняти два формати пробного завдання та завершення навчання; цих переглядів недостатньо для оцінки оплати.` })) });
  }
  return { rows, study: topicStudySchema.parse({ methodologyVersion: '3.0.0', basketId: plan.basketId, compositionVersion: plan.compositionVersion, question: plan.question, productContext: plan.productContext, boundaries: plan.boundaries, rows: rows.map(({ points: _points, ...row }) => row), coverage, languages: summaries, assumptions: plan.assumptions, limitations: [...plan.limitations, 'Покриття стосується вибраного плану, не всієї тематики.', 'Медіана та частка зростаючих концепцій описують залежну вибірку, не є статистичним доказом.', 'Перегляди не є пошуковими запитами, унікальною аудиторією, розміром ринку або доведеним попитом.'], issues: knownDataIssues(dataset.period) }) };
}
