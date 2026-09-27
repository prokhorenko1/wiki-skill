import { z } from 'zod';
import { calculate, calculationSchema, type Metric } from './calculations.js';
import { diagnose, diagnosticSchema, DIAGNOSTIC_POLICY, DIAGNOSTIC_VERSION } from './diagnostics.js';
import { periodSchema, idSchema, criterionSchema } from './schemas.js';
import { snapshotRefSchema } from './storage.js';
import type { Dataset, Manifest } from './models.js';
import { buildTopicStudy, topicStudySchema } from './topic-analysis.js';
import { knownDataIssues } from './data-issues.js';
import { recoverySchema, recoverComparisons, type Recovery } from './recovery.js';
import { completionSchema } from './completion-types.js';
import { sourceLinks, sourceLinksSchema } from './source-links.js';

export const findingSchema = z.object({
  sourceIds: z.array(z.string()).optional(),
  method: z.string().optional(),
  scope: z.enum(['article', 'basket', 'subtopic']).optional(), basketId: z.string().optional(), compositionVersion: z.string().optional(),
  statement: z.string().optional(), coveragePercent: z.number().optional(), sensitivityScenarioIds: z.array(z.string()).optional(),
  id: z.string(), kind: z.literal('observation'), type: z.enum(['volume', 'daily_average', 'relative_level', 'annual_change', 'recent_change', 'relative_change', 'sensitivity_change']),
  metricPath: z.string(), value: z.number().finite().nullable(), unit: z.enum(['views', 'views_per_day', 'views_per_million', 'percent', 'percentage_points']),
  period: periodSchema, baselinePeriod: periodSchema.nullable(), topicId: z.string(), language: z.string(), concepts: z.array(z.string()),
  evidenceId: z.string(), warnings: z.array(z.string()), unavailableReason: z.string().nullable(),
});
export type Finding = z.infer<typeof findingSchema>;
export const analysisSchema = z.object({
  articleSources: sourceLinksSchema.optional(),
  recoveryEnabled: z.boolean().optional(), completion: completionSchema.optional(),
  schemaVersion: z.enum(['2.0.0', '3.0.0']), diagnosticVersion: z.enum(['2.0.0', '3.0.0']), runId: idSchema,
  mode: z.enum(['article', 'topic']).optional(), topicStudy: topicStudySchema.optional(),
  knownIssues: topicStudySchema.shape.issues.optional(),
  source: z.enum(['wikimedia', 'fixtures']), createdAt: z.iso.datetime(), period: periodSchema, criterion: criterionSchema,
  policy: z.object(Object.fromEntries(Object.entries(DIAGNOSTIC_POLICY).map(([k, v]) => [k, z.literal(v)])) as { [K in keyof typeof DIAGNOSTIC_POLICY]: z.ZodLiteral<(typeof DIAGNOSTIC_POLICY)[K]> }),
  topics: z.array(z.object({ topicId: z.string(), label: z.string(), selected: z.array(z.object({ qid: z.string(), label: z.string().nullable() })), included: z.array(z.string()), excluded: z.array(z.string()), matrix: z.array(z.object({ qid: z.string(), languages: z.record(z.string(), z.string()) })) })),
  entries: z.array(z.object({ id: z.string(), topicId: z.string(), language: z.string(), sourceIds: z.array(z.string()).optional(), metrics: calculationSchema, diagnostic: diagnosticSchema, recovery: recoverySchema.optional() })),
  findings: z.array(findingSchema),
  evidence: z.array(z.object({ id: z.string(), topicId: z.string(), language: z.string(), titles: z.array(z.string()), sourceIds: z.array(z.string()), scope: z.enum(['article', 'basket', 'subtopic']).optional(), basketId: z.string().optional(), compositionVersion: z.string().optional(), coveragePercent: z.number().optional(), qualityFlags: z.array(z.string()).optional(), sensitivityScenarioIds: z.array(z.string()).optional() })),
  sources: z.array(snapshotRefSchema), warnings: z.array(z.string()), limitations: z.array(z.string()), hypotheses: z.array(z.string()),
});
export type Analysis = z.infer<typeof analysisSchema>;
export type Entry = Analysis['entries'][number];

