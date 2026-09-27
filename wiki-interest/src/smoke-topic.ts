import { randomUUID } from 'node:crypto';
import { AppError, asError } from './errors.js';
import { checkEnvironment } from './environment.js';
import { HttpClient, type Transport } from './http.js';
import { executeOperation } from './operations/index.js';
import { readRun, type Services } from './research.js';
import { discoverySchema } from './topic-plan.js';
import { analysisSchema } from './analysis.js';
import { getPeriod } from './calendar.js';
import { canonical } from './storage.js';

// Content-defined smoke scope; these titles must be verified by live APIs before any metric is loaded.
export const chemistryScope = [
  ['Хімія', 'root'], ['Органічна хімія', 'branches'], ['Неорганічна хімія', 'branches'], ['Фізична хімія', 'branches'], ['Аналітична хімія', 'branches'],
  ['Хімічна реакція', 'reactions'], ["Хімічний зв'язок", 'bonding'], ["Ковалентний зв'язок", 'bonding'], ["Іонний зв'язок", 'bonding'],
  ['Періодична система хімічних елементів', 'structure'], ['Атом', 'structure'], ['Молекула', 'structure'], ['Хімічний елемент', 'structure'],
] as const;
export async function runTopicSmoke(services: Services) {
  const smokeId = randomUUID(), details: Record<string, unknown> = { smokeId, type: 'chemistry-topic', source: 'wikimedia', startedAt: services.clock.now().toISOString(), modelCalls: 0 };
  let status = 'blocked', logicalRequests = 0;
  try {
    const environment = await checkEnvironment();
    details.environment = environment;
    if (!environment.liveReady) { const failed = environment.checks.filter(c => c.status === 'blocked'); throw new AppError(failed[0]?.code ?? 'ENVIRONMENT_BLOCKED', 'Doctor не підтвердив готовність живого сценарію; fixtures не використовуються.', { checks: failed }); }
    const transport = services.transport ?? new HttpClient({ log: services.log });
    const counted: Transport = { get: async request => { if (++logicalRequests > 850) throw new AppError('SMOKE_REQUEST_BUDGET', 'Перевищено бюджет 850 логічних запитів (до 3 HTTP-спроб).'); return transport.get(request); } };
    const active = { ...services, transport: counted };
    const call = async (op: string, input: unknown, runId?: string) => { const r = await executeOperation(op, input, active, runId); if (r.error) throw new AppError(r.error.code, r.error.message, r.error.details); return r; };
    const discovered = await call('discover', { query: 'Хімія', queryLanguage: 'uk', languages: ['uk'], seedQids: ['Q2329'], pageTitles: chemistryScope.map(([title]) => title), linkTitles: ['Хімія'], categoryTitles: ['Категорія:Хімія'], limits: { candidates: 40, requests: 200, depth: 0 } });
    const discovery = await services.store.read(['discoveries', `${discovered.identifiers.discoveryId}.json`], discoverySchema);
    details.discovery = { id: discovery.discoveryId, truncated: discovery.discoveryTruncated, sources: discovery.snapshots };
    const selected = chemistryScope.map(([title, subtopic]) => {
      const c = discovery.candidates.find(c => c.sources.some(s => s.kind === 'seed' && s.value === title) && c.verified && c.articles.some(a => a.language === 'uk' && a.status === 'found'));
      if (!c || title === 'Хімія' && c.qid !== 'Q2329') throw new AppError('SMOKE_SELECTION_CHANGED', 'Не підтверджено заплановану концепцію; потрібна змістова перевірка.', { title });
      return { candidateId: c.candidateId, status: 'selected', role: subtopic === 'root' ? 'root' : 'core', ...(subtopic === 'root' ? {} : { subtopic }), reason: `Заздалегідь заданий навчальний scope: ${title}; існування концепції й статті перевірено до переглядів.` };
    });
    const plan = await call('plan', { discoveryId: discovery.discoveryId, basketId: 'chemistry-course', label: 'Хімія: базовий навчальний курс', question: 'Як відрізняються перегляди загальної статті «Хімія» та вибраних навчальних підтем?', productContext: 'Гіпотеза базового курсу; шкільний вступний контекст припущено.', boundaries: 'Основні розділи, зв’язки, реакції та будова речовини. Без масового додавання речовин, біографій і компаній.',
      subtopics: [{ id: 'branches', label: 'Основні розділи хімії', rationale: 'Навчальні напрями.' }, { id: 'reactions', label: 'Хімічні реакції', rationale: 'Базові перетворення.' }, { id: 'bonding', label: 'Хімічні зв’язки', rationale: 'Типи зв’язків.' }, { id: 'structure', label: 'Будова речовини та періодична система', rationale: 'Базові поняття.' }], decisions: selected,
      period: getPeriod(undefined, services.clock), assumptions: ['Базовий навчальний контекст; склад визначено до аналізу динаміки.'], limitations: ['Цільова вибірка з поточних метаданих не репрезентує всю хімію.', 'Перегляди не доводять готовності платити за курс.'] });
    details.topicPlanId = plan.identifiers.topicPlanId;
    const result = await call('analyze', { mode: 'topic', topicPlanId: plan.identifiers.topicPlanId, languages: ['uk'], criterion: 'yearOverYear' });
    const runId = result.identifiers.runId!; details.runId = runId;
    const saved = await readRun(runId, services), analysis = await services.store.read(['runs', runId, 'analysis.json'], analysisSchema);
    details.summary = result.summary; details.quality = analysis.topicStudy?.languages; details.sources = saved.manifest.snapshots;
    if (saved.manifest.source !== 'wikimedia' || saved.manifest.snapshots.some(s => s.origin !== 'wikimedia')) throw new AppError('SMOKE_SOURCE_MISMATCH', 'Джерело не Wikimedia.');
    const report = await call('report', {}, runId); details.report = { identifiers: report.identifiers, artifacts: report.artifacts, verification: report.summary.verification };
    const requestsBefore = logicalRequests;
    const revised = await call('revise', { changes: { criterion: 'views' } }, runId);
    const child = await readRun(revised.identifiers.runId!, services);
    if (logicalRequests !== requestsBefore || canonical(child.dataset) !== canonical(saved.dataset)) throw new AppError('SMOKE_REUSE_FAILED', 'Зміна критерію не використала власні дані.');
    details.reuse = { fetched: child.manifest.dataAccess.fetched, attemptedNetworkRequests: logicalRequests - requestsBefore, datasetUnchanged: true };
    status = analysis.topicStudy!.languages.some(l => l.quality.completeness === 'incomplete') ? 'blocked' : 'passed';
    if (status === 'blocked') details.error = { code: 'SMOKE_INCOMPLETE_DATA', message: 'PDF показує обмеження; повне покриття live-плану не підтверджене.' };
  } catch (error) { const e = asError(error); details.error = { code: e.code, message: e.message, details: e.details }; status = /^(USER_AGENT|ENVIRONMENT|NETWORK|HTTP|RATE_LIMITED|BROWSER|SMOKE_SELECTION_CHANGED)/.test(e.code) ? 'blocked' : 'failed'; }
  Object.assign(details, { status, logicalRequests, finishedAt: services.clock.now().toISOString() });
  const artifact = await services.store.write(['smoke', smokeId, 'smoke.json'], details);
  return { status, smokeId, runId: details.runId ?? null, error: details.error ?? null, report: details.report ?? null, logicalRequests, artifact };
}
