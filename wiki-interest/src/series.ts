import { z } from 'zod';
import { dates, monthBlocks, monthStart, monthEnd } from './calendar.js';
import { AppError, asError } from './errors.js';
import { dateSchema, periodSchema, warning, warningSchema, type Period, type Warning } from './schemas.js';
import { canonical, sha256 } from './storage.js';
import { projectName, type SeriesRequest } from './requests.js';
import type { DataGateway } from './gateway.js';

export const dailyPointSchema = z.object({ date: dateSchema, views: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable() });
export type DailyPoint = z.infer<typeof dailyPointSchema>;
export const apiMonthSchema = z.object({ month: z.string(), views: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(), status: z.enum(['usable', 'discrepant', 'unavailable']), observedDailySum: z.number(), receivedDays: z.number().int(), expectedDays: z.number().int(), dailyComplete: z.boolean(), warnings: z.array(warningSchema) });
export type ApiMonth = z.infer<typeof apiMonthSchema>;
export const seriesSchema = z.object({ id: z.string(), kind: z.enum(['article', 'project']), language: z.string(), title: z.string().optional(), period: periodSchema, points: z.array(dailyPointSchema), warnings: z.array(warningSchema), apiMonthly: z.array(apiMonthSchema).optional() });
export type Series = z.infer<typeof seriesSchema>;
export function seriesId(request: SeriesRequest): string {
  const { period: _period, ...identity } = request;
  return sha256(canonical(identity));
}

export function validateSeries(raw: unknown, request: SeriesRequest, selected: Period = request.period): { points: DailyPoint[]; warnings: Warning[] } {
  const envelope = z.object({ items: z.array(z.unknown()) }).safeParse(raw);
  if (!envelope.success) throw new AppError('INVALID_RESPONSE', 'Відповідь Analytics API не містить масиву items.');
  const metadataSchema = z.object({ project: z.string(), access: z.string(), agent: z.string(), granularity: z.literal('daily'), timestamp: z.string(), views: z.unknown(), article: z.string().optional() });
  const viewsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
  const values = new Map<string, number | null>();
  const counts = new Map<string, number>();
  const warnings: Warning[] = [];
  let malformed = false;
  for (const item of envelope.data.items) {
    const parsed = metadataSchema.safeParse(item);
    if (!parsed.success) { malformed = true; warnings.push(warning('INVALID_DATA_POINT', 'Запис API має невалідні поля.')); continue; }
    const row = parsed.data;
    if (![projectName(request.language), `${request.language}.wikipedia`].includes(row.project) || row.access !== request.filters.access || row.agent !== request.filters.agent || (request.kind === 'article' && row.article?.replaceAll('_', ' ') !== request.title.replaceAll('_', ' '))) throw new AppError('SERIES_IDENTITY_MISMATCH', 'Метадані API не відповідають запитаному ряду.');
    const day = `${row.timestamp.slice(0, 4)}-${row.timestamp.slice(4, 6)}-${row.timestamp.slice(6, 8)}`;
    if (!/^\d{8}00$/.test(row.timestamp) || !dateSchema.safeParse(day).success) { malformed = true; warnings.push(warning('INVALID_DATE', 'API повернув невалідну денну дату.')); continue; }
    if (day < request.period.start || day > request.period.end) { malformed = true; warnings.push(warning('OUT_OF_RANGE_DATE', 'API повернув дату поза запитаним блоком.', { date: day })); continue; }
    counts.set(day, (counts.get(day) ?? 0) + 1);
    const views = viewsSchema.safeParse(row.views);
    values.set(day, views.success ? views.data : null);
    if (!views.success) warnings.push(warning('INVALID_VIEWS', 'Невалідне або від’ємне значення переглядів.', { date: day }));
  }
  for (const [date, count] of counts) if (count > 1) { values.set(date, null); warnings.push(warning('DUPLICATE_DATE', 'Повторну дату не підсумовано; її значення невідоме.', { date, count })); }
  const expected = dates(selected);
  const missing = expected.filter(date => !values.has(date));
  if (missing.length) warnings.push(warning('MISSING_DATES', 'Відсутні дні неоднозначні: AQS може пропускати нулі або ще не завантажені дані. Збережено null; нулі не припускаються.', { count: missing.length, first: missing[0], last: missing.at(-1), assumption: 'unknown_not_zero', uncertainty: 'zero_or_not_loaded', source: 'https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/documentation/troubleshooting.html' }));
  return { points: expected.map(date => ({ date, views: malformed ? null : values.get(date) ?? null })), warnings };
}