export function buildAnalysis(manifest: Manifest, dataset: Dataset): Analysis {
  const entries: Analysis['entries'] = [], findings: Finding[] = [], evidence: Analysis['evidence'] = [];
  const topicStudy = manifest.topicPlan ? buildTopicStudy(manifest.topicPlan, manifest.topics, dataset).study : undefined;
  const recovered = new Map<string, Recovery>();
  if (manifest.request.recoverGaps) for (const topic of manifest.topics) {
    const rows = dataset.topics.filter(r => r.topicId === topic.topic.topicId).map(row => ({ id: `${row.topicId}:${row.language}`, topic: row.points,
      project: dataset.series.find(s => s.kind === 'project' && s.language === row.language)?.points ?? [], projectSeries: dataset.series.find(s => s.kind === 'project' && s.language === row.language),
      articles: dataset.series.filter(s => s.kind === 'article' && s.language === row.language && topic.coverage.pages[row.language]?.some(p => p.title === s.title)) }));
    const groups = new Map<string, typeof rows>();
    for (const row of rows.filter(r => r.articles.length)) {
      const isolated = manifest.completion?.comparisonLanguages && !manifest.completion.comparisonLanguages.includes(row.id.slice(row.id.lastIndexOf(':') + 1));
      const composition = topicStudy?.rows.find(r => r.id === row.id)?.qids.slice().sort().join(',') ?? topic.coverage.includedQids.slice().sort().join(',');
      const key = isolated ? row.id : composition;
      groups.set(key, [...groups.get(key) ?? [], row]);
    }
    for (const group of groups.values()) for (const [id, recovery] of recoverComparisons(group, dataset.period)) {
      if (manifest.completion?.comparisonLanguages && !manifest.completion.comparisonLanguages.includes(id.slice(id.lastIndexOf(':') + 1))) {
        recovery.yearOverYear.warnings.push('LANGUAGE_HISTORY_EXCLUDED_FROM_COMPARISON'); recovery.lastThreeMonths.warnings.push('LANGUAGE_HISTORY_EXCLUDED_FROM_COMPARISON');
      }
      recovered.set(id, recovery);
    }
  }
  for (const row of dataset.topics) {
    const topic = manifest.topics.find(t => t.topic.topicId === row.topicId)!;
    const project = dataset.series.find(s => s.kind === 'project' && s.language === row.language);
    const metrics = calculate(row.points, project?.points ?? [], dataset.period, !topic.coverage.includedQids.length);
    const diagnostic = diagnose(row.points, project?.points ?? [], dataset.period, metrics, { included: topic.coverage.includedQids, excluded: topic.coverage.excludedQids });
    const id = `${row.topicId}:${row.language}`;
    const recovery = recovered.get(id);
    const basketRow = topicStudy?.rows.find(r => r.id === id), languageStudy = topicStudy?.languages.find(l => l.language === row.language);
    const scope = basketRow?.scope ?? (topic.topic.concepts.length === 1 ? 'article' : 'basket');
    const scopeFields = { scope, ...(topicStudy ? { basketId: topicStudy.basketId, compositionVersion: topicStudy.compositionVersion, coveragePercent: languageStudy!.coveragePercent, sensitivityScenarioIds: [...languageStudy!.sensitivity.leaveOneOut, ...languageStudy!.sensitivity.pairedMonths].map(s => s.id) } : {}) };
    const sourceIds = (topic.coverage.pages[row.language] ?? []).flatMap(p => p.source ? [p.source.sourceId] : []);
    entries.push({ id, topicId: row.topicId, language: row.language, sourceIds, metrics, diagnostic, ...(recovery ? { recovery } : {}) });
    evidence.push({ id, ...scopeFields, qualityFlags: languageStudy?.quality.flags ?? diagnostic.reasons.map(r => r.code), topicId: row.topicId, language: row.language, titles: (topic.coverage.pages[row.language] ?? []).flatMap(p => p.title ? [p.title] : []),
      sourceIds });
    const add = (type: Finding['type'], metricPath: string, metric: Metric, unit: Finding['unit'], period = dataset.period, baselinePeriod: Finding['baselinePeriod'] = null) => {
      findings.push({ id: `${topicStudy ? 'v3' : 'v2'}:${id}:${type}`, ...scopeFields, statement: basketRow?.role === 'core' ? languageStudy!.conclusion : scope === 'article' ? 'Спостереження стосується лише вибраної статті, не всієї тематики або комерційного попиту.' : 'Спостереження обмежено явно вибраним набором.', kind: 'observation', type, metricPath, value: metric.value, unit, period, baselinePeriod,
        topicId: row.topicId, language: row.language, sourceIds, concepts: [...basketRow?.qids ?? topic.coverage.includedQids], evidenceId: id,
        warnings: [...new Set([...diagnostic.reasons.map(r => r.code), ...(languageStudy?.quality.flags ?? []), ...knownDataIssues(dataset.period).map(() => 'KNOWN_DATA_ISSUE_OVERLAP')])], unavailableReason: metric.reason?.code ?? null });
    };
    add('volume', 'totalViews', metrics.totalViews, 'views');
    add('daily_average', 'dailyAverage', metrics.dailyAverage, 'views_per_day');
    add('relative_level', 'perMillion', metrics.perMillion, 'views_per_million');
    add('annual_change', 'yearOverYear.changePercent', metrics.yearOverYear.changePercent, 'percent', metrics.yearOverYear.currentPeriod ?? dataset.period, metrics.yearOverYear.previousPeriod);
    add('recent_change', 'lastThreeMonths.changePercent', metrics.lastThreeMonths.changePercent, 'percent', metrics.lastThreeMonths.currentPeriod ?? dataset.period, metrics.lastThreeMonths.previousPeriod);
    add('relative_change', 'yearOverYear.relativeChangePercent', metrics.yearOverYear.relativeChangePercent, 'percent', metrics.yearOverYear.currentPeriod ?? dataset.period, metrics.yearOverYear.previousPeriod);
    add('sensitivity_change', 'diagnostic.sensitivity.annualDifferencePoints', { value: diagnostic.sensitivity.annualDifferencePoints, reason: diagnostic.sensitivity.annualDifferencePoints === null ? { code: 'MISSING_DATA', message: 'Сценарій недоступний.' } : null }, 'percentage_points', metrics.yearOverYear.currentPeriod ?? dataset.period, metrics.yearOverYear.previousPeriod);
    if (recovery) for (const finding of findings.filter(f => f.evidenceId === id)) {
      const periodKey = ({ volume: 'totalViews', daily_average: 'dailyAverage', relative_level: 'perMillion' } as const)[finding.type as 'volume' | 'daily_average' | 'relative_level'];
      if (periodKey && recovery.periodSummary) {
        const m = recovery.periodSummary[periodKey]; finding.value = m.value; finding.method = recovery.periodSummary.method; finding.unavailableReason = m.reason?.code ?? null; finding.metricPath = `recovery.periodSummary.${periodKey}`;
      }
      const c = finding.type === 'recent_change' ? recovery.lastThreeMonths : recovery.yearOverYear;
      if (['annual_change', 'recent_change', 'relative_change'].includes(finding.type)) {
        const key = finding.type === 'relative_change' ? 'relativeChangePercent' : 'changePercent';
        finding.value = c[key].value; finding.unavailableReason = c[key].reason?.code ?? null; finding.method = c.method;
        finding.metricPath = `recovery.${finding.type === 'recent_change' ? 'lastThreeMonths' : 'yearOverYear'}.${key}`;
        finding.coveragePercent = c.coveragePercent;
      }
      finding.warnings = [...new Set([...finding.warnings, ...c.warnings])];
      const annual = recovery.yearOverYear.changePercent.value, relative = recovery.yearOverYear.relativeChangePercent.value, recent = recovery.lastThreeMonths.changePercent.value;
      if (annual !== null && relative !== null && Math.sign(annual) !== Math.sign(relative)) finding.warnings.push('ABSOLUTE_RELATIVE_DISAGREEMENT');
      if (annual !== null && recent !== null && Math.sign(annual) !== Math.sign(recent)) finding.warnings.push('ANNUAL_RECENT_DISAGREEMENT');
      if (c.previous.value !== null && c.previous.value < 1000) finding.warnings.push('LOW_BASELINE_VOLUME');
      if (c.method !== 'daily') finding.warnings.push('DAILY_SENSITIVITY_LIMITED');
    }
  }
  return analysisSchema.parse({ schemaVersion: '3.0.0', diagnosticVersion: DIAGNOSTIC_VERSION, mode: manifest.request.mode ?? 'article', topicStudy, recoveryEnabled: manifest.request.recoverGaps, completion: manifest.completion, knownIssues: knownDataIssues(dataset.period), runId: manifest.runId, source: manifest.source, createdAt: manifest.createdAt,
    period: dataset.period, criterion: manifest.request.criterion, policy: DIAGNOSTIC_POLICY, entries, findings, evidence, sources: manifest.snapshots, articleSources: sourceLinks(manifest),
    topics: manifest.topics.map(t => ({ topicId: t.topic.topicId, label: t.topic.label, selected: t.candidates.map(c => ({ qid: c.qid, label: c.label })), included: t.coverage.includedQids, excluded: t.coverage.excludedQids, matrix: t.coverage.matrix })),
    warnings: [...new Set(manifest.warnings.map(w => w.code))],
    limitations: ['VIEWS_NOT_PEOPLE', 'LANGUAGE_NOT_COUNTRY', 'INTEREST_NOT_PAYMENT', 'ARTICLE_SUM_NOT_AUDIENCE', 'CURRENT_TITLE_HISTORY_LIMIT', 'HEURISTIC_NOT_PROBABILITY', 'NO_PROVEN_SEASONALITY_OR_FORECAST'],
    hypotheses: topicStudy ? topicStudy.languages.flatMap(l => l.hypotheses.map(h => `${l.language} / ${h.subtopic} / ${h.findingId}: ${h.suggestion}`)) : ['INTERVIEW_PROBLEM_AND_CONTEXT', 'TEST_DEMAND_AND_PAYMENT'],
  });
}

