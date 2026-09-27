import { z } from 'zod';
import type { DataGateway } from './gateway.js';
import { AppError } from './errors.js';
import { projectName } from './requests.js';
import { articleUrl, sourceId, type PageSource } from './source-evidence.js';
import { sha256 } from './storage.js';

const pageSchema = z.object({ pageid: z.number().int().positive(), title: z.string(), ns: z.number(), missing: z.boolean().optional(),
  fullurl: z.url(), pageprops: z.record(z.string(), z.unknown()).optional(),
  revisions: z.array(z.object({ revid: z.number().int(), slots: z.object({ main: z.object({ content: z.string().optional() }) }).optional() })).optional() });

export class PageVerifier {
  constructor(private readonly gateway: DataGateway) {}
  async check(qid: string, language: string, title: string, method: PageSource['discoveryMethod']): Promise<PageSource> {
    const response = await this.gateway.get({ kind: 'page', language, title, details: true });
    const raw = z.object({ query: z.object({ pages: z.array(pageSchema), redirects: z.array(z.object({ tofragment: z.string().optional() })).optional() }) }).parse(response.data);
    if (raw.query.pages.length !== 1) throw new AppError('PAGE_METADATA_AMBIGUOUS', 'API не повернув одну канонічну сторінку.');
    const page = raw.query.pages[0]!;
    if (page.missing || page.ns !== 0) throw new AppError('PAGE_NOT_ARTICLE', 'Сторінка відсутня або не є статтею.');
    const actual = z.string().regex(/^Q[1-9]\d*$/).safeParse(page.pageprops?.wikibase_item);
    let canonicalQid = actual.success ? actual.data : null;
    const snapshotIds = [response.ref.snapshotId];
    if (canonicalQid && canonicalQid !== qid) {
      const redirect = await this.gateway.get({ kind: 'entity', qid: canonicalQid, language });
      snapshotIds.push(redirect.ref.snapshotId);
      const entities = z.object({ entities: z.record(z.string(), z.object({ id: z.string().optional(), missing: z.unknown().optional() })) }).parse(redirect.data).entities;
      const entity = entities[canonicalQid] ?? Object.values(entities).find(e => e.id === qid);
      if (entity?.id && entity.missing === undefined) canonicalQid = entity.id;
    }
    const qidStatus = !actual.success ? 'missing' : canonicalQid !== qid ? 'conflict' : actual.data === qid ? 'confirmed' : 'redirected';
    const content = page.revisions?.[0]?.slots?.main.content;
    const disambiguation = Object.hasOwn(page.pageprops ?? {}, 'disambiguation'), section = raw.query.redirects?.some(r => r.tofragment);
    return { sourceId: sourceId(projectName(language), page.pageid), language, project: projectName(language), title: page.title, pageId: page.pageid,
      articleUrl: articleUrl(page.fullurl, projectName(language), page.title), urlMethod: 'info', wikidataId: actual.success ? actual.data : null,
      wikidataUrl: actual.success ? `https://www.wikidata.org/wiki/${actual.data}` : null, expectedQid: qid, canonicalQid, qidStatus, discoveryMethod: method,
      pageStatus: disambiguation ? 'disambiguation' : section ? 'section_redirect' : 'article',
      checkedAt: response.ref.receivedAt, revisionId: page.revisions?.[0]?.revid, snapshotIds,
      semantic: { matchType: section ? 'section_only' : 'ambiguous', status: 'pending', subject: page.title,
        rationale: disambiguation ? 'Сторінка неоднозначності.' : section ? 'Перенаправлення на розділ; перегляди сторінки не є переглядами розділу.' : qidStatus === 'conflict' ? `QID сторінки ${actual.data} не відповідає ${qid}; концепції не зливаються.` : 'Технічний зв’язок і змістова придатність різні. Прочитайте збережений вступ та розділи, зафіксуйте review.' },
      ...(content === undefined ? {} : { content: { wikitext: content.slice(0, 120_000), truncated: content.length > 120_000, checksum: sha256(content), headings: [...content.matchAll(/^={2,6}\s*(.+?)\s*={2,6}\s*$/gm)].map(m => m[1]!) } }),
    };
  }

  // Не незалежний доказ: langlinks зазвичай відображають той самий Wikidata graph.
  async langlinks(language: string, title: string, maxPages = 3) {
    let continuation: Record<string, string | number> | undefined;
    const links: { lang: string; title: string; url: string }[] = [], snapshotIds: string[] = [];
    const seen = new Set<string>();
    for (let n = 0; n < maxPages; n++) {
      const response = await this.gateway.get({ kind: 'langlinks', language, title, ...(continuation ? { continuation } : {}) });
      snapshotIds.push(response.ref.snapshotId);
      const data = z.object({ continue: z.record(z.string(), z.union([z.string(), z.number()])).optional(), query: z.object({ pages: z.array(z.object({ langlinks: z.array(z.object({ lang: z.string(), title: z.string(), url: z.url() })).optional() })) }) }).parse(response.data);
      for (const link of data.query.pages.flatMap(p => p.langlinks ?? [])) if (!seen.has(link.lang)) { links.push(link); seen.add(link.lang); }
      continuation = data.continue;
      if (!continuation) break;
    }
    return { links, snapshotIds, complete: !continuation, continuation, independentEvidence: false };
  }
}
