import { z } from 'zod';
import { AppError, asError } from './errors.js';
import { projectName } from './requests.js';
import { qidSchema, languageSchema, warning, warningSchema, type ResolveInput, type Warning, type Topic } from './schemas.js';
import type { DataGateway } from './gateway.js';
import { PageVerifier } from './page-verifier.js';
import { mappingEvidenceSchema, pageSourceSchema, type MappingEvidence, type PageSource } from './source-evidence.js';

const textValueSchema = z.object({ language: z.string(), value: z.string() });
function dictionary<T extends z.ZodType>(schema: T) {
  return z.preprocess(value => Array.isArray(value) && value.length === 0 ? {} : value, z.record(z.string(), schema));
}
const entitySchema = z.object({
  id: qidSchema.optional(), type: z.string().optional(), missing: z.union([z.boolean(), z.string()]).optional(),
  labels: dictionary(textValueSchema).optional(), descriptions: dictionary(textValueSchema).optional(),
  aliases: dictionary(z.array(textValueSchema)).optional(),
  sitelinks: dictionary(z.object({ site: z.string(), title: z.string(), url: z.url().optional() })).optional(), lastrevid: z.number().int().optional(),
});
const entityResponseSchema = z.object({
  success: z.literal(1), entities: z.record(z.string(), entitySchema),
  redirects: z.array(z.object({ from: qidSchema, to: qidSchema })).optional(),
});
const mappingSchema = z.object({ from: z.string(), to: z.string(), tofragment: z.string().optional() });
const pageResponseSchema = z.object({ query: z.object({
  normalized: z.array(mappingSchema).optional(), redirects: z.array(mappingSchema).optional(),
  pages: z.array(z.object({ title: z.string(), ns: z.number().int().optional(), pageid: z.number().int().positive().optional(),
    missing: z.boolean().optional(), invalid: z.boolean().optional(), pageprops: dictionary(z.unknown()).optional(), revisions: z.array(z.object({ timestamp: z.string() })).optional() })),
}) });
export const articleSchema = z.object({
  source: pageSourceSchema.optional(), evidence: mappingEvidenceSchema.optional(),
  language: z.string(), project: z.string(), siteId: z.string(), originalTitle: z.string().nullable(),
  title: z.string().nullable(), pageId: z.number().int().positive().nullable(),
  normalized: z.array(mappingSchema), redirects: z.array(mappingSchema),
  createdAt: z.string().optional(),
  mappingStatus: z.enum(['confirmed', 'not_found', 'incomplete', 'ambiguous']).optional(),
  mappingSource: z.enum(['sitelink', 'local_search']).optional(),
  status: z.enum(['found', 'missing_sitelink', 'missing_page', 'invalid_page', 'disambiguation', 'section_redirect', 'unavailable']),
});
export type Article = z.infer<typeof articleSchema>;
export const candidateSchema = z.object({
  sitelinkCatalog: z.array(z.object({ site: z.string(), title: z.string(), url: z.url().optional(), verification: z.literal('discovered') })).optional(),
  sitelinkCatalogComplete: z.boolean().optional(),
  qid: qidSchema, requestedQid: qidSchema, label: z.string().nullable(), description: z.string().nullable(),
  labelLanguage: z.string().nullable(), revisionId: z.number().int().optional(),
  articles: z.array(articleSchema), warnings: z.array(warningSchema),
  aliases: z.array(z.string()).optional(),
});
export type Candidate = z.infer<typeof candidateSchema>;

