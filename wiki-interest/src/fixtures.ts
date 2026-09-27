import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { dates, monthBlocks } from './calendar.js';
import { AppError } from './errors.js';
import { periodSchema, qidSchema } from './schemas.js';
import { requestUrl, projectName, type ApiRequest } from './requests.js';
import type { Transport } from './http.js';

const fixtureSchema = z.object({
  origin: z.literal('fixtures'), notice: z.string(), period: periodSchema,
  languages: z.record(z.string(), z.string()), projectDaily: z.record(z.string(), z.number().int().nonnegative()),
  entities: z.array(z.object({ qid: qidSchema, label: z.string(), description: z.string(), aliases: z.array(z.string()), articles: z.record(z.string(), z.string()), daily: z.record(z.string(), z.number().int().nonnegative()) })),
});

export class FixtureTransport implements Transport {
  private readonly data = readFile(new URL('../tests/fixtures/demo-v1.json', import.meta.url), 'utf8').then(text => fixtureSchema.parse(JSON.parse(text)));
  async get(request: ApiRequest): Promise<{ body: string; url: string }> {
    const fixture = await this.data;
    let result: unknown;
    if (request.kind === 'search') {
      const query = request.query.toLocaleLowerCase('uk');
      result = { success: 1, search: fixture.entities.filter(e => [e.label, ...e.aliases].some(v => v.toLocaleLowerCase('uk').includes(query))).slice(0, 5).map(e => ({ id: e.qid, label: e.label, description: e.description })) };
    } else if (request.kind === 'entity') {
      const entity = fixture.entities.find(e => e.qid === (request.qid === 'Q999999' ? 'Q333' : request.qid));
      result = { success: 1, entities: { [request.qid]: entity ? { id: entity.qid, type: 'item', lastrevid: 1, labels: { [request.language]: { language: request.language, value: entity.label } }, descriptions: { [request.language]: { language: request.language, value: entity.description } }, aliases: { [request.language]: entity.aliases.map(value => ({ language: request.language, value })) }, sitelinks: Object.fromEntries(Object.entries(entity.articles).map(([language, title]) => [fixture.languages[language], { site: fixture.languages[language], title }])) } : { id: request.qid, missing: true } } };
    } else if (request.kind === 'site') {
      const wikiid = fixture.languages[request.language];
      if (!wikiid) throw new AppError('FIXTURE_MISS', 'Fixture не містить цієї мови.', { language: request.language });
      result = { query: { general: { wikiid, lang: request.language, server: `https://${projectName(request.language)}` } } };
    } else if (request.kind === 'sections') {
      result = { parse: { sections: [{ line: 'Тестовий розділ', anchor: 'Тестовий_розділ' }] } };
    } else if (request.kind === 'langlinks') {
      result = { query: { pages: [{ langlinks: Object.entries(fixture.languages).map(([lang]) => ({ lang, title: request.title, url: `https://${projectName(lang)}/wiki/${encodeURIComponent(request.title)}` })) }] } };
    } else if (request.kind === 'page') {
      const index = fixture.entities.findIndex(e => e.articles[request.language] === request.title);
      result = { query: { pages: [index < 0 ? { ns: 0, title: request.title, missing: true } : { ns: 0, title: request.title, pageid: index + 100, pageprops: { wikibase_item: fixture.entities[index]!.qid }, revisions: [{ timestamp: '2010-01-01T00:00:00Z' }] }] } };
      if (request.details && index >= 0) result = { query: { pages: [{ ns: 0, title: request.title, pageid: index + 100, fullurl: `https://${projectName(request.language)}/wiki/${encodeURIComponent(request.title.replaceAll(' ', '_'))}`, pageprops: { wikibase_item: fixture.entities[index]!.qid }, revisions: [{ revid: 1, slots: { main: { content: `Синтетичний вступ: ${fixture.entities[index]!.description}.\n== Тестовий розділ ==\nСинтетичний зміст, не жива Wikipedia.` } } }] }] } };
    } else if (request.kind === 'wiki-search' || request.kind === 'links' || request.kind === 'category') {
      const matched = fixture.entities.filter(e => request.kind !== 'wiki-search' || [e.label, ...e.aliases].some(s => s.toLowerCase().includes(request.query.toLowerCase())));
      const offset = Number(request.continuation?.sroffset ?? request.continuation?.cmcontinue ?? request.continuation?.plcontinue ?? 0);
      const pages = matched.slice(offset, offset + 3).filter(e => e.articles[request.language]).map(e => ({ ns: 0, title: e.articles[request.language], pageid: fixture.entities.indexOf(e) + 100 }));
      const key = request.kind === 'wiki-search' ? 'sroffset' : request.kind === 'category' ? 'cmcontinue' : 'plcontinue';
      result = { ...(offset + 3 < matched.length ? { continue: { continue: '-||', [key]: String(offset + 3) } } : {}), query: request.kind === 'wiki-search' ? { search: pages } : request.kind === 'category' ? { categorymembers: pages } : { pages: [{ links: pages }] } };
    } else {
      if (!fixture.languages[request.language] || request.period.start < fixture.period.start || request.period.end > fixture.period.end) throw new AppError('FIXTURE_MISS', 'Fixture не покриває запитаний період або мову.', { requested: request.period, available: fixture.period });
      const entity = request.kind === 'article' ? fixture.entities.find(e => e.articles[request.language] === request.title) : undefined;
      if (request.kind === 'article' && !entity) throw new AppError('FIXTURE_MISS', 'Fixture не містить статті.');
      result = { items: dates(request.period).map(date => ({ project: `${request.language}.wikipedia`, access: request.filters.access, agent: request.filters.agent, granularity: 'daily', timestamp: `${date.replaceAll('-', '')}00`, views: (entity?.daily ?? fixture.projectDaily)[date.slice(0, 4)], ...(request.kind === 'article' ? { article: request.title.replaceAll(' ', '_') } : {}) })) };
      if (request.granularity === 'monthly') result = { items: monthBlocks(request.period).map(block => ({ project: `${request.language}.wikipedia`, access: request.filters.access, agent: request.filters.agent, granularity: 'monthly', timestamp: `${block.start.replaceAll('-', '')}00`, views: dates(block).reduce((n, day) => n + (entity?.daily ?? fixture.projectDaily)[day.slice(0, 4)]!, 0), ...(request.kind === 'article' ? { article: request.title.replaceAll(' ', '_') } : {}) })) };
    }
    return { body: JSON.stringify(result), url: requestUrl(request) };
  }
}
