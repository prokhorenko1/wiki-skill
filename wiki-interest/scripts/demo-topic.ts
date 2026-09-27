import { executeOperation } from '../src/operations/index.js';
import { createServices } from '../src/research.js';
import type { Output } from '../src/schemas.js';

const services = createServices({ clock: { now: () => new Date('2023-01-15T12:00:00Z') } });
const call = async (operation: string, input: unknown, runId?: string): Promise<Output> => {
  const output = await executeOperation(operation, input, services, runId);
  if (output.error) throw new Error(JSON.stringify(output));
  return output;
};
const discovery = await call('discover', { query: 'демо-хімія', seedQids: ['Q2329', 'Q91000001', 'Q91000002', 'Q91000003', 'Q91000004'], queryLanguage: 'uk', languages: ['uk'], source: 'fixtures', fixtureId: 'demo-v1' });
const plan = await call('plan', { discoveryId: discovery.identifiers.discoveryId, basketId: 'chemistry-demo', label: 'Хімія: навчальні підтематики',
  question: 'Чи підтримує вибрана тематична вибірка гіпотезу про курс із хімії?', productContext: 'Базовий навчальний курс; демонстрація різноспрямованих сигналів.', boundaries: 'Два розділи хімії та два базові поняття. Речовини, біографії й компанії не включено.',
  subtopics: [{ id: 'organic', label: 'Органічна хімія', rationale: 'Окремий розділ курсу.' }, { id: 'inorganic', label: 'Неорганічна хімія', rationale: 'Окремий розділ курсу.' }, { id: 'foundations', label: 'Реакції та зв’язки', rationale: 'Базові навчальні поняття.' }],
  decisions: [ ['Q2329', 'root', undefined], ['Q91000001', 'core', 'organic'], ['Q91000002', 'core', 'inorganic'], ['Q91000003', 'core', 'foundations'], ['Q91000004', 'core', 'foundations'] ].map(([candidateId, role, subtopic]) => ({ candidateId, role, subtopic, status: 'selected', reason: role === 'root' ? 'Контрольна загальна стаття, поза сумою core.' : 'Частина оголошених навчальних меж; вибрана до аналізу.' })),
  period: { start: '2021-01-01', end: '2022-12-31' }, assumptions: ['Контекст — вступне навчання; склад демонстраційний, не репрезентативний.'], limitations: ['Усі числа, ID підтем і page ID цього демо синтетичні.', 'Чотири концепції не охоплюють усю хімію.'] });
const analyzed = await call('analyze', { mode: 'topic', topicPlanId: plan.identifiers.topicPlanId, languages: ['uk'], source: 'fixtures', fixtureId: 'demo-v1', criterion: 'yearOverYear' });
const report = await call('report', {}, analyzed.identifiers.runId);
console.log(JSON.stringify({ ...report, discoveryId: discovery.identifiers.discoveryId, topicPlanId: plan.identifiers.topicPlanId, topic: analyzed.summary.topic }));