export class Resolver {
  constructor(private readonly gateway: DataGateway) {}
  async articleConcept(url: string): Promise<string> {
    const { language, title } = parseArticleUrl(url);
    const query = pageResponseSchema.parse((await this.gateway.get({ kind: 'page', language, title })).data).query;
    const page = query.pages[0];
    if (query.pages.length !== 1 || !page || page.missing || page.invalid || page.ns !== 0 || !page.pageid || page.pageprops && Object.hasOwn(page.pageprops, 'disambiguation') || query.redirects?.some(r => r.tofragment)) throw new AppError('ARTICLE_URL_AMBIGUOUS', 'URL не визначає однозначну статтю; потрібне уточнення концепції.');
    const qid = qidSchema.safeParse(page.pageprops?.wikibase_item);
    if (!qid.success) throw new AppError('ARTICLE_QID_MISSING', 'Перевірена сторінка не містить Wikidata item; автоматична підміна концепції заборонена.');
    return qid.data;
  }

  private async localMatch(qid: string, language: string, evidence: MappingEvidence): Promise<{ title?: string; status: 'confirmed' | 'not_found' | 'ambiguous' }> {
    const response = entityResponseSchema.parse((await this.gateway.get({ kind: 'entity', qid, language })).data);
    const entity = response.entities[qid];
    // Лише справжні labels/aliases. Ліміти зафіксовані до перегляду результатів.
    const terms = [...new Set([entity?.labels?.[language]?.value, entity?.labels?.en?.value, ...(entity?.aliases?.[language] ?? []).map(a => a.value), ...(entity?.aliases?.en ?? []).map(a => a.value)].filter((s): s is string => Boolean(s)))].slice(0, 2);
    if (!terms.length) { evidence.status = 'not_linked'; return { status: 'ambiguous' }; }
    const titles = new Set<string>(), matches = new Set<string>(); let incomplete = false;
    for (const query of terms) {
      const searchUrl = new URL(`https://${projectName(language)}/w/index.php`); searchUrl.search = new URLSearchParams({ title: 'Special:Search', search: query, ns0: '1' }).toString();
      const trace: MappingEvidence['queries'][number] = { query, searchUrl: searchUrl.href, snapshotIds: [], returned: 0, checked: 0 }; evidence.queries.push(trace);
      let continuation: Record<string, string | number> | undefined;
      for (let batch = 0; batch < evidence.limits.pagesPerTerm; batch++) {
      const response = await this.gateway.get({ kind: 'wiki-search', language, query, ...(continuation ? { continuation } : {}) });
      evidence.checkedAt = response.ref.receivedAt; trace.snapshotIds.push(response.ref.snapshotId);
      const result = z.object({ continue: z.record(z.string(), z.union([z.string(), z.number()])).optional(), query: z.object({ search: z.array(z.object({ title: z.string() })) }) }).parse(response.data);
      trace.returned += result.query.search.length;
      const remaining = evidence.limits.candidatesPerTerm - trace.checked;
      if (result.query.search.length > remaining) incomplete = true;
      for (const row of result.query.search.slice(0, remaining)) {
        trace.checked++;
        if (titles.has(row.title)) continue;
        titles.add(row.title);
        const checked = pageResponseSchema.parse((await this.gateway.get({ kind: 'page', language, title: row.title })).data).query;
        const page = checked.pages[0];
        if (!page || page.missing || page.invalid || page.ns !== 0 || !page.pageid) continue;
        const source = await new PageVerifier(this.gateway).check(qid, language, page.title, 'local_search');
        evidence.candidates.push(source);
        if (['confirmed', 'redirected'].includes(source.qidStatus) && source.pageStatus === 'article' && !Object.hasOwn(page.pageprops ?? {}, 'disambiguation') && !checked.redirects?.some(r => r.tofragment)) matches.add(page.title);
        else if (source.qidStatus === 'missing') incomplete = true;
      }
      continuation = result.continue;
      if (!continuation) break;
      if (trace.checked >= evidence.limits.candidatesPerTerm || batch + 1 === evidence.limits.pagesPerTerm) { incomplete = true; break; }
      }
    }
    evidence.searchCompleted = true; evidence.searchTruncated = incomplete;
    evidence.status = matches.size === 1 ? 'confirmed' : matches.size > 1 ? 'ambiguous' : incomplete ? 'search_incomplete' : 'not_found_after_search';
    return matches.size === 1 ? { title: [...matches][0]!, status: 'confirmed' } : { status: matches.size > 1 || incomplete ? 'ambiguous' : 'not_found' };
  }
  async candidate(qid: string, language: string, languages: string[]): Promise<Candidate> {
    const entityResult = await this.gateway.get({ kind: 'entity', qid, language });
    const response = entityResponseSchema.parse(entityResult.data);
    const redirected = response.redirects?.find(r => r.from === qid)?.to ?? qid;
    const entity = response.entities[qid] ?? response.entities[redirected];
    if (!entity || entity.missing !== undefined || !entity.id) throw new AppError('QID_NOT_FOUND', 'Сутність Wikidata не існує.', { qid });
    if (entity.type !== 'item') throw new AppError('INVALID_ENTITY', 'Очікувалася концепція Wikidata типу item.', { qid });
    if (entity.sitelinks === undefined) throw new AppError('SITELINKS_NOT_RETURNED', 'API не повернув запитане поле sitelinks. Це не доказ відсутності мовних відповідників.', { qid });
    const label = entity.labels?.[language] ?? entity.labels?.en;
    const description = entity.descriptions?.[language] ?? entity.descriptions?.en;
    const warnings: Warning[] = [warning('TITLE_HISTORY_LIMITATION', 'Поточний заголовок не гарантує історії всіх попередніх назв; перегляди redirects не додаються.')];
    if (entity.id !== qid) warnings.push(warning('QID_REDIRECT', 'QID перенаправлено на іншу сутність.', { from: qid, to: entity.id }));
    const articles: Article[] = [];
    for (const edition of languages) {
      let article: Article = { language: edition, project: projectName(edition), siteId: '', originalTitle: null, title: null, pageId: null, normalized: [], redirects: [], status: 'unavailable' };
      article.evidence = { version: '1.0.0', qid: entity.id, language: edition, sitelinkPresent: false, status: 'not_linked', checkedAt: entityResult.ref.receivedAt, searchCompleted: false, searchTruncated: false, queries: [], candidates: [], errors: [], limits: { terms: 2, candidatesPerTerm: 10, pagesPerTerm: 2 } };
      try {
        const site = z.object({ query: z.object({ general: z.object({ wikiid: z.string().regex(/^[a-z0-9_]+wiki$/), server: z.string(), lang: z.string() }) }) }).parse((await this.gateway.get({ kind: 'site', language: edition })).data).query.general;
        if (new URL(site.server.startsWith('//') ? `https:${site.server}` : site.server).hostname !== article.project) throw new AppError('PROJECT_MISMATCH', 'API повернув інший мовний проєкт.');
        article.siteId = site.wikiid;
        let sitelink = entity.sitelinks?.[site.wikiid];
        article.evidence.sitelinkPresent = Boolean(sitelink);
        article.mappingSource = 'sitelink';
        if (!sitelink) {
          const match = await this.localMatch(entity.id, edition, article.evidence);
          article.mappingSource = 'local_search'; article.mappingStatus = match.status;
          if (match.title) sitelink = { site: site.wikiid, title: match.title };
          warnings.push(warning(match.title ? 'LOCAL_EQUIVALENT_CONFIRMED' : match.status === 'ambiguous' ? 'MAPPING_AMBIGUOUS' : 'LOCAL_EQUIVALENT_NOT_FOUND', match.title ? 'Локальний пошук підтвердив сторінку тієї самої концепції через wikibase_item.' : article.evidence.searchTruncated ? 'Бюджет перевірки вичерпано; неперевірені кандидати залишилися.' : 'Точного відповідника не знайдено серед перевірених кандидатів.', { qid: entity.id, language: edition, status: article.evidence.status }));
        }
        if (!sitelink) {
          article.status = 'missing_sitelink';
          warnings.push(warning('ARTICLE_MISSING', 'Відсутність статті не означає відсутності інтересу.', { qid: entity.id, language: edition }));
        } else {
          article.originalTitle = sitelink.title;
          const query = pageResponseSchema.parse((await this.gateway.get({ kind: 'page', language: edition, title: sitelink.title })).data).query;
          article.normalized = query.normalized ?? []; article.redirects = query.redirects ?? [];
          let expected = sitelink.title;
          for (const mapping of [...article.normalized, ...article.redirects]) if (mapping.from === expected) expected = mapping.to;
          const page = query.pages.find(p => p.title === expected);
          if (!page || page.missing) article.status = 'missing_page';
          else if (page.invalid || page.ns !== 0 || !page.pageid) article.status = 'invalid_page';
          else {
            article.title = page.title; article.pageId = page.pageid;
            if (page.revisions?.[0]) article.createdAt = page.revisions[0].timestamp;
            article.status = page.pageprops && Object.hasOwn(page.pageprops, 'disambiguation') ? 'disambiguation' : article.redirects.some(r => r.tofragment) ? 'section_redirect' : 'found';
            const source = article.evidence.candidates.find(s => s.pageId === page.pageid) ?? await new PageVerifier(this.gateway).check(entity.id, edition, page.title, article.mappingSource ?? 'sitelink');
            article.source = source;
            article.title = source.title; article.pageId = source.pageId;
            if (source.pageStatus && source.pageStatus !== 'article') article.status = source.pageStatus;
            if (!article.evidence.candidates.some(s => s.sourceId === source.sourceId)) article.evidence.candidates.push(source);
            article.evidence.checkedAt = source.checkedAt;
            if (!['confirmed', 'redirected'].includes(source.qidStatus)) article.status = 'invalid_page';
            article.evidence.status = article.status === 'found' ? 'confirmed' : 'ambiguous';
            warnings.push(warning('CONTENT_REVIEW_REQUIRED', 'Технічний QID перевірено; змістову відповідність контексту ще має зафіксувати агент через review.', { sourceId: source.sourceId }));
            article.mappingStatus = article.status === 'found' ? 'confirmed' : 'ambiguous';
          }
          if (article.status !== 'found') warnings.push(warning('PAGE_NOT_COMPARABLE', 'Сторінку виключено: відсутня, неоднозначна, не є статтею або відповідає лише розділу.', { qid: entity.id, language: edition, status: article.status }));
          if (article.normalized.length || article.redirects.length) warnings.push(warning('TITLE_RESOLVED', 'Зафіксовано нормалізацію або перенаправлення заголовка.', { language: edition, originalTitle: article.originalTitle, title: article.title }));
        }
      } catch (error) {
        const problem = asError(error);
        if (['USER_AGENT_REQUIRED', 'USER_AGENT_INVALID', 'UNSAFE_PATH', 'CHECKSUM_MISMATCH', 'SNAPSHOT_MISSING', 'SNAPSHOT_MISMATCH'].includes(problem.code)) throw error;
        article.status = 'unavailable'; article.mappingStatus = 'incomplete';
        article.evidence.status = article.evidence.queries.length ? 'search_incomplete' : 'request_failed';
        article.evidence.errors.push({ code: problem.code, message: problem.message });
        warnings.push(warning(problem.code, 'Пошук або перевірку відповідника не завершено; це не доказ відсутності статті.', { qid, language: edition, cause: problem.message }));
      }
      articles.push(article);
    }
    return { qid: entity.id, requestedQid: qid, label: label?.value ?? null, labelLanguage: label?.language ?? null,
      sitelinkCatalog: Object.values(entity.sitelinks ?? {}).filter(s => s.site.endsWith('wiki') && !['commonswiki', 'specieswiki', 'wikidatawiki', 'mediawikiwiki', 'metawiki'].includes(s.site)).map(s => ({ ...s, verification: 'discovered' as const })), sitelinkCatalogComplete: true,
      description: description?.value ?? null, aliases: [...new Set(Object.values(entity.aliases ?? {}).flatMap(v => v.map(a => a.value)))], ...(entity.lastrevid === undefined ? {} : { revisionId: entity.lastrevid }), articles, warnings };
  }

