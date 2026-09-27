import { z } from 'zod';
import { comparisonWindows, dates, monthBlocks, monthStart, monthEnd } from './calendar.js';
import { calculate, compareWindows, comparisonSchema, metricSchema, perMillion, relativeChange, sum, unavailable, type Comparison, type Metric } from './calculations.js';
import { periodSchema, type Period } from './schemas.js';
import type { DailyPoint, Series } from './series.js';

export const RECOVERY_POLICY = Object.freeze({ version: '1.0.0', minimumPairCoverage: 0.95, minimumMonthCoverage: 0.8, minimumAnnualPairs: 300, minimumRecentPairs: 60, leapDay: 'exclude_both_windows' as const });
export const recoveredComparisonSchema = comparisonSchema.extend({
  method: z.enum(['daily', 'api_monthly', 'matched_calendar_change', 'unavailable']),
  pairedDays: z.number().int(), possiblePairs: z.number().int(), coveragePercent: z.number(),
  excludedDates: z.array(z.string()), warnings: z.array(z.string()),
});
export const recoverySchema = z.object({
  policyVersion: z.literal('1.0.0'), yearOverYear: recoveredComparisonSchema, lastThreeMonths: recoveredComparisonSchema,
  periodSummary: z.object({ method: z.enum(['daily', 'api_monthly', 'unavailable']), totalViews: metricSchema, dailyAverage: metricSchema, perMillion: metricSchema }).optional(),
  monthly: z.array(z.object({ month: z.string(), period: periodSchema, topicViews: z.number().nullable(), projectViews: z.number().nullable(), perMillion: z.number().nullable(), status: z.enum(['usable', 'discrepant', 'unavailable']) })),
});
export type Recovery = z.infer<typeof recoverySchema>;
export interface RecoveryRow { id: string; topic: DailyPoint[]; project: DailyPoint[]; articles: Series[]; projectSeries?: Series }

function apiValue(series: Series | undefined, month: string): number | null {
  const value = series?.apiMonthly?.find(m => m.month === month);
  return value?.status === 'usable' ? value.views : null;
}
function monthlyRows(row: RecoveryRow, period: Period): Recovery['monthly'] {
  return monthBlocks(period).filter(p => p.start === monthStart(p.start) && p.end === monthEnd(p.end)).map(p => {
    const month = p.start.slice(0, 7), topic = sum(row.articles.map(s => apiValue(s, month))), project = apiValue(row.projectSeries, month);
    const discrepant = [...row.articles, ...(row.projectSeries ? [row.projectSeries] : [])].some(s => s.apiMonthly?.some(m => m.month === month && m.status === 'discrepant'));
    return { month, period: p, topicViews: topic.value, projectViews: project, perMillion: perMillion(topic, { value: project, reason: project === null ? unavailable('MISSING_DATA').reason : null }).value, status: discrepant ? 'discrepant' : topic.value !== null && project !== null ? 'usable' : 'unavailable' };
  });
}
function comparison(current: Metric, previous: Metric, currentProject: Metric, previousProject: Metric, windows: { current: Period; previous: Period }): Comparison {
  const currentPerMillion = perMillion(current, currentProject), previousPerMillion = perMillion(previous, previousProject);
  return { currentPeriod: windows.current, previousPeriod: windows.previous, current, previous, changePercent: relativeChange(current, previous), currentPerMillion, previousPerMillion, relativeChangePercent: relativeChange(currentPerMillion, previousPerMillion) };
}
function uniqueMap(points: DailyPoint[]): Map<string, number | null> {
  const map = new Map<string, number | null>();
  for (const point of points) map.set(point.date, map.has(point.date) ? null : point.views);
  return map;
}
function usable(value: number | null | undefined): value is number { return value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 0; }

