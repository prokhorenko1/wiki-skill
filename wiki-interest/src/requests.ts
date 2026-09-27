import { z } from 'zod';
import { filtersSchema, languageSchema, periodSchema, qidSchema } from './schemas.js';
import { AppError } from './errors.js';

const titleSchema = z.string().min(1).max(512).refine(v => !/[\u0000-\u001f\u007f|]/u.test(v), 'Недопустимий заголовок.');
export const requestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('wiki-search'), language: languageSchema, query: z.string().min(1).max(300), continuation: z.record(z.string(), z.union([z.string(), z.number()])).optional() }),
  z.object({ kind: z.literal('links'), language: languageSchema, title: titleSchema, continuation: z.record(z.string(), z.union([z.string(), z.number()])).optional() }),
  z.object({ kind: z.literal('category'), language: languageSchema, title: titleSchema, continuation: z.record(z.string(), z.union([z.string(), z.number()])).optional() }),
  z.object({ kind: z.literal('search'), query: z.string().min(1).max(300), language: languageSchema, continuation: z.number().int().nonnegative().optional() }),
  z.object({ kind: z.literal('entity'), qid: qidSchema, language: languageSchema }),
  z.object({ kind: z.literal('site'), language: languageSchema }),
  z.object({ kind: z.literal('sections'), language: languageSchema, revisionId: z.number().int().positive() }),
  z.object({ kind: z.literal('page'), language: languageSchema, title: titleSchema, details: z.literal(true).optional() }),
  z.object({ kind: z.literal('langlinks'), language: languageSchema, title: titleSchema, continuation: z.record(z.string(), z.union([z.string(), z.number()])).optional() }),
  z.object({ kind: z.literal('article'), language: languageSchema, title: titleSchema, filters: filtersSchema, period: periodSchema, granularity: z.literal('monthly').optional() }),
  z.object({ kind: z.literal('project'), language: languageSchema, filters: filtersSchema, period: periodSchema, granularity: z.literal('monthly').optional() }),
]);
export type ApiRequest = z.infer<typeof requestSchema>;
export type SeriesRequest = Extract<ApiRequest, { kind: 'article' | 'project' }>;
export const projectName = (language: string): string => `${languageSchema.parse(language)}.wikipedia.org`;
const segment = (value: string): string => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

export function requestUrl(input: ApiRequest): string {
  const request = requestSchema.parse(input);
  if (request.kind === 'article' || request.kind === 'project') {
    const timestamp = (date: string) => `${date.replaceAll('-', '')}00`;
    const parts = [request.kind === 'article' ? 'per-article' : 'aggregate', projectName(request.language), request.filters.access, request.filters.agent];
    if (request.kind === 'article') parts.push(request.title.replaceAll(' ', '_'));
    parts.push(request.granularity ?? 'daily', timestamp(request.period.start), timestamp(request.period.end));
    return `https://wikimedia.org/api/rest_v1/metrics/pageviews/${parts.map(segment).join('/')}`;
  }
  const url = new URL(request.kind === 'search' || request.kind === 'entity' ? 'https://www.wikidata.org/w/api.php' : `https://${projectName(request.language)}/w/api.php`);
  const params: Record<string, string> = { format: 'json', formatversion: '2', maxlag: '5' };
  if (request.kind === 'search') Object.assign(params, { action: 'wbsearchentities', search: request.query, language: request.language, uselang: request.language, type: 'item', limit: '5', ...(request.continuation === undefined ? {} : { continue: String(request.continuation) }) });
  if (request.kind === 'entity') Object.assign(params, { action: 'wbgetentities', ids: request.qid, props: 'info|labels|descriptions|aliases|sitelinks|sitelinks/urls', languages: `${request.language}|en`, redirects: 'yes' });
  if (request.kind === 'site') Object.assign(params, { action: 'query', meta: 'siteinfo', siprop: 'general' });
  if (request.kind === 'sections') Object.assign(params, { action: 'parse', oldid: String(request.revisionId), prop: 'sections' });
  if (request.kind === 'page') Object.assign(params, { action: 'query', prop: 'info|pageprops|revisions', titles: request.title, redirects: '1', rvprop: 'timestamp', rvdir: 'newer', rvlimit: '1' });
  if (request.kind === 'page' && request.details) Object.assign(params, { inprop: 'url', ppprop: 'wikibase_item|disambiguation', rvprop: 'ids|timestamp|content', rvslots: 'main', rvdir: 'older' });
  if (request.kind === 'langlinks') Object.assign(params, { action: 'query', prop: 'langlinks', titles: request.title, redirects: '1', llprop: 'url', lllimit: '500' }, request.continuation);
  if (request.kind === 'wiki-search') Object.assign(params, { action: 'query', list: 'search', srsearch: request.query, srnamespace: '0', srlimit: '20', srprop: '' }, request.continuation);
  if (request.kind === 'links') Object.assign(params, { action: 'query', prop: 'links', titles: request.title, plnamespace: '0', pllimit: '20' }, request.continuation);
  if (request.kind === 'category') Object.assign(params, { action: 'query', list: 'categorymembers', cmtitle: request.title, cmtype: 'page|subcat', cmprop: 'ids|title|type', cmlimit: '20' }, request.continuation);
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

export function assertAllowedUrl(value: string): void {
  const url = new URL(value);
  const hostAllowed = url.hostname === 'wikimedia.org' || url.hostname === 'www.wikidata.org' || /^[a-z]{2,12}(?:-[a-z0-9]{1,12}){0,2}\.wikipedia\.org$/.test(url.hostname);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !hostAllowed) throw new AppError('UNSAFE_URL', 'API URL не належить до дозволених адрес.');
}
