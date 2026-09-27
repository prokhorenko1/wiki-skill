import { z } from 'zod';
import { calculate, calculationSchema, type Calculation } from './calculations.js';
import { dates } from './calendar.js';
import { periodSchema, type Period } from './schemas.js';
import { dailyPointSchema, type DailyPoint } from './series.js';
import { reasonText } from './reporting/locale.js';
import { pairedMonthSensitivity, scenarioSchema } from './sensitivity.js';

export const DIAGNOSTIC_VERSION = '3.0.0';
// Пороги фіксуються до розгляду результатів; CLI не дозволяє їх підбирати.
export const DIAGNOSTIC_POLICY = Object.freeze({
  minimumDays: 90, minimumPositiveFraction: 0.2, neighborRadiusDays: 15, minimumNeighbors: 14,
  madMultiplier: 6, madScale: 1.4826, medianExcessMultiplier: 3, minimumExcessViews: 20,
  minimumBaselineViews: 1000, directionDeadbandPercent: 5, sensitivityDifferencePoints: 10,
  concentratedDayFraction: 0.1, concentratedMonthFraction: 0.25,
});
const reasonSchema = z.object({ code: z.string(), message: z.string(), metrics: z.record(z.string(), z.number().nullable()) });
export const diagnosticSchema = z.object({
  kind: z.literal('diagnostic_heuristic'), status: z.enum(['stable', 'mixed', 'fragile', 'insufficient']),
  reasons: z.array(reasonSchema), limitations: z.array(z.string()),
  completeness: z.object({ expectedDays: z.number(), topicDays: z.number(), projectDays: z.number(), fraction: z.number() }),
  baselineViews: z.number().nullable(), coverage: z.object({ included: z.array(z.string()), excluded: z.array(z.string()) }),
  concentration: z.object({ maximumDayShare: z.number().nullable(), maximumMonthShare: z.number().nullable() }),
  pairedMonths: z.array(scenarioSchema).optional(),
  sensitivity: z.object({
    available: z.boolean(), evaluatedDays: z.number(), unevaluatedDays: z.number(),
    unusualDays: z.array(z.object({ date: z.string(), original: z.number(), replacement: z.number(), localMedian: z.number(), localMad: z.number() })),
    scenario: z.literal('local_upper_cap'), points: z.array(dailyPointSchema), metrics: calculationSchema.nullable(),
    annualDifferencePoints: z.number().nullable(), relativeDifferencePoints: z.number().nullable(), material: z.boolean().nullable(),
  }),
});
export type Diagnostic = z.infer<typeof diagnosticSchema>;
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
export const direction = (value: number): -1 | 0 | 1 => Math.abs(value) <= DIAGNOSTIC_POLICY.directionDeadbandPercent ? 0 : value > 0 ? 1 : -1;

