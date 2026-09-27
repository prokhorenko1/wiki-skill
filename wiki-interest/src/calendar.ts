import { AppError } from './errors.js';
import { periodSchema, type Period } from './schemas.js';

export interface Clock { now(): Date }
export const systemClock: Clock = { now: () => new Date() };
export const isoDate = (date: Date): string => date.toISOString().slice(0, 10);
export const parseDate = (date: string): Date => new Date(`${date}T00:00:00.000Z`);
export function shiftDay(date: string, days: number): string {
  const result = parseDate(date); result.setUTCDate(result.getUTCDate() + days); return isoDate(result);
}
export function monthStart(date: string, offset = 0): string {
  const result = parseDate(date); return isoDate(new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + offset, 1)));
}
export const monthEnd = (date: string): string => shiftDay(monthStart(date, 1), -1);
export function dates(period: Period): string[] {
  const result: string[] = [];
  for (let date = period.start; date <= period.end; date = shiftDay(date, 1)) result.push(date);
  return result;
}
export function getPeriod(input: Period | undefined, clock: Clock): Period {
  const today = isoDate(clock.now());
  const period = periodSchema.parse(input ?? { start: monthStart(today, -24), end: shiftDay(monthStart(today), -1) });
  if (period.start > period.end) throw new AppError('INVALID_PERIOD', 'Початок періоду пізніше завершення.');
  if (period.start < '2015-07-01' || period.end >= today) throw new AppError('PERIOD_UNAVAILABLE', 'Період має починатися не раніше 2015-07-01 і закінчуватися до поточного дня UTC.', { requested: period, latestCompletedDay: shiftDay(today, -1) });
  return period;
}
export function monthBlocks(period: Period): Period[] {
  const blocks: Period[] = [];
  for (let start = monthStart(period.start); start <= period.end; start = monthStart(start, 1)) {
    blocks.push({ start: start < period.start ? period.start : start, end: monthEnd(start) > period.end ? period.end : monthEnd(start) });
  }
  return blocks;
}
export function comparisonWindows(period: Period, count: 3 | 12): { current: Period; previous: Period } | null {
  const last = period.end === monthEnd(period.end) ? monthStart(period.end) : monthStart(period.end, -1);
  const current = { start: monthStart(last, 1 - count), end: monthEnd(last) };
  const previous = { start: monthStart(current.start, -12), end: monthEnd(monthStart(last, -12)) };
  return previous.start < period.start || current.end < period.start ? null : { current, previous };
}
