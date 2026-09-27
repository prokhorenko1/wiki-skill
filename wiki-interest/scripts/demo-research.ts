import { executeOperation } from '../src/operations/index.js';
import { createServices } from '../src/research.js';
import { FixtureTransport } from '../src/fixtures.js';

// Явно синтетичний сценарій: неповне мовне покриття та два відсутні дні.
const fixture = new FixtureTransport();
const services = createServices({ clock: { now: () => new Date('2023-01-15T00:00:00Z') }, fixtureTransport: { get: async request => {
  const result = await fixture.get(request);
  if (request.kind === 'article' && !request.granularity) {
    const raw = JSON.parse(result.body) as { items: { timestamp: string }[] };
    raw.items = raw.items.filter(row => !['2022071300', '2022120500'].includes(row.timestamp)); result.body = JSON.stringify(raw);
  }
  return result;
} } });
const output = await executeOperation('research', {
  analysis: { mode: 'article', topics: [{ topicId: 'demo-physics', label: 'Фізика — синтетична перевірка завершення', concepts: [{ qid: 'Q413' }] }], languages: ['pl', 'cs'], queryLanguage: 'uk', period: { start: '2021-01-01', end: '2022-12-31' }, source: 'fixtures', fixtureId: 'demo-v1', cachePolicy: 'refresh', criterion: 'yearOverYear' },
  supplementalPriority: ['uk'], report: { locale: 'uk' },
}, services);
process.stdout.write(`${JSON.stringify(output)}\n`);
if (output.status === 'error' || output.summary.executionStatus === 'blocked') process.exitCode = 1;