/** Спільна маска для всіх мов, статей і знаменників одного складу концепцій. */
export function recoverComparisons(rows: RecoveryRow[], period: Period): Map<string, Recovery> {
  const result = new Map<string, Recovery>();
  const monthly = new Map(rows.map(row => [row.id, monthlyRows(row, period)]));
  const windowsFor = (months: 3 | 12) => {
    const windows = comparisonWindows(period, months);
    const maps = rows.map(row => ({ topic: uniqueMap(row.topic), project: uniqueMap(row.project) }));
    const strict = rows.map(row => compareWindows(row.topic, row.project, period, months, !row.articles.length));
    if (!windows) return strict.map(c => ({ ...c, method: 'unavailable' as const, pairedDays: 0, possiblePairs: 0, coveragePercent: 0, excludedDates: [], warnings: ['INSUFFICIENT_HISTORY'] }));
    const prior = (day: string) => `${Number(day.slice(0, 4)) - 1}${day.slice(4)}`;
    const currentDays = dates(windows.current), previousDays = dates(windows.previous);
    const candidates = currentDays.filter(d => !d.endsWith('-02-29'));
    const kept = candidates.filter(d => maps.every(map => usable(map.topic.get(d)) && usable(map.topic.get(prior(d))) && usable(map.project.get(d)) && usable(map.project.get(prior(d)))));
    const excluded = [...new Set([...candidates.filter(d => !kept.includes(d)).flatMap(d => [prior(d), d]), ...[...currentDays, ...previousDays].filter(d => d.endsWith('-02-29'))])].sort();
    const coverage = kept.length / candidates.length;
    const monthCoverage = monthBlocks(windows.current).every(p => {
      const expected = candidates.filter(d => d >= p.start && d <= p.end), actual = kept.filter(d => d >= p.start && d <= p.end);
      return actual.length / expected.length >= RECOVERY_POLICY.minimumMonthCoverage;
    });
    const sufficient = coverage >= RECOVERY_POLICY.minimumPairCoverage && monthCoverage && kept.length >= (months === 12 ? RECOVERY_POLICY.minimumAnnualPairs : RECOVERY_POLICY.minimumRecentPairs);
    const dense = maps.every(m => [...currentDays, ...previousDays].every(d => usable(m.topic.get(d)) && usable(m.project.get(d))));
    const monthlyUsable = rows.every(row => [...monthBlocks(windows.current), ...monthBlocks(windows.previous)].every(p => monthly.get(row.id)!.some(m => m.month === p.start.slice(0, 7) && m.status === 'usable')));
    return rows.map((row, index) => {
      const warnings: string[] = [];
      const details = { pairedDays: kept.length, possiblePairs: candidates.length, coveragePercent: coverage * 100, excludedDates: excluded };
      if (dense) return { ...strict[index]!, ...details, method: 'daily' as const, warnings };
      const allMonths = monthly.get(row.id)!;
      if (allMonths.some(m => m.status === 'discrepant')) warnings.push('MONTHLY_DAILY_DISCREPANCY');
      if (monthlyUsable) {
        const total = (p: Period, key: 'topicViews' | 'projectViews') => sum(allMonths.filter(m => m.period.start >= p.start && m.period.end <= p.end).map(m => m[key]));
        return { ...comparison(total(windows.current, 'topicViews'), total(windows.previous, 'topicViews'), total(windows.current, 'projectViews'), total(windows.previous, 'projectViews'), windows), ...details, method: 'api_monthly' as const, warnings: [...warnings, 'MONTHLY_NOT_INDEPENDENT', 'DAILY_COMPLETENESS_UNPROVEN'] };
      }
      if (excluded.some(d => d.endsWith('-02-29'))) warnings.push('LEAP_DAY_EXCLUDED');
      if (!sufficient || !row.articles.length) {
        if (row.articles.length && [...currentDays, ...previousDays].every(d => usable(maps[index]!.topic.get(d)) && usable(maps[index]!.project.get(d)))) {
          return { ...strict[index]!, ...details, method: 'daily' as const, warnings: [...warnings, 'COMMON_MASK_UNAVAILABLE_INDIVIDUAL_ONLY'] };
        }
        const missing = unavailable('MISSING_DATA');
        return { ...comparison(missing, missing, missing, missing, windows), ...details, method: 'unavailable' as const, warnings: [...warnings, 'MATCHED_COVERAGE_INSUFFICIENT'] };
      }
      const map = maps[index]!;
      return { ...comparison(sum(kept.map(d => map.topic.get(d)!)), sum(kept.map(d => map.topic.get(prior(d))!)), sum(kept.map(d => map.project.get(d)!)), sum(kept.map(d => map.project.get(prior(d))!)), windows), ...details, method: 'matched_calendar_change' as const, warnings: [...warnings, 'MATCHED_NOT_FULL_YEAR', 'MISSINGNESS_MAY_BE_BIASED'] };
    });
  };
  const annual = windowsFor(12), recent = windowsFor(3);
  rows.forEach((row, index) => {
    const strict = calculate(row.topic, row.project, period), months = monthly.get(row.id)!;
    let periodSummary: NonNullable<Recovery['periodSummary']> = { method: strict.quality.complete ? 'daily' : 'unavailable', totalViews: strict.totalViews, dailyAverage: strict.dailyAverage, perMillion: strict.perMillion };
    if (!strict.quality.complete && period.start === monthStart(period.start) && period.end === monthEnd(period.end) && months.length && months.every(m => m.status === 'usable')) {
      const total = sum(months.map(m => m.topicViews)), project = sum(months.map(m => m.projectViews));
      periodSummary = { method: 'api_monthly', totalViews: total, dailyAverage: total.value === null ? total : { value: total.value / dates(period).length, reason: null }, perMillion: perMillion(total, project) };
    }
    result.set(row.id, recoverySchema.parse({ policyVersion: RECOVERY_POLICY.version, yearOverYear: annual[index], lastThreeMonths: recent[index], monthly: months, periodSummary }));
  });
  return result;
}
