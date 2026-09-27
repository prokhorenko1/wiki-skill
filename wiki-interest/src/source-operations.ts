import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';
import { idSchema, warning, type Output } from './schemas.js';
import { resolutionSchema } from './models.js';
import { gateway, readRun, saveRun, type Services } from './research.js';
import { Resolver, type Candidate, type Article } from './resolver.js';
import { applySourceReview, articleUrl, sourceId, sourceReviewSchema, sourceSummary, type PageSource, type MappingEvidence } from './source-evidence.js';
import type { Snapshot, SnapshotRef } from './storage.js';

export const reviewSchema = z.strictObject({ resolutionId: idSchema, reviews: z.array(sourceReviewSchema).min(1).max(100) });
export async function reviewOperation(input: z.infer<typeof reviewSchema>, services: Services): Promise<Output> {
  const old = await services.store.read(['resolutions', `${input.resolutionId}.json`], resolutionSchema);
  const data = gateway(services, { source: old.source, cachePolicy: 'reuse', ...(old.source === 'fixtures' ? { fixtureId: 'demo-v1' as const } : {}) });
  for (const review of input.reviews.filter(r => r.section)) {
    const sources = old.candidates.flatMap(c => c.articles.flatMap(a => [...a.source ? [a.source] : [], ...a.evidence?.candidates ?? []])).filter(s => s.sourceId === review.sourceId && s.revisionId === review.revisionId);
    if (!sources.length) throw new AppError('SOURCE_NOT_FOUND', 'Сторінка або revisionId не належать resolution.');
    const response = await data.get({ kind: 'sections', language: sources[0]!.language, revisionId: review.revisionId });
    const sections = z.object({ parse: z.object({ sections: z.array(z.object({ line: z.string(), anchor: z.string() })) }) }).parse(response.data).parse.sections;
    for (const source of sources) if (source.content) { source.content.sections = sections; source.snapshotIds.push(response.ref.snapshotId); }
  }
  const seen = new Set<string>();
  const update = (source: PageSource): PageSource => {
    const review = input.reviews.find(r => r.sourceId === source.sourceId);
    if (!review) return source;
    seen.add(source.sourceId); return applySourceReview(source, review);
  };
  for (const candidate of old.candidates) for (const article of candidate.articles) {
    if (article.source) {
      article.source = update(article.source);
      if (article.source.semantic.status === 'reviewed' && article.source.semantic.matchType !== 'exact') { article.status = article.source.semantic.matchType === 'section_only' ? 'section_redirect' : 'invalid_page'; article.mappingStatus = 'ambiguous'; }
    }
    if (article.evidence) {
      article.evidence.candidates = article.evidence.candidates.map(update);
      if (article.status !== 'found' && article.evidence.candidates.some(s => ['broader', 'section_only'].includes(s.semantic.matchType))) article.evidence.status = 'broader_only';
    }
  }
  if (input.reviews.some(r => !seen.has(r.sourceId))) throw new AppError('SOURCE_NOT_FOUND', 'Рішення посилається на sourceId поза resolution.');
  const resolutionId = randomUUID(), saved = { ...old, resolutionId, snapshots: [...new Map([...old.snapshots, ...data.snapshots].map(r => [r.snapshotId, r])).values()], createdAt: services.clock.now().toISOString(), query: { operation: 'review', parentResolutionId: old.resolutionId, reviews: input.reviews, originalQuery: old.query } };
  const path = await services.store.write(['resolutions', `${resolutionId}.json`], saved);
  return { status: 'ok', identifiers: { resolutionId }, summary: { candidates: saved.candidates.map(c => ({ qid: c.qid, articles: c.articles.map(a => ({ language: a.language, status: a.status, source: a.source && sourceSummary(a.source), evidence: a.evidence && { ...a.evidence, candidates: a.evidence.candidates.map(sourceSummary) } })) })) }, warnings: [], artifacts: [{ kind: 'resolution', path }], nextAction: { operation: 'research', message: 'Передайте новий resolutionId з вибраним QID; рішення exact не усуває обмежень інтерпретації.' } };
}