const csv = (value: string | number | null): string => {
  if (value === null) return '';
  const text = String(value);
  // Захист від формул у табличних редакторах, крім числових значень.
  const safe = typeof value === 'string' && /^[=+@\-\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
};
export function seriesCsv(analysis: Analysis, dataset: Dataset): string {
  const lines: (string | number | null)[][] = [['scenario', 'topicId', 'language', 'date', 'topicViews', 'projectViews', 'viewsPerMillion']];
  for (const row of dataset.topics) {
    const project = new Map(dataset.series.find(s => s.kind === 'project' && s.language === row.language)?.points.map(p => [p.date, p.views]));
    const entry = analysis.entries.find(e => e.topicId === row.topicId && e.language === row.language)!;
    for (const [scenario, points] of [['original', row.points], ['local_upper_cap', entry.diagnostic.sensitivity.available ? entry.diagnostic.sensitivity.points : []]] as const) {
      for (const point of points) {
        const denominator = project.get(point.date) ?? null;
        lines.push([scenario, row.topicId, row.language, point.date, point.views, denominator, point.views !== null && denominator !== null && denominator > 0 ? point.views / denominator * 1_000_000 : null]);
      }
    }
  }
  return `${lines.map(line => line.map(csv).join(',')).join('\r\n')}\r\n`;
}
