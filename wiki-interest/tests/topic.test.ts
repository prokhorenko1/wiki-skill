import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { dates } from '../src/calendar.js';
import { buildTopicStudy } from '../src/topic-analysis.js';
import { topicPlanSchema, discoverSchema } from '../src/topic-plan.js';
import { buildCoverage, type Candidate } from '../src/resolver.js';
import type { Dataset, Manifest } from '../src/models.js';
import type { DailyPoint } from '../src/series.js';

const period = { start: '2021-01-01', end: '2022-12-31' };
const points = (before: number, after: number): DailyPoint[] => dates(period).map(date => ({ date, views: date < '2022-01-01' ? before : after }));
interface Component { qid: string; before: number; after: number; role?: 'root' | 'core' | 'extended'; subtopic?: string; pageId?: number; missingLanguage?: string; createdAt?: string; edit?: (p: DailyPoint[]) => DailyPoint[] }
function sample(components: Component[], languages = ['uk'], projectAfter = 100000) {
  const candidates: Candidate[] = components.map((c, i) => ({ qid: c.qid, requestedQid: c.qid, label: `Назва ${c.qid}`, labelLanguage: 'uk', description: 'synthetic', warnings: [], articles: languages.map(language => ({ language, project: `${language}.wikipedia.org`, siteId: `${language}wiki`, title: `Сторінка ${c.pageId ?? i}`, originalTitle: `Сторінка ${c.pageId ?? i}`, pageId: c.pageId ?? i + 100, status: language === c.missingLanguage ? 'missing_sitelink' as const : 'found' as const, normalized: [], redirects: [], createdAt: c.createdAt })) }));
  const topic = { topicId: 'sample', label: 'Вибірка', concepts: components.map(c => ({ qid: c.qid })) };
  const topics: Manifest['topics'] = [{ topic, candidates, coverage: buildCoverage(topic, candidates, languages) }];
  const dataset: Dataset = { schemaVersion: '1.0.0', period, topics: [], series: languages.flatMap(language => [
    { id: `project-${language}`, kind: 'project' as const, language, period, warnings: [], points: points(100000, projectAfter) },
    ...components.filter(c => c.missingLanguage !== language).map(c => ({ id: `${c.qid}-${language}`, kind: 'article' as const, language, period, title: candidates.find(x => x.qid === c.qid)!.articles.find(a => a.language === language)!.title!, warnings: [], points: c.edit ? c.edit(points(c.before, c.after)) : points(c.before, c.after) })),
  ]) };
  const plan = topicPlanSchema.parse({ schemaVersion: '3.0.0', methodologyVersion: '3.0.0', planId: randomUUID(), compositionVersion: 'fixture-v1', frozenAt: '2023-01-01T00:00:00Z', basketId: 'sample', label: 'Вибірка', question: 'Навчальна гіпотеза?', productContext: 'course', boundaries: 'synthetic', subtopics: ['a', 'b'].map(id => ({ id, label: id, rationale: id })), languages, queryLanguage: 'uk', period, filters: { access: 'all-access', agent: 'user' },
    members: components.map(c => ({ candidateId: c.qid, qid: c.qid, role: c.role ?? 'core', subtopic: c.subtopic ?? 'a', reason: 'Content selection' })), decisions: [], assumptions: ['synthetic'], limitations: ['synthetic'], comparisonRules: ['fixed'], discovery: { schemaVersion: '3.0.0', discoveryId: randomUUID(), createdAt: '2023-01-01T00:00:00Z', request: discoverSchema.parse({ query: 'synthetic', languages, source: 'fixtures', fixtureId: 'demo-v1' }), candidates: [], snapshots: [], discoveryTruncated: false, truncationReasons: [], logicalRequests: 0, metadataBasis: 'current_metadata_not_historical_membership' } });
  return { plan, topics, dataset, result: () => buildTopicStudy(plan, topics, dataset).study };
}
describe('Тематична методологія з незалежними очікуваннями', () => {
  it('коренева стаття падає, набір зростає; суми й знаменник незалежні', () => {
    const s = sample([{ qid: 'Q1', role: 'root', before: 200, after: 100 }, { qid: 'Q2', before: 100, after: 200 }, { qid: 'Q3', before: 100, after: 200 }], ['uk'], 250000).result();
    expect(s.languages[0]!.comparisons).toMatchObject({ root: -50, core: 100 });
    expect(s.languages[0]!.comparisons.normalized).toBeCloseTo(-20);
    const core = s.rows.find(r => r.role === 'core')!;
    expect(core.metrics.totalViews.value).toBe(219000);
    expect(core.metrics.yearOverYear.previous.value).toBe(73000);
    expect(core.metrics.yearOverYear.current.value).toBe(146000);
    expect(core.metrics.yearOverYear.currentPerMillion.value).toBe(1600);
    expect(s.languages[0]!.conclusion).toContain('кореневої статті');
  });
  it('коренева стаття зростає, весь набір стабільно падає', () => {
    const s = sample([{ qid: 'Q1', role: 'root', before: 50, after: 100 }, { qid: 'Q2', before: 100, after: 50 }, { qid: 'Q3', before: 100, after: 50, subtopic: 'b' }]).result().languages[0]!;
    expect(s.comparisons).toMatchObject({ root: 100, core: -50 });
    expect(s.counts).toEqual({ growing: 0, declining: 2, unchanged: 0, unusable: 0 });
    expect(s.sensitivity.directionDependsOnConcept).toBe(false);
    expect(s.sensitivity.pairedMonths.every(m => m.annual === -50)).toBe(true);
    expect(s.conclusion).toContain('узгоджене зниження');
  });
  it('одна стаття визначає напрям; внески складаються до 25 в.п.', () => {
    const s = sample([{ qid: 'Q2', before: 100, after: 200 }, { qid: 'Q3', before: 100, after: 50, subtopic: 'b' }]).result().languages[0]!;
    expect(s.comparisons.core).toBe(25); expect(s.contributions.map(c => c.percentagePoints)).toEqual([50, -25]); expect(s.contributionSum).toBe(25);
    expect(s.sensitivity.leaveOneOut.map(c => c.annual)).toEqual([-50, 100]);
    expect(s.sensitivity.leaveOneOut[0]!.differencePoints).toBe(-75);
    expect(s.conclusion).toContain('залежить від однієї статті');
  });
  it('різноспрямовані підтематики не приховуються під сумою', () => {
    const s = sample([{ qid: 'Q2', before: 100, after: 120, subtopic: 'a' }, { qid: 'Q3', before: 100, after: 80, subtopic: 'b' }, { qid: 'Q4', before: 100, after: 100 }]).result();
    expect(s.languages[0]!.counts).toEqual({ growing: 1, declining: 1, unchanged: 1, unusable: 0 });
    expect(s.languages[0]!.medianChange).toBe(0);
    expect(s.rows.filter(r => r.role === 'subtopic').map(r => r.metrics.yearOverYear.current.value)).toEqual([80300, 29200]);
    expect(s.languages[0]!.quality.flags).toContain('MIXED_COMPONENTS');
  });
  it('синоніми, спільна сторінка та повтор у підтемах не збільшують суму', () => {
    const s = sample([{ qid: 'Q2', before: 100, after: 200, pageId: 8, subtopic: 'a' }, { qid: 'Q3', before: 100, after: 200, pageId: 8, subtopic: 'b' }]).result();
    expect(s.languages[0]!.coreQids).toEqual(['Q2']);
    expect(s.rows.find(r => r.role === 'core')!.metrics.totalViews.value).toBe(109500);
    expect(s.coverage.find(c => c.qid === 'Q3')!.duplicateOf).toBe('Q2');
    expect(s.rows.find(r => r.id === 'sample-b:uk')!.metrics.totalViews.value).toBeNull();
  });
  it('різне міжмовне покриття використовує спільний незмінний склад', () => {
    const s = sample([{ qid: 'Q2', before: 100, after: 200 }, { qid: 'Q3', before: 100, after: 50, missingLanguage: 'pl' }], ['uk', 'pl']).result();
    expect(s.languages.map(l => l.coreQids)).toEqual([['Q2'], ['Q2']]);
    expect(s.languages.map(l => l.coveragePercent)).toEqual([50, 50]);
    expect(s.languages[0]!.extendedQids).toEqual(['Q2', 'Q3']);
    expect(s.languages[0]!.conclusion).toContain('недостатньо');
  });
  it('нові статті й неоднозначні пропуски не створюють штучного зростання', () => {
    for (const c of [{ createdAt: '2022-01-01T00:00:00Z' }, { edit: (p: DailyPoint[]) => p.map(v => v.date < '2022-01-01' ? { ...v, views: null } : v) }]) {
      const s = sample([{ qid: 'Q2', before: 100, after: 100 }, { qid: 'Q3', before: 0, after: 1000, ...c }]).result();
      expect(s.languages[0]!.coreQids).toEqual(['Q2']); expect(s.languages[0]!.comparisons.core).toBe(0);
      expect(s.coverage.find(c => c.qid === 'Q3')!.dataUsable).toBe(false);
    }
  });
  it('явна нульова база залишається null для зміни; абсолютний внесок визначений', () => {
    const s = sample([{ qid: 'Q2', before: 100, after: 100 }, { qid: 'Q3', before: 0, after: 100 }]).result().languages[0]!;
    expect(s.contributions[1]!.annual).toBeNull(); expect(s.contributions[1]!.percentagePoints).toBe(100);
    expect(s.counts.unusable).toBe(1); expect(s.contributionSum).toBe(100); expect(s.quality.flags).toContain('LOW_COMPONENT_BASE');
  });
  it('повторні сезонні піки не змінюють знак; концентрація сама не доводить крихкість', () => {
    const edit = (p: DailyPoint[]) => p.map(v => ({ ...v, views: v.date.slice(5, 7) === '09' ? 2000 : 100 }));
    const s = sample([{ qid: 'Q2', before: 100, after: 100, edit }, { qid: 'Q3', before: 100, after: 100, edit }]).result().languages[0]!;
    expect(s.comparisons.core).toBe(0); expect(s.sensitivity.pairedMonths.every(s => s.annual === 0)).toBe(true);
    expect(s.quality.flags).toContain('MONTH_CONCENTRATION_REVIEW'); expect(s.quality.stability).toBe('stable');
  });
  it('оцінює залежність від місяця симетрично; не змінює основні дані', () => {
    const edit = (p: DailyPoint[]) => p.map(v => ({ ...v, views: v.date.startsWith('2022-09') ? 5000 : 100 }));
    const f = sample([{ qid: 'Q2', before: 100, after: 100, edit }, { qid: 'Q3', before: 100, after: 100 }]), before = structuredClone(f.dataset);
    const s = f.result().languages[0]!, scenario = s.sensitivity.pairedMonths.find(s => s.excluded[0] === '09')!;
    expect(s.comparisons.core).toBeCloseTo(201.36986301369862); expect(scenario.annual).toBe(0); expect(scenario.differencePoints).toBeCloseTo(-201.36986301369862);
    expect(s.sensitivity.directionDependsOnMonth).toBe(true); expect(f.dataset).toEqual(before);
  });
});
