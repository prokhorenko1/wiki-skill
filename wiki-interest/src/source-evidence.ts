import { z } from 'zod';
import { AppError } from './errors.js';
import { sha256 } from './storage.js';
import { assertAllowedUrl } from './requests.js';

export const matchTypeSchema = z.enum(['exact', 'broader', 'narrower', 'section_only', 'mention_only', 'ambiguous']);
export const semanticSchema = z.object({
  matchType: matchTypeSchema, status: z.enum(['pending', 'reviewed']), subject: z.string(), rationale: z.string(),
  evidenceQuote: z.string().optional(), context: z.string().optional(), sectionUrl: z.url().optional(),
});
export const pageSourceSchema = z.object({
  sourceId: z.string(), language: z.string(), project: z.string(), title: z.string(), pageId: z.number().int().positive(),
  articleUrl: z.url(), urlMethod: z.enum(['info', 'siteinfo_articlepath']), wikidataId: z.string().nullable(), wikidataUrl: z.url().nullable(),
  expectedQid: z.string(), canonicalQid: z.string().nullable(), qidStatus: z.enum(['confirmed', 'redirected', 'conflict', 'missing']),
  pageStatus: z.enum(['article', 'disambiguation', 'section_redirect']).optional(),
  discoveryMethod: z.enum(['sitelink', 'local_search', 'article_url']), checkedAt: z.iso.datetime(), revisionId: z.number().int().optional(),
  snapshotIds: z.array(z.string()), semantic: semanticSchema,
  content: z.object({ wikitext: z.string(), truncated: z.boolean(), checksum: z.string(), headings: z.array(z.string()), sections: z.array(z.object({ line: z.string(), anchor: z.string() })).optional() }).optional(),
});
export type PageSource = z.infer<typeof pageSourceSchema>;
export const mappingEvidenceSchema = z.object({
  version: z.literal('1.0.0'), qid: z.string(), language: z.string(), sitelinkPresent: z.boolean(),
  status: z.enum(['confirmed', 'not_linked', 'not_found_after_search', 'search_incomplete', 'request_failed', 'ambiguous', 'broader_only']),
  checkedAt: z.iso.datetime(), searchCompleted: z.boolean(), searchTruncated: z.boolean(),
  queries: z.array(z.object({ query: z.string(), searchUrl: z.url(), snapshotIds: z.array(z.string()), returned: z.number(), checked: z.number() })),
  candidates: z.array(pageSourceSchema), errors: z.array(z.object({ code: z.string(), message: z.string() })),
  limits: z.object({ terms: z.number(), candidatesPerTerm: z.number(), pagesPerTerm: z.number() }),
});
export type MappingEvidence = z.infer<typeof mappingEvidenceSchema>;
export const sourceReviewSchema = z.strictObject({
  sourceId: z.string(), revisionId: z.number().int(), matchType: matchTypeSchema,
  subject: z.string().min(3).max(400), rationale: z.string().min(10).max(700), context: z.string().min(3).max(500),
  evidenceQuote: z.string().min(10).max(800), section: z.string().min(1).max(200).optional(),
});
export function sourceId(project: string, pageId: number): string { return `page-${sha256(`${project}:${pageId}`).slice(0, 20)}`; }
export function articleUrl(value: string, project: string, title?: string): string {
  assertAllowedUrl(value); const url = new URL(value);
  if (url.hostname !== project || !url.pathname.startsWith('/wiki/') || url.username || url.password) throw new AppError('ARTICLE_URL_MISMATCH', 'URL метаданих не належить перевіреному мовному розділу.');
  if (title && decodeURIComponent(url.pathname.slice(6)).replaceAll('_', ' ').normalize('NFC') !== title.replaceAll('_', ' ').normalize('NFC')) throw new AppError('ARTICLE_URL_MISMATCH', 'URL метаданих не відповідає канонічному заголовку сторінки.');
  return url.href;
}
export function applySourceReview(source: PageSource, review: z.infer<typeof sourceReviewSchema>): PageSource {
  if (review.sourceId !== source.sourceId || review.revisionId !== source.revisionId || !source.content?.wikitext.includes(review.evidenceQuote)) throw new AppError('REVIEW_EVIDENCE_MISMATCH', 'Рішення має посилатися на поточний sourceId, revisionId та дослівний фрагмент збереженого змісту.');
  if (review.matchType === 'exact' && !['confirmed', 'redirected'].includes(source.qidStatus)) throw new AppError('QID_CONFLICT', 'Змістовне рішення не може приховати конфлікт концепцій.');
  if (review.matchType === 'exact' && source.pageStatus && source.pageStatus !== 'article') throw new AppError('PAGE_NOT_COMPARABLE', 'Неоднозначну сторінку або перенаправлення на розділ не можна прийняти як exact.');
  const section = source.content.sections?.find(s => s.line === review.section);
  if (review.section && !section) throw new AppError('SECTION_NOT_FOUND', 'Розділ не знайдений у збереженій API-таблиці розділів цієї версії статті.');
  if (review.matchType === 'section_only' && !review.section) throw new AppError('SECTION_REQUIRED', 'Для section_only потрібен перевірений розділ.');
  return { ...source, semantic: { ...review, status: 'reviewed', ...(section ? { sectionUrl: `${source.articleUrl}#${encodeURIComponent(section.anchor)}` } : {}) } };
}

export function sourceSummary(source: PageSource) {
  const { content: _content, ...compact } = source;
  return compact;
}