export function useReviewedSources(candidate: Candidate, reviewed: Candidate): Candidate {
  for (const article of candidate.articles) {
    const old = reviewed.articles.find(a => a.language === article.language);
    if (!old) continue;
    if (old.source?.semantic.status === 'reviewed') {
      if (!article.source || article.source.sourceId !== old.source.sourceId || article.source.revisionId !== old.source.revisionId || article.source.title !== old.source.title) throw new AppError('CONTENT_REVIEW_STALE', 'Стаття або її версія змінилася після review; повторно прочитайте зміст.');
      article.source.semantic = old.source.semantic;
      if (old.source.content?.sections && article.source.content) article.source.content.sections = old.source.content.sections;
      if (old.source.semantic.matchType !== 'exact') { article.status = old.status; article.mappingStatus = 'ambiguous'; }
    }
    if (old.evidence) for (const source of article.evidence?.candidates ?? []) {
      const previous = old.evidence.candidates.find(s => s.sourceId === source.sourceId && s.revisionId === source.revisionId);
      if (previous?.semantic.status === 'reviewed') source.semantic = previous.semantic;
    }
    if (article.status !== 'found' && article.evidence?.candidates.some(s => s.semantic.status === 'reviewed' && ['broader', 'section_only'].includes(s.semantic.matchType))) article.evidence.status = 'broader_only';
  }
  candidate.warnings = candidate.warnings.filter(w => w.code !== 'CONTENT_REVIEW_REQUIRED' || !candidate.articles.some(a => a.source?.sourceId === w.details?.sourceId && a.source?.semantic.status === 'reviewed'));
  return candidate;
}

export const sourcesSchema = z.strictObject({ mode: z.enum(['refresh', 'historical']).default('refresh'), resolutionId: idSchema.optional() });

// Старі знімки не містили inprop=url. URL відновлюється лише з перевіреного
// siteinfo.articlepath + канонічного title тієї самої page ID; метод явно інший.
function historicalSource(qid: string, language: string, title: string, method: PageSource['discoveryMethod'], snapshots: { ref: SnapshotRef; value: Snapshot }[]): PageSource | undefined {
  const found = snapshots.find(s => s.value.request.kind === 'page' && s.value.request.language === language && s.value.request.title === title);
  if (!found) return undefined;
  const page = JSON.parse(found.value.body).query?.pages?.[0];
  if (!page?.pageid || page.ns !== 0 || page.missing) return undefined;
  const site = snapshots.find(s => s.value.request.kind === 'site' && s.value.request.language === language);
  const general = site && JSON.parse(site.value.body).query?.general;
  if (!page.fullurl && (!general?.articlepath?.includes('$1') || !general.server)) return undefined;
  const project = `${language}.wikipedia.org`, url = page.fullurl ?? new URL(general.articlepath.replace('$1', encodeURIComponent(page.title.replaceAll(' ', '_'))), general.server.startsWith('//') ? `https:${general.server}` : general.server).href;
  const qidValue = z.string().regex(/^Q[1-9]\d*$/).safeParse(page.pageprops?.wikibase_item);
  return { sourceId: sourceId(project, page.pageid), language, project, title: page.title, pageId: page.pageid, articleUrl: articleUrl(url, project), urlMethod: page.fullurl ? 'info' : 'siteinfo_articlepath',
    wikidataId: qidValue.success ? qidValue.data : null, wikidataUrl: qidValue.success ? `https://www.wikidata.org/wiki/${qidValue.data}` : null, expectedQid: qid, canonicalQid: qidValue.success ? qidValue.data : null,
    qidStatus: qidValue.success ? qidValue.data === qid ? 'confirmed' : 'conflict' : 'missing', discoveryMethod: method,
    checkedAt: found.ref.receivedAt, revisionId: page.lastrevid, snapshotIds: [found.ref.snapshotId, ...(site ? [site.ref.snapshotId] : [])],
    semantic: { matchType: 'ambiguous', status: 'pending', subject: page.title, rationale: qidValue.success && qidValue.data !== qid ? `QID сторінки ${qidValue.data} відрізняється від ${qid}. Історичний знімок не містить змісту; широту теми ним не встановлено.` : 'Історичний знімок підтверджує метадані, але не містить змісту. Змістова відповідність не перевірена цим знімком.' } };
}

