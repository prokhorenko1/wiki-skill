import { describe, expect, it } from 'vitest';
import { calculate, aggregatePages, perMillion, relativeChange, sum } from '../src/calculations.js';
import { dates, getPeriod, comparisonWindows } from '../src/calendar.js';
import { validateSeries } from '../src/series.js';
import type { SeriesRequest } from '../src/requests.js';

const period = { start: '2021-01-01', end: '2022-12-31' };
const points = (before: number, after = before) => dates(period).map(date => ({ date, views: date < '2022-01-01' ? before : after }));
const metric = (value: number) => ({ value, reason: null });
describe('Календар і чисті розрахунки', () => {
  it('визначає 24 завершені місяці в UTC', () => {
    expect(getPeriod(undefined, { now: () => new Date('2026-09-27T03:00:00Z') })).toEqual({ start: '2024-09-01', end: '2026-08-31' });
    expect(getPeriod(undefined, { now: () => new Date('2024-01-01T00:00:00Z') })).toEqual({ start: '2022-01-01', end: '2023-12-31' });
  });
  it('не обрізає недоступні чи невалідні дати', () => {
    const clock = { now: () => new Date('2026-09-27Z') };
    for (const bad of [{ start: '2015-06-30', end: '2020-01-01' }, { start: '2026-09-01', end: '2026-09-27' }, { start: '2022-03-01', end: '2022-02-01' }, { start: '2023-02-29', end: '2023-03-01' }]) expect(() => getPeriod(bad, clock)).toThrow();
  });
  it('постійний ряд має відому суму, середнє та нульову зміну', () => {
    const result = calculate(points(100), points(100000), period);
    expect(result.totalViews.value).toBe(73000);
    expect(result.dailyAverage.value).toBe(100);
    expect(result.yearOverYear.previous.value).toBe(36500);
    expect(result.yearOverYear.current.value).toBe(36500);
    expect(result.yearOverYear.changePercent.value).toBe(0);
    expect(result.monthly[0]?.views.value).toBe(3100);
  });
  it('розрізняє абсолютне зростання і зменшення частки', () => {
    const result = calculate(points(100, 200), points(100000, 250000), period);
    expect(result.yearOverYear.previous.value).toBe(36500);
    expect(result.yearOverYear.current.value).toBe(73000);
    expect(result.yearOverYear.changePercent.value).toBe(100);
    expect(result.yearOverYear.previousPerMillion.value).toBe(1000);
    expect(result.yearOverYear.currentPerMillion.value).toBe(800);
    expect(result.yearOverYear.relativeChangePercent.value).toBeCloseTo(-20);
    expect(result.lastThreeMonths.previous.value).toBe(9200);
    expect(result.lastThreeMonths.current.value).toBe(18400);
    expect(result.lastThreeMonths.changePercent.value).toBe(100);
  });
  it('використовує відношення сум', () => expect(perMillion(sum([10, 20]), sum([100, 900])).value).toBe(30000));
  it('повертає пояснення за нульової бази та знаменника', () => {
    expect(relativeChange(metric(5), metric(0))).toMatchObject({ value: null, reason: { code: 'ZERO_BASE' } });
    expect(perMillion(metric(5), metric(0))).toMatchObject({ value: null, reason: { code: 'ZERO_DENOMINATOR' } });
  });
  it('не обчислює непорівнювані вікна', () => {
    const result = calculate(points(100), points(1000), { start: '2022-01-01', end: '2022-12-31' });
    expect(result.yearOverYear.changePercent).toMatchObject({ value: null, reason: { code: 'INSUFFICIENT_HISTORY' } });
    expect(result.lastThreeMonths.changePercent.value).toBeNull();
  });
  it('враховує 29 лютого та довжину року', () => {
    const leap = { start: '2024-02-01', end: '2024-02-29' };
    const data = dates(leap).map(date => ({ date, views: 100 }));
    expect(calculate(data, data, leap).monthly[0]).toMatchObject({ expectedDays: 29, fullMonth: true, views: { value: 2900 } });
    expect(dates({ start: '2024-01-01', end: '2024-12-31' })).toHaveLength(366);
  });
  it('прогалини не стають нулями і не зміщують вікна', () => {
    const data = points(100).filter(p => p.date !== '2022-12-31');
    const result = calculate(data, points(100000), period);
    expect(result.totalViews.value).toBeNull();
    expect(result.yearOverYear.currentPeriod?.end).toBe('2022-12-31');
    expect(result.yearOverYear.changePercent.value).toBeNull();
    expect(result.monthly[0]?.views.value).toBe(3100);
    expect(result.quality.receivedTopicDays).toBe(729);
  });
  it('не включає часткові крайові місяці у річні вікна', () => {
    expect(comparisonWindows({ start: '2020-01-15', end: '2022-12-15' }, 12)).toEqual({ current: { start: '2021-12-01', end: '2022-11-30' }, previous: { start: '2020-12-01', end: '2021-11-30' } });
    expect(calculate(points(100), points(1000), { start: '2021-01-15', end: '2021-02-10' }).monthly.map(m => m.fullMonth)).toEqual([false, false]);
  });
  it('вимагає дані кожної статті для суми набору', () => {
    expect(aggregatePages([[{ date: '2021-01-01', views: 10 }], []], { start: '2021-01-01', end: '2021-01-01' })).toEqual([{ date: '2021-01-01', views: null }]);
  });
});

describe('Валідація рядів API', () => {
  const request: SeriesRequest = { kind: 'article', language: 'uk', title: 'Астрономія', filters: { access: 'all-access', agent: 'user' }, period: { start: '2021-01-01', end: '2021-01-02' } };
  const row = (timestamp: string, views: unknown) => ({ project: 'uk.wikipedia', article: 'Астрономія', granularity: 'daily', access: 'all-access', agent: 'user', timestamp, views });
  it('відсутній день невідомий', () => {
    const result = validateSeries({ items: [row('2021010100', 0)] }, request);
    expect(result.points).toEqual([{ date: '2021-01-01', views: 0 }, { date: '2021-01-02', views: null }]);
    expect(result.warnings[0]?.code).toBe('MISSING_DATES');
  });
  it('дубльована дата не додається і не вибирається довільно', () => {
    const result = validateSeries({ items: [row('2021010100', 10), row('2021010100', 20), row('2021010200', 5)] }, request);
    expect(result.points[0]?.views).toBeNull();
    expect(result.warnings.some(w => w.code === 'DUPLICATE_DATE')).toBe(true);
  });
  it.each([-1, 1.5, '10', null, Number.MAX_SAFE_INTEGER + 1])('відхиляє значення %s', views => {
    expect(validateSeries({ items: [row('2021010100', views)] }, request).points[0]?.views).toBeNull();
  });
  it('перевіряє фільтри та ідентичність статті', () => {
    expect(() => validateSeries({ items: [{ ...row('2021010100', 5), agent: 'spider' }] }, request)).toThrow('Метадані');
    expect(() => validateSeries({ items: [{ ...row('2021010100', 5), article: 'Інша стаття' }] }, request)).toThrow('Метадані');
  });
  it('позначає сторонні та невалідні дати', () => {
    for (const timestamp of ['2021010300', '2021023000', '2021010112']) expect(validateSeries({ items: [row(timestamp, 10)] }, request).points.every(p => p.views === null)).toBe(true);
  });
});