  async resolve(input: ResolveInput): Promise<Candidate[]> {
    const ids = input.articleUrl ? [await this.articleConcept(input.articleUrl)] : input.qid ? [input.qid] : z.object({ success: z.literal(1), search: z.array(z.object({ id: qidSchema })) }).parse(
      (await this.gateway.get({ kind: 'search', query: input.query!, language: input.queryLanguage })).data).search.slice(0, 5).map(r => r.id);
    const candidates: Candidate[] = [];
    for (const qid of [...new Set(ids)]) candidates.push(await this.candidate(qid, input.queryLanguage, input.languages));
    return candidates;
  }
}

export function parseArticleUrl(value: string): { language: string; title: string } {
  const url = new URL(value), match = /^([a-z0-9-]+)\.wikipedia\.org$/.exec(url.hostname);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !match || !url.pathname.startsWith('/wiki/') || url.search || url.hash) throw new AppError('INVALID_ARTICLE_URL', 'Потрібен HTTPS URL статті мовного розділу Wikipedia: /wiki/Title, без query або фрагмента.');
  let title: string;
  try { title = decodeURIComponent(url.pathname.slice(6)).replaceAll('_', ' '); } catch { throw new AppError('INVALID_ARTICLE_URL', 'Некоректне URL-кодування заголовка.'); }
  if (!title || /[\u0000-\u001f|]/u.test(title)) throw new AppError('INVALID_ARTICLE_URL', 'Некоректний заголовок статті.');
  return { language: languageSchema.parse(match[1]), title };
}

