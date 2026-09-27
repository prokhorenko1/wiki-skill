import { describe, expect, it } from 'vitest';
import { dates } from '../src/calendar.js';
import { calculate } from '../src/calculations.js';
import { recoverComparisons, type RecoveryRow } from '../src/recovery.js';
import { validateApiMonth, type Series } from '../src/series.js';
import { requestUrl } from '../src/requests.js';

const period = { start: '2021-01-01', end: '2022-12-31' };
const filters = { access: 'all-access', agent: 'user' } as const;
function sample(id = 'uk', gaps: string[] = [], projectGaps: string[] = [], p = period): RecoveryRow {
  const topic = dates(p).map(date => ({ date, views: gaps.includes(date) ? null : date.slice(0, 4) === p.start.slice(0, 4) ? 100 : 200 }));
  const project = dates(p).map(date => ({ date, views: projectGaps.includes(date) ? null : date.slice(0, 4) === p.start.slice(0, 4) ? 100000 : 250000 }));
  const articles: Series[] = [{ id, kind: 'article', language: id, title: 'Łódź / Україна', period: p, points: topic, warnings: [] }];
  return { id, topic, project, articles, projectSeries: { id: `project-${id}`, kind: 'project', language: id, period: p, points: project, warnings: [] } };
}
function monthly(row: RecoveryRow) {
  for (const series of [...row.articles, row.projectSeries!]) {
    series.apiMonthly = calculate(series.points, series.points, period).monthly.map(m => {
      const perDay = series.kind === 'article' ? m.month < '2022' ? 100 : 200 : m.month < '2022' ? 100000 : 250000;
      return { month: m.month, views: m.expectedDays * perDay, status: 'usable', observedDailySum: m.receivedTopicDays * perDay, expectedDays: m.expectedDays, receivedDays: m.receivedTopicDays, dailyComplete: m.receivedTopicDays === m.expectedDays, warnings: [] };
    });
  }
}
describe('Резервні методи без заповнення денних прогалин', () => {
  it('два пропуски з 730: місячні дані дають 36500 → 73000, +100%, частка −20%', () => {
    const row = sample('uk', ['2022-07-13', '2022-12-05']), before = structuredClone(row.topic); monthly(row);
    const r = recoverComparisons([row], period).get('uk')!;
    expect(r.yearOverYear.method).toBe('api_monthly');
    expect(r.yearOverYear.previous.value).toBe(36500); expect(r.yearOverYear.current.value).toBe(73000);
    expect(r.yearOverYear.changePercent.value).toBe(100); expect(r.yearOverYear.relativeChangePercent.value).toBeCloseTo(-20, 10);
    expect(r.yearOverYear.warnings).toContain('DAILY_COMPLETENESS_UNPROVEN');
    expect(r.periodSummary).toMatchObject({ method: 'api_monthly', totalViews: { value: 109500 }, dailyAverage: { value: 150 } });
    expect(row.topic).toEqual(before); expect(calculate(row.topic, row.project, period).totalViews.value).toBeNull();
  });
  it('спільна симетрична маска всіх мов, статей та знаменників', () => {
    const a = sample('pl', ['2022-07-13', '2022-12-05']), b = sample('cs', [], ['2021-08-03']);
    const result = recoverComparisons([a, b], period);
    for (const row of result.values()) {
      expect(row.yearOverYear.method).toBe('matched_calendar_change');
      expect(row.yearOverYear.pairedDays).toBe(362); expect(row.yearOverYear.previous.value).toBe(36200); expect(row.yearOverYear.current.value).toBe(72400);
      expect(row.yearOverYear.changePercent.value).toBe(100); expect(row.yearOverYear.relativeChangePercent.value).toBeCloseTo(-20, 10);
      expect(row.yearOverYear.excludedDates).toEqual(['2021-07-13', '2021-08-03', '2021-12-05', '2022-07-13', '2022-08-03', '2022-12-05']);
    }
  });
  it('29 лютого виключається окремо, а не зсувом на 365 днів', () => {
    const p = { start: '2023-01-01', end: '2024-12-31' }, row = sample('uk', ['2024-07-13'], [], p);
    const r = recoverComparisons([row], p).get('uk')!.yearOverYear;
    expect(r.pairedDays).toBe(364); expect(r.possiblePairs).toBe(365);
    expect(r.excludedDates).toEqual(['2023-07-13', '2024-02-29', '2024-07-13']); expect(r.warnings).toContain('LEAP_DAY_EXCLUDED');
  });
  it('велика прогалина не стає повнорічним зростанням; недавнє вікно оцінюється окремо', () => {
    const row = sample('uk', dates({ start: '2022-01-01', end: '2022-03-01' }));
    const r = recoverComparisons([row], period).get('uk')!;
    expect(r.yearOverYear.method).toBe('unavailable'); expect(r.yearOverYear.changePercent.value).toBeNull();
    expect(r.lastThreeMonths.method).toBe('daily'); expect(r.lastThreeMonths.changePercent.value).toBe(100);
  });
  it('навіть 95% загалом недостатньо при прогалині >20% одного місяця', () => {
    const row = sample('uk', dates({ start: '2022-02-01', end: '2022-02-07' }));
    expect(recoverComparisons([row], period).get('uk')!.yearOverYear.method).toBe('unavailable');
  });
  it('місячний запис, рівний неповній денній сумі, не доводить нульові пропуски', () => {
    const p = { start: '2022-02-01', end: '2022-02-28' }, points = dates(p).map(date => ({ date, views: date.endsWith('13') ? null : 100 }));
    const req = { kind: 'article', language: 'uk', title: 'Łódź / Україна', filters, period: p, granularity: 'monthly' } as const;
    const item = { project: 'uk.wikipedia', article: 'Łódź_/_Україна', ...filters, granularity: 'monthly', timestamp: '2022020100', views: 2700 };
    const equal = validateApiMonth({ items: [item] }, req, points);
    expect(equal).toMatchObject({ status: 'usable', dailyComplete: false, receivedDays: 27 });
    expect(equal.warnings.map(w => w.code)).toContain('MONTHLY_NOT_INDEPENDENT');
    expect(validateApiMonth({ items: [{ ...item, views: 2600 }] }, req, points).status).toBe('discrepant');
    expect(() => validateApiMonth({ items: [item, item] }, req, points)).toThrow();
    expect(() => validateApiMonth({ items: [{ ...item, timestamp: '2022030100' }] }, req, points)).toThrow();
    expect(requestUrl(req)).toContain('Ł'.split('').map(c => encodeURIComponent(c)).join(''));
    expect(requestUrl(req)).toContain('%2F'); expect(requestUrl(req)).toContain('/monthly/');
  });
  it('розбіжності місячних сум залишаються у результаті matched-calendar', () => {
    const row = sample('uk', ['2022-07-13']); monthly(row);
    row.articles[0]!.apiMonthly![0]!.status = 'discrepant';
    const r = recoverComparisons([row], period).get('uk')!.yearOverYear;
    expect(r.method).toBe('matched_calendar_change'); expect(r.warnings).toContain('MONTHLY_DAILY_DISCREPANCY');
  });
});
