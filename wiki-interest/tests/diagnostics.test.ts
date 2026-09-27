import { describe, expect, it } from 'vitest';
import { calculate } from '../src/calculations.js';
import { dates } from '../src/calendar.js';
import { diagnose, DIAGNOSTIC_POLICY } from '../src/diagnostics.js';
import type { DailyPoint } from '../src/series.js';

const period = { start: '2021-01-01', end: '2022-12-31' };
const points = (before: number, after = before): DailyPoint[] => dates(period).map(date => ({ date, views: date < '2022-01-01' ? before : after }));
const coverage: { included: string[]; excluded: string[] } = { included: ['Q333'], excluded: [] };
function result(topic: DailyPoint[], project = points(100000), selected = coverage) {
  return diagnose(topic, project, period, calculate(topic, project, period, !selected.included.length), selected);
}
describe('Діагностична евристика 2.0.0', () => {
  it('один сплеск створює 100% зростання, але не стійкий висновок', () => {
    const original = points(100); original.find(p => p.date === '2022-06-15')!.views = 36600;
    const saved = structuredClone(original), diagnostic = result(original);
    expect(calculate(original, points(100000), period).yearOverYear.changePercent.value).toBe(100);
    expect(diagnostic.status).toBe('fragile'); expect(diagnostic.sensitivity.material).toBe(true);
    expect(diagnostic.sensitivity.unusualDays).toEqual([{ date: '2022-06-15', original: 36600, replacement: 400, localMedian: 100, localMad: 0 }]);
    expect(diagnostic.sensitivity.metrics!.yearOverYear.current.value).toBe(36800);
    expect(diagnostic.sensitivity.metrics!.yearOverYear.changePercent.value).toBeCloseTo(0.821917808219178);
    expect(diagnostic.reasons.map(r => r.code)).toContain('SPIKE_SENSITIVE'); expect(original).toEqual(saved);
  });
  it('регулярне подвоєння лишається стійким з малим одиничним сплеском', () => {
    const topic = points(100, 200); topic.find(p => p.date === '2022-06-15')!.views = 1000;
    const diagnostic = result(topic);
    expect(diagnostic.sensitivity.unusualDays).toHaveLength(1);
    expect(diagnostic.sensitivity.metrics!.yearOverYear.changePercent.value).toBeCloseTo(101.64383561643837);
    expect(diagnostic.sensitivity.material).toBe(false);
    expect(diagnostic.reasons.map(r => r.code)).not.toContain('SPIKE_SENSITIVE');
    expect(result(points(100, 200)).status).toBe('stable');
  });
  it('повторюваний сезонний малюнок не означає міжрічного зростання', () => {
    const topic = dates(period).map(date => ({ date, views: date.slice(5, 7) === '07' ? 200 : 100 }));
    const diagnostic = result(topic);
    expect(diagnostic.sensitivity.metrics!.yearOverYear.changePercent.value).toBe(0);
    expect(diagnostic.sensitivity.unusualDays).toHaveLength(0);
    expect(diagnostic.limitations).toContain('NO_PROVEN_SEASONALITY_OR_FORECAST');
  });
  it('частка зростає на 60% при падінні абсолютних переглядів на 20%', () => {
    const topic = points(100, 80), project = points(100000, 50000), metrics = calculate(topic, project, period), diagnostic = result(topic, project);
    expect(metrics.yearOverYear.changePercent.value).toBeCloseTo(-20);
    expect(metrics.yearOverYear.relativeChangePercent.value).toBeCloseTo(60);
    expect(diagnostic.status).toBe('mixed');
    expect(diagnostic.reasons.map(r => r.code)).toContain('ABSOLUTE_RELATIVE_DISAGREEMENT');
  });
  it('мала база позначається окремо від відсотка зростання', () => {
    const diagnostic = result(points(1, 2));
    expect(diagnostic.baselineViews).toBe(365); expect(diagnostic.status).toBe('fragile');
    expect(diagnostic.reasons.map(r => r.code)).toContain('LOW_BASELINE_VOLUME');
  });
  it('неоднакове покриття показує виключені концепції', () => {
    const diagnostic = result(points(100), points(100000), { included: ['Q333'], excluded: ['Q413'] });
    expect(diagnostic.status).toBe('mixed'); expect(diagnostic.coverage.excluded).toEqual(['Q413']);
    expect(diagnostic.reasons.map(r => r.code)).toContain('UNEQUAL_CONCEPT_COVERAGE');
  });
  it('постійний ряд має MAD=0 без штучних сплесків; нульовий і розріджений не називаються стійкими', () => {
    expect(result(points(100)).sensitivity.unusualDays).toEqual([]);
    const sparse = points(0); sparse[100]!.views = 500;
    for (const input of [points(0), sparse]) {
      const diagnostic = result(input);
      expect(diagnostic.status).toBe('insufficient'); expect(diagnostic.sensitivity.available).toBe(false);
      expect(diagnostic.sensitivity.metrics).toBeNull();
    }
  });
  it('прогалини не замінюються нулями та не дають повного висновку', () => {
    const topic = points(100); topic[5]!.views = null;
    const diagnostic = result(topic);
    expect(diagnostic.status).toBe('insufficient'); expect(diagnostic.completeness.topicDays).toBe(729);
    expect(diagnostic.sensitivity.points[5]!.views).toBeNull(); expect(diagnostic.concentration.maximumDayShare).toBeNull();
  });
  it('мало спостережень не запускає сценарій; пороги незмінні', () => {
    const topic = points(100).map((p, i) => ({ ...p, views: i < 89 ? p.views : null }));
    expect(result(topic).sensitivity.available).toBe(false);
    expect(DIAGNOSTIC_POLICY.minimumDays).toBe(90); expect(Object.isFrozen(DIAGNOSTIC_POLICY)).toBe(true);
  });
});