export interface Coverage {
  topicId: string; label: string; includedQids: string[]; excludedQids: string[];
  matrix: { qid: string; languages: Record<string, Article['status']> }[];
  pages: Record<string, Article[]>; warnings: Warning[];
}
export function buildCoverage(topic: Topic, candidates: Candidate[], languages: string[]): Coverage {
  const selected = [...new Map(candidates.map(c => [c.qid, c])).values()];
  const included = selected.filter(c => languages.every(l => c.articles.some(a => a.language === l && a.status === 'found')));
  const includedQids = included.map(c => c.qid);
  const excludedQids = selected.filter(c => !includedQids.includes(c.qid)).map(c => c.qid);
  const warnings: Warning[] = [];
  if (selected.length !== candidates.length) warnings.push(warning('DUPLICATE_PAGES_REMOVED', 'Повторні канонічні концепції та їхні сторінки враховано лише один раз.', { topicId: topic.topicId }));
  if (excludedQids.length) warnings.push(warning('CONCEPTS_EXCLUDED', 'Зі спільного порівняння виключено концепції без повного покриття мов.', { topicId: topic.topicId, qids: excludedQids }));
  if (!included.length) warnings.push(warning('NO_COMMON_CONCEPTS', 'Немає спільного набору концепцій для порівняння.', { topicId: topic.topicId }));
  const pages: Record<string, Article[]> = {};
  for (const language of languages) {
    const all = included.flatMap(c => c.articles.filter(a => a.language === language));
    pages[language] = [...new Map(all.map(a => [`${a.project}:${a.pageId}`, a])).values()];
    if (pages[language].length !== all.length) warnings.push(warning('DUPLICATE_PAGES_REMOVED', 'Повторні сторінки враховано лише один раз.', { topicId: topic.topicId, language }));
  }
  return { topicId: topic.topicId, label: topic.label, includedQids, excludedQids, pages, warnings,
    matrix: selected.map(c => ({ qid: c.qid, languages: Object.fromEntries(languages.map(l => [l, c.articles.find(a => a.language === l)?.status ?? 'unavailable'])) })) };
}