export function diagnose(topic: DailyPoint[], project: DailyPoint[], period: Period, metrics: Calculation, coverage: { included: string[]; excluded: string[] }): Diagnostic {
  periodSchema.parse(period);
  const policy = DIAGNOSTIC_POLICY, expected = dates(period), byDate = new Map(topic.map(p => [p.date, p.views]));
  const points = expected.map(date => ({ date, views: byDate.get(date) ?? null }));
  const known = points.filter(p => p.views !== null), positive = known.filter(p => p.views! > 0).length;
  const reasons: Diagnostic['reasons'] = [];
  const add = (code: string, values: Record<string, number | null> = {}) => reasons.push({ code, message: reasonText[code]?.uk ?? code, metrics: values });
  const fraction = Math.min(metrics.quality.receivedTopicDays, metrics.quality.receivedProjectDays) / expected.length;
  if (!metrics.quality.complete) add('INCOMPLETE_DATA', { completeness: fraction });
  if (coverage.excluded.length) add('UNEQUAL_CONCEPT_COVERAGE', { excluded: coverage.excluded.length });
  if (!coverage.included.length) add('NO_COMMON_CONCEPTS');
  const baseline = metrics.yearOverYear.previous.value;
  if (baseline === null) add('INSUFFICIENT_BASELINE');
  else if (baseline < policy.minimumBaselineViews) add('LOW_BASELINE_VOLUME', { baselineViews: baseline, threshold: policy.minimumBaselineViews });
  const annual = metrics.yearOverYear.changePercent.value, recent = metrics.lastThreeMonths.changePercent.value;
  const relative = metrics.yearOverYear.relativeChangePercent.value;
  if (annual === null || recent === null || relative === null) add('UNAVAILABLE_CHANGE');
  if (annual !== null && recent !== null && direction(annual) !== direction(recent)) add('ANNUAL_RECENT_DISAGREEMENT', { annual, recent });
  if (annual !== null && relative !== null && direction(annual) !== direction(relative)) add('ABSOLUTE_RELATIVE_DISAGREEMENT', { annual, relative });
  const total = metrics.totalViews.value;
  const maximumDayShare = total !== null && total > 0 ? Math.max(...known.map(p => p.views!)) / total : null;
  const maximumMonthShare = total !== null && total > 0 ? Math.max(...metrics.monthly.map(m => m.views.value ?? 0)) / total : null;
  if (maximumDayShare !== null && maximumDayShare >= policy.concentratedDayFraction) add('DAY_CONCENTRATION', { share: maximumDayShare });
  if (maximumMonthShare !== null && maximumMonthShare >= policy.concentratedMonthFraction) add('MONTH_CONCENTRATION', { share: maximumMonthShare });
  const eligible = known.length >= policy.minimumDays && positive / known.length >= policy.minimumPositiveFraction;
  if (known.length < policy.minimumDays) add('TOO_FEW_OBSERVATIONS', { knownDays: known.length });
  else if (!eligible) add('SPARSE_SERIES', { positiveFraction: positive / known.length });
  const unusualDays: Diagnostic['sensitivity']['unusualDays'] = [];
  let evaluatedDays = 0;
  const scenario = points.map((point, index): DailyPoint => {
    if (!eligible || point.views === null) return { ...point };
    const neighbors = points.slice(Math.max(0, index - policy.neighborRadiusDays), index + policy.neighborRadiusDays + 1)
      .filter(p => p.date !== point.date && p.views !== null).map(p => p.views!);
    if (neighbors.length < policy.minimumNeighbors) return { ...point };
    evaluatedDays++;
    const localMedian = median(neighbors), localMad = median(neighbors.map(v => Math.abs(v - localMedian)));
    const cap = Math.ceil(localMedian + Math.max(policy.madMultiplier * policy.madScale * localMad, policy.medianExcessMultiplier * localMedian, policy.minimumExcessViews));
    if (point.views <= cap) return { ...point };
    unusualDays.push({ date: point.date, original: point.views, replacement: cap, localMedian, localMad });
    return { date: point.date, views: cap };
  });
  const scenarioMetrics = eligible ? calculate(scenario, project, period, !coverage.included.length) : null;
  const scenarioAnnual = scenarioMetrics?.yearOverYear.changePercent.value ?? null;
  const scenarioRelative = scenarioMetrics?.yearOverYear.relativeChangePercent.value ?? null;
  const annualDifferencePoints = annual !== null && scenarioAnnual !== null ? scenarioAnnual - annual : null;
  const relativeDifferencePoints = relative !== null && scenarioRelative !== null ? scenarioRelative - relative : null;
  const material = annualDifferencePoints !== null && relativeDifferencePoints !== null
    ? Math.abs(annualDifferencePoints) >= policy.sensitivityDifferencePoints || Math.abs(relativeDifferencePoints) >= policy.sensitivityDifferencePoints || direction(annual!) !== direction(scenarioAnnual!) || direction(relative!) !== direction(scenarioRelative!) : null;
  if (unusualDays.length) add('UNUSUAL_OBSERVATIONS', { count: unusualDays.length });
  if (material) add('SPIKE_SENSITIVE', { annualDifferencePoints, relativeDifferencePoints });
  if (eligible && evaluatedDays < known.length) add('UNEVALUATED_NEIGHBORHOODS', { unevaluatedDays: known.length - evaluatedDays });
  const pairedMonths = pairedMonthSensitivity(metrics, calculate(project, project, period), period);
  if (pairedMonths.some(s => s.directionChanged || Math.abs(s.differencePoints ?? 0) >= policy.sensitivityDifferencePoints)) add('PAIRED_MONTH_SENSITIVE', { maximumDifferencePoints: Math.max(...pairedMonths.map(s => Math.abs(s.differencePoints ?? 0))) });
  const codes = new Set(reasons.map(r => r.code));
  const status = ['INCOMPLETE_DATA', 'NO_COMMON_CONCEPTS', 'INSUFFICIENT_BASELINE', 'UNAVAILABLE_CHANGE', 'TOO_FEW_OBSERVATIONS', 'SPARSE_SERIES', 'UNEVALUATED_NEIGHBORHOODS'].some(c => codes.has(c)) ? 'insufficient'
    : ['SPIKE_SENSITIVE', 'LOW_BASELINE_VOLUME', 'PAIRED_MONTH_SENSITIVE'].some(c => codes.has(c)) ? 'fragile'
    : ['UNEQUAL_CONCEPT_COVERAGE', 'ANNUAL_RECENT_DISAGREEMENT', 'ABSOLUTE_RELATIVE_DISAGREEMENT', 'UNUSUAL_OBSERVATIONS'].some(c => codes.has(c)) ? 'mixed' : 'stable';
  return diagnosticSchema.parse({ kind: 'diagnostic_heuristic', status, reasons,
    limitations: ['HEURISTIC_NOT_PROBABILITY', 'SPIKE_CAUSE_UNKNOWN', 'NO_PROVEN_SEASONALITY_OR_FORECAST', 'LOCAL_CAP_MAY_ALTER_REAL_EVENTS'],
    completeness: { expectedDays: expected.length, topicDays: metrics.quality.receivedTopicDays, projectDays: metrics.quality.receivedProjectDays, fraction },
    baselineViews: baseline, coverage, concentration: { maximumDayShare, maximumMonthShare }, pairedMonths,
    sensitivity: { available: eligible, evaluatedDays, unevaluatedDays: known.length - evaluatedDays, unusualDays, scenario: 'local_upper_cap', points: scenario, metrics: scenarioMetrics, annualDifferencePoints, relativeDifferencePoints, material },
  });
}