export async function sourcesOperation(runId: string, input: z.infer<typeof sourcesSchema>, services: Services): Promise<Output> {
  const { manifest, dataset } = await readRun(runId, services);
  const languages = [...new Set([...manifest.completion?.requestedLanguages ?? [], ...manifest.request.languages])];
  const data = gateway(services, { ...manifest.request, cachePolicy: 'refresh' });
  const snapshots: { ref: SnapshotRef; value: Snapshot }[] = [];
  if (input.mode === 'historical') for (const ref of manifest.snapshots) snapshots.push({ ref, value: await services.store.loadSnapshot(ref) });
  const resolution = input.resolutionId ? await services.store.read(['resolutions', `${input.resolutionId}.json`], resolutionSchema) : undefined;
  if (resolution && (resolution.source === 'fixtures') !== (manifest.source === 'fixtures')) throw new AppError('SOURCE_MISMATCH', 'Походження resolution та дослідження відрізняється.');
  const candidates = new Map<string, Candidate>();
  for (const old of manifest.topics.flatMap(t => t.candidates)) {
    if (candidates.has(old.qid)) continue;
    let candidate: Candidate;
    if (resolution) {
      const selected = resolution.candidates.find(c => c.qid === old.qid);
      if (!selected || languages.some(l => !selected.articles.some(a => a.language === l))) throw new AppError('RESOLUTION_COVERAGE_MISMATCH', 'Resolution має покривати ті самі концепції й усі запитані/використані мови.');
      candidate = structuredClone(selected);
    } else if (input.mode === 'refresh') candidate = await new Resolver(data).candidate(old.qid, manifest.request.queryLanguage, languages);
    else {
      candidate = structuredClone(old);
      const entity = snapshots.find(s => s.value.request.kind === 'entity' && s.value.request.qid === old.qid);
      const sitelinks = entity && JSON.parse(entity.value.body).entities[old.qid]?.sitelinks || {};
      candidate.sitelinkCatalog = Object.values(sitelinks).filter((s: any) => s.site.endsWith('wiki') && !['commonswiki', 'specieswiki', 'wikidatawiki', 'metawiki'].includes(s.site)).map((s: any) => ({ site: s.site, title: s.title, ...(s.url ? { url: s.url } : {}), verification: 'discovered' as const }));
      candidate.sitelinkCatalogComplete = Boolean(entity);
      for (const language of languages) {
        let article = candidate.articles.find(a => a.language === language);
        if (!article) { article = { language, project: `${language}.wikipedia.org`, siteId: `${language}wiki`, originalTitle: null, title: null, pageId: null, normalized: [], redirects: [], status: 'missing_sitelink' }; candidate.articles.push(article); }
        if (article.title) article.source = historicalSource(old.qid, language, article.originalTitle ?? article.title, article.mappingSource ?? 'sitelink', snapshots);
        const evidence: MappingEvidence = { version: '1.0.0', qid: old.qid, language, sitelinkPresent: Boolean(sitelinks[article.siteId]), status: article.source?.qidStatus === 'confirmed' ? 'confirmed' : 'not_linked', checkedAt: article.source?.checkedAt ?? entity?.ref.receivedAt ?? manifest.createdAt, searchCompleted: false, searchTruncated: false, queries: [], candidates: article.source ? [article.source] : [], errors: [], limits: { terms: 2, candidatesPerTerm: 5, pagesPerTerm: 1 } };
        for (const search of snapshots.filter(s => s.value.request.kind === 'wiki-search' && s.value.request.language === language)) {
          const raw = JSON.parse(search.value.body), query = String(search.value.request.query), rows = raw.query?.search ?? [];
          const found = rows.map((r: { title: string }) => historicalSource(old.qid, language, r.title, 'local_search', snapshots)).filter((s: PageSource | undefined): s is PageSource => Boolean(s));
          const url = new URL(`https://${language}.wikipedia.org/w/index.php`); url.search = new URLSearchParams({ title: 'Special:Search', search: query, ns0: '1' }).toString();
          evidence.queries.push({ query, searchUrl: url.href, snapshotIds: [search.ref.snapshotId], returned: rows.length, checked: found.length });
          evidence.candidates.push(...found); evidence.searchCompleted = true; evidence.searchTruncated ||= Boolean(raw.continue) || found.length < rows.length; evidence.checkedAt = search.ref.receivedAt;
        }
        if (!article.source && evidence.queries.length) evidence.status = evidence.searchTruncated ? 'search_incomplete' : 'not_found_after_search';
        article.evidence = evidence;
      }
    }
    candidates.set(old.qid, candidate);
  }
  for (const topic of manifest.topics) {
    topic.candidates = topic.candidates.map(c => candidates.get(c.qid)!);
    for (const [language, pages] of Object.entries(topic.coverage.pages)) topic.coverage.pages[language] = pages.map(old => {
      const updated = topic.candidates.flatMap(c => c.articles).find(a => a.language === language && a.pageId === old.pageId && a.title === old.title);
      if (!updated?.source || updated.status !== 'found' || !['confirmed', 'redirected'].includes(updated.source.qidStatus) || updated.source.semantic.status === 'reviewed' && updated.source.semantic.matchType !== 'exact') throw new AppError('ARTICLE_SELECTION_CHANGED', 'Вибір/відповідність статті змінилися або не перевірені. Старі ряди не приєднано до нової статті; потрібен новий analyze.', { language, title: old.title, pageId: old.pageId });
      return updated;
    });
  }
  manifest.parentRunId = runId; manifest.runId = randomUUID(); manifest.mode = 'revise'; manifest.createdAt = services.clock.now().toISOString();
  if (manifest.completion) for (const candidate of candidates.values()) for (const article of candidate.articles) {
    const mapping = manifest.completion.mapping.find(m => m.qid === candidate.qid && m.language === article.language);
    if (mapping) { mapping.evidence = article.evidence; mapping.status = article.evidence?.status ?? article.mappingStatus ?? article.status; mapping.title = article.title; }
    const unavailable = manifest.completion.unavailableLanguages.find(l => l.language === article.language);
    if (unavailable && !manifest.completion.analyzedRequestedLanguages.includes(article.language)) {
      unavailable.code = article.status === 'found' ? 'NEW_EQUIVALENT_REQUIRES_ANALYSIS' : article.evidence?.status ?? unavailable.code;
      unavailable.reason = article.status === 'found' ? 'Метадані підтверджені, але статтю ще не включено до збережених рядів; потрібен новий research.' : 'Стан і межі перевірки наведено в articleSources.mappings.';
    }
  }
  manifest.originalRequest = { operation: 'sources', parentRunId: runId, input, originalRequest: manifest.originalRequest };
  manifest.snapshots = [...new Map([...manifest.snapshots, ...resolution?.snapshots ?? [], ...data.snapshots].map(r => [r.snapshotId, r])).values()];
  manifest.dataAccess = data.stats;
  manifest.warnings.push(warning(input.mode === 'historical' ? 'HISTORICAL_METADATA_ONLY' : 'METADATA_REFRESH_ONLY', 'Ряди переглядів повторно використано без мережевого завантаження; ця операція перевіряє джерела, не всю аналітику.'));
  return saveRun(manifest, dataset, services);
}
