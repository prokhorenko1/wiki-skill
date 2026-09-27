import { z } from 'zod';
import { comparisonWindows, dates, monthBlocks, monthEnd, monthStart } from './calendar.js';
import { periodSchema, type Period } from './schemas.js';
import type { DailyPoint } from './series.js';

const reasons = {
  MISSING_DATA: 'У потрібному вікні є пропущені або невалідні дані.',
  INSUFFICIENT_HISTORY: 'Недостатньо історії для повних порівнюваних календарних вікон.',
  ZERO_BASE: 'Відносна зміна за нульової бази не визначена.',
  ZERO_DENOMINATOR: 'Перегляди проєкту дорівнюють нулю; нормалізація не визначена.',
  NO_COMMON_CONCEPTS: 'Немає спільних концепцій для мовного порівняння.',
  UNSAFE_TOTAL: 'Сума перевищує точність цілочисельних обчислень JavaScript.',
} as const;
export const metricSchema = z.object({ value: z.number().finite().nullable(), reason: z.object({ code: z.enum(Object.keys(reasons) as [keyof typeof reasons, ...(keyof typeof reasons)[]]), message: z.string() }).nullable() });
export type Metric = z.infer<typeof metricSchema>;
export const unavailable = (code: keyof typeof reasons): Metric => ({ value: null, reason: { code, message: reasons[code] } });
const value = (number: number): Metric => ({ value: number, reason: null });

export function sum(values: (number | null)[]): Metric {
  if (!values.length || values.some(v => v === null || !Number.isSafeInteger(v) || v < 0)) return unavailable('MISSING_DATA');
  const total = values.reduce<number>((a, b) => a + b!, 0);
  return Number.isSafeInteger(total) ? value(total) : unavailable('UNSAFE_TOTAL');
}
export function relativeChange(current: Metric, previous: Metric): Metric {
  if (previous.value === null) return previous;
  if (current.value === null) return current;
  if (previous.value === 0) return unavailable('ZERO_BASE');
  return value((current.value / previous.value - 1) * 100);
}
export function perMillion(topic: Metric, project: Metric): Metric {
  if (topic.value === null) return topic;
  if (project.value === null) return project;
  if (project.value === 0) return unavailable('ZERO_DENOMINATOR');
  return value(topic.value / project.value * 1_000_000);
}
export function aggregatePages(pages: DailyPoint[][], period: Period): DailyPoint[] {
  const maps = pages.map(points => {
    const map = new Map<string, number | null>();
    for (const point of points) map.set(point.date, map.has(point.date) ? null : point.views);
    return map;
  });
  return dates(period).map(date => ({ date, views: sum(maps.map(map => map.get(date) ?? null)).value }));
}
function sumWindow(points: DailyPoint[], period: Period): Metric {
  const map = new Map(points.map(point => [point.date, point.views]));
  if (map.size !== points.length) return unavailable('MISSING_DATA');
  return sum(dates(period).map(date => map.get(date) ?? null));
}
export const comparisonSchema = z.object({
  currentPeriod: periodSchema.nullable(), previousPeriod: periodSchema.nullable(),
  current: metricSchema, previous: metricSchema, changePercent: metricSchema,
  currentPerMillion: metricSchema, previousPerMillion: metricSchema, relativeChangePercent: metricSchema,
});
export type Comparison = z.infer<typeof comparisonSchema>;
export function compareWindows(topic: DailyPoint[], project: DailyPoint[], period: Period, months: 3 | 12, noConcepts = false): Comparison {
  const windows = comparisonWindows(period, months);
  if (!windows || noConcepts) {
    const metric = unavailable(noConcepts ? 'NO_COMMON_CONCEPTS' : 'INSUFFICIENT_HISTORY');
    return { currentPeriod: windows?.current ?? null, previousPeriod: windows?.previous ?? null, current: metric, previous: metric, changePercent: metric, currentPerMillion: metric, previousPerMillion: metric, relativeChangePercent: metric };
  }
  const current = sumWindow(topic, windows.current), previous = sumWindow(topic, windows.previous);
  const currentPerMillion = perMillion(current, sumWindow(project, windows.current));
  const previousPerMillion = perMillion(previous, sumWindow(project, windows.previous));
  return { currentPeriod: windows.current, previousPeriod: windows.previous, current, previous, changePercent: relativeChange(current, previous), currentPerMillion, previousPerMillion, relativeChangePercent: relativeChange(currentPerMillion, previousPerMillion) };
}
export const monthlySchema = z.object({
  month: z.string(), period: periodSchema, fullMonth: z.boolean(), expectedDays: z.number().int(), receivedTopicDays: z.number().int(), receivedProjectDays: z.number().int(),
  views: metricSchema, dailyAverage: metricSchema, perMillion: metricSchema,
});
export const calculationSchema = z.object({
  totalViews: metricSchema, dailyAverage: metricSchema, perMillion: metricSchema,
  yearOverYear: comparisonSchema, lastThreeMonths: comparisonSchema, monthly: z.array(monthlySchema),
  quality: z.object({ expectedDays: z.number().int(), receivedTopicDays: z.number().int(), receivedProjectDays: z.number().int(), complete: z.boolean() }),
});
export type Calculation = z.infer<typeof calculationSchema>;
export function calculate(topic: DailyPoint[], project: DailyPoint[], period: Period, noConcepts = false): Calculation {
  const totalViews = noConcepts ? unavailable('NO_COMMON_CONCEPTS') : sumWindow(topic, period);
  const expectedDays = dates(period).length;
  const knownDays = (points: DailyPoint[], block: Period) => points.filter(p => p.date >= block.start && p.date <= block.end && p.views !== null).length;
  const receivedTopicDays = knownDays(topic, period), receivedProjectDays = knownDays(project, period);
  const average = (metric: Metric, days: number): Metric => metric.value === null ? metric : value(metric.value / days);
  return {
    totalViews, dailyAverage: average(totalViews, expectedDays), perMillion: perMillion(totalViews, sumWindow(project, period)),
    yearOverYear: compareWindows(topic, project, period, 12, noConcepts), lastThreeMonths: compareWindows(topic, project, period, 3, noConcepts),
    quality: { expectedDays, receivedTopicDays, receivedProjectDays, complete: !noConcepts && receivedTopicDays === expectedDays && receivedProjectDays === expectedDays },
    monthly: monthBlocks(period).map(block => {
      const views = noConcepts ? unavailable('NO_COMMON_CONCEPTS') : sumWindow(topic, block);
      return { month: block.start.slice(0, 7), period: block, fullMonth: block.start === monthStart(block.start) && block.end === monthEnd(block.end), expectedDays: dates(block).length,
        receivedTopicDays: knownDays(topic, block), receivedProjectDays: knownDays(project, block), views,
        dailyAverage: average(views, dates(block).length), perMillion: perMillion(views, sumWindow(project, block)) };
    }),
  };
}
