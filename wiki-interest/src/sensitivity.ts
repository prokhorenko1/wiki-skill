import { z } from 'zod';
import { comparisonWindows } from './calendar.js';
import { perMillion, relativeChange, sum, type Calculation } from './calculations.js';
import { direction } from './diagnostics.js';
import type { Period } from './schemas.js';

export const scenarioSchema = z.object({ id: z.string(), excluded: z.array(z.string()), annual: z.number().nullable(), normalized: z.number().nullable(), differencePoints: z.number().nullable(), normalizedDifferencePoints: z.number().nullable(), directionChanged: z.boolean().nullable() });
export type Scenario = z.infer<typeof scenarioSchema>;
export function scenarioResult(id: string, excluded: string[], annual: number | null, normalized: number | null, base: Calculation): Scenario {
  const previous = base.yearOverYear.changePercent.value, relative = base.yearOverYear.relativeChangePercent.value;
  return { id, excluded, annual, normalized, differencePoints: annual !== null && previous !== null ? annual - previous : null,
    normalizedDifferencePoints: normalized !== null && relative !== null ? normalized - relative : null,
    directionChanged: annual !== null && previous !== null ? direction(annual) !== direction(previous) : null };
}
// Every calendar month is tested symmetrically. Neither the maximum nor the desired sign selects the scenario.
export function pairedMonthSensitivity(metrics: Calculation, project: Calculation, period: Period): Scenario[] {
  const windows = comparisonWindows(period, 12);
  if (!windows) return [];
  return Array.from({ length: 12 }, (_, index) => {
    const month = String(index + 1).padStart(2, '0');
    const selected = (source: Calculation, start: string, end: string) => source.monthly.filter(m => m.period.start >= start && m.period.end <= end && m.month.slice(5) !== month && m.fullMonth);
    const currentRows = selected(metrics, windows.current.start, windows.current.end), previousRows = selected(metrics, windows.previous.start, windows.previous.end);
    const current = sum(currentRows.map(m => m.views.value)), previous = sum(previousRows.map(m => m.views.value));
    const currentProject = sum(selected(project, windows.current.start, windows.current.end).map(m => m.views.value));
    const previousProject = sum(selected(project, windows.previous.start, windows.previous.end).map(m => m.views.value));
    const available = currentRows.length === 11 && previousRows.length === 11;
    return scenarioResult(`paired-month-${month}`, [month], available ? relativeChange(current, previous).value : null,
      available ? relativeChange(perMillion(current, currentProject), perMillion(previous, previousProject)).value : null, metrics);
  });
}