export class SeriesLoader {
  private readonly memo = new Map<string, Series>();
  constructor(private readonly gateway: DataGateway) {}
  async monthly(series: Series, request: SeriesRequest): Promise<void> {
    if (series.apiMonthly) return;
    series.apiMonthly = [];
    for (const period of monthBlocks(request.period).filter(p => p.start === monthStart(p.start) && p.end === monthEnd(p.end))) {
      try {
        const monthlyRequest = { ...request, period, granularity: 'monthly' as const };
        const response = await this.gateway.get(monthlyRequest);
        series.apiMonthly.push(validateApiMonth(response.data, monthlyRequest, series.points));
      } catch (error) {
        const problem = asError(error);
        if (['UNSAFE_PATH', 'CHECKSUM_MISMATCH', 'SNAPSHOT_MISMATCH'].includes(problem.code)) throw error;
        const base = dailyMonth(period, series.points);
        series.apiMonthly.push({ ...base, views: null, status: 'unavailable', warnings: [warning(problem.code, problem.message, problem.details)] });
      }
    }
    series.warnings.push(...series.apiMonthly.flatMap(m => m.warnings));
  }
  async load(request: SeriesRequest): Promise<Series> {
    const id = seriesId(request);
    const memoKey = canonical(request);
    const saved = this.memo.get(memoKey); if (saved) return saved;
    const points: DailyPoint[] = [];
    const warnings: Warning[] = [];
    for (const period of monthBlocks(request.period)) {
      try {
        const response = await this.gateway.get({ ...request, period });
        if (response.request.kind !== 'article' && response.request.kind !== 'project') throw new AppError('SERIES_IDENTITY_MISMATCH', 'Знімок не є часовим рядом.');
        const checked = validateSeries(response.data, response.request, period);
        points.push(...checked.points); warnings.push(...checked.warnings);
      } catch (error) {
        const problem = asError(error);
        if (['USER_AGENT_REQUIRED', 'USER_AGENT_INVALID', 'UNSAFE_PATH', 'CHECKSUM_MISMATCH', 'SNAPSHOT_MISSING', 'SNAPSHOT_MISMATCH'].includes(problem.code)) throw error;
        points.push(...dates(period).map(date => ({ date, views: null })));
        warnings.push(warning(problem.code, problem.message, { period, ...problem.details }));
      }
    }
    const result: Series = { id, kind: request.kind, language: request.language, ...(request.kind === 'article' ? { title: request.title } : {}), period: request.period, points, warnings };
    this.memo.set(memoKey, result); return result;
  }
}

function dailyMonth(period: Period, points: DailyPoint[]) {
  const days = points.filter(p => p.date >= period.start && p.date <= period.end && p.views !== null);
  const expectedDays = dates(period).length;
  return { month: period.start.slice(0, 7), observedDailySum: days.reduce((n, p) => n + p.views!, 0), receivedDays: days.length, expectedDays, dailyComplete: days.length === expectedDays };
}
export function validateApiMonth(raw: unknown, request: SeriesRequest, daily: DailyPoint[]): ApiMonth {
  const base = dailyMonth(request.period, daily);
  const response = z.object({ items: z.array(z.object({ project: z.string(), access: z.string(), agent: z.string(), granularity: z.literal('monthly'), timestamp: z.string(), views: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), article: z.string().optional() })) }).parse(raw);
  const rows = response.items;
  if (rows.length !== 1) throw new AppError('MONTHLY_RECORD_COUNT', 'Для календарного місяця потрібен рівно один агрегат; пропуск не дорівнює нулю.');
  const row = rows[0]!;
  if (![projectName(request.language), `${request.language}.wikipedia`].includes(row.project) || row.access !== request.filters.access || row.agent !== request.filters.agent || row.timestamp !== `${monthStart(request.period.start).replaceAll('-', '')}00` || (request.kind === 'article' && row.article?.replaceAll('_', ' ') !== request.title.replaceAll('_', ' '))) throw new AppError('SERIES_IDENTITY_MISMATCH', 'Місячний агрегат не відповідає запитаному ряду, фільтрам чи місяцю.');
  const discrepant = !Number.isSafeInteger(base.observedDailySum) || row.views < base.observedDailySum || base.dailyComplete && row.views !== base.observedDailySum;
  const warnings = [warning('MONTHLY_NOT_INDEPENDENT', 'Місячний агрегат походить із того самого AQS; він не доводить повноту завантаження або нульові значення пропущених днів.')];
  if (discrepant) warnings.push(warning('MONTHLY_DAILY_DISCREPANCY', 'Місячний агрегат суперечить наявним денним сумам і не використовується для резервного показника.', { month: base.month, monthlyViews: row.views, observedDailySum: base.observedDailySum }));
  else if (!base.dailyComplete) warnings.push(warning('MONTHLY_WITH_DAILY_GAPS', 'Денні прогалини збережено; місячний показник доступний з обмеженнями.', { month: base.month, difference: row.views - base.observedDailySum }));
  return { ...base, views: row.views, status: discrepant ? 'discrepant' : 'usable', warnings };
}
