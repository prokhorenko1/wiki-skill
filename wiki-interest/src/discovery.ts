import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, asError } from './errors.js';
import { gateway, type Services } from './research.js';
import { Resolver, type Article, type Candidate } from './resolver.js';
import { projectName, type ApiRequest } from './requests.js';
import { discoverSchema, discoverySchema, planInputSchema, topicPlanSchema, type Discovery } from './topic-plan.js';
import { canonical, sha256 } from './storage.js';
import { getPeriod } from './calendar.js';
import type { Output } from './schemas.js';

const pageSchema = z.object({ title: z.string(), ns: z.number(), pageid: z.number().optional(), missing: z.boolean().optional(), pageprops: z.record(z.string(), z.unknown()).optional() });
const responseSchema = z.object({ continue: z.record(z.string(), z.union([z.string(), z.number()])).optional(), query: z.object({ search: z.array(pageSchema).optional(), categorymembers: z.array(pageSchema).optional(), pages: z.array(z.object({ links: z.array(pageSchema).optional() }).passthrough()).optional() }) });

export async function discoverOperation(input: z.infer<typeof discoverSchema>, services: Services): Promise<Output> {
  const data = gateway(services, input, undefined, input.limits.requests), resolver = new Resolver(data);
  const candidates: Discovery['candidates'] = [], reasons = new Set<string>();
  const add = async (qid: string | null, title: string, kind: Discovery['candidates'][number]['sources'][number]['kind'], value: string, sourceId?: string) => {
    const old = candidates.find(c => qid ? c.qid === qid : c.articles.some(a => a.title?.normalize('NFC').replaceAll('_', ' ') === title.normalize('NFC').replaceAll('_', ' ')));
    const source = { kind, value, snapshotIds: sourceId ? [sourceId] : [] };
    if (old) { old.sources.push(source); return; }
    if (candidates.length >= input.limits.candidates) { reasons.add('candidate_limit'); return; }
    let articles: Article[] = [], verified: Candidate | undefined;
    if (!qid && title) {
      const response = await data.get({ kind: 'page', language: input.queryLanguage, title }); source.snapshotIds.push(response.ref.snapshotId);
      const pages = z.object({ query: z.object({ pages: z.array(pageSchema) }) }).parse(response.data).query.pages;
      const page = pages.find(p => !p.missing && p.ns === 0 && p.pageid);
      if (page) {
        qid = typeof page.pageprops?.wikibase_item === 'string' ? page.pageprops.wikibase_item : null;
        articles = [{ language: input.queryLanguage, project: projectName(input.queryLanguage), siteId: '', originalTitle: title, title: page.title, pageId: page.pageid!, normalized: [], redirects: [], status: page.pageprops && 'disambiguation' in page.pageprops ? 'disambiguation' : 'found' }];
      }
    }
    if (qid) {
      const already = candidates.find(c => c.qid === qid);
      if (already) { already.sources.push(source); return; }
      verified = await resolver.candidate(qid, input.queryLanguage, input.languages);
      const canonicalCandidate = candidates.find(c => c.qid === verified!.qid);
      if (canonicalCandidate) { canonicalCandidate.sources.push(source); return; }
      qid = verified.qid; articles = verified.articles;
    }
    const found = articles.some(a => a.status === 'found');
    candidates.push({ candidateId: qid ?? `page-${sha256(`${input.queryLanguage}:${title}`).slice(0, 16)}`, qid,
      label: verified?.label ?? title, description: verified?.description ?? null, aliases: verified?.aliases ?? [], sources: [source], articles, verified,
      subtopic: null, status: found ? 'proposed' : 'excluded', reason: found ? 'Існування перевірено; тематичну релевантність має оцінити агент до перегляду динаміки.' : 'Немає перевіреної придатної статті.' });
  };
  const safely = async (task: () => Promise<void>) => { try { await task(); } catch (error) { const problem = asError(error); if (/^(DISCOVERY_REQUEST_LIMIT|QID_NOT_FOUND|INVALID_RESPONSE|API_ERROR|OFFLINE_CACHE_MISS|NETWORK_|HTTP_|RATE_LIMITED)/.test(problem.code)) reasons.add(problem.code); else throw error; } };
  for (const qid of input.seedQids) await safely(() => add(qid, qid, 'seed', qid));
  for (const title of input.pageTitles) await safely(() => add(null, title, 'seed', title));
  for (const query of [...new Set([input.query, ...input.searchTerms])]) await safely(async () => {
    let continuation: number | undefined;
    const seen = new Set<number>();
    do {
      const response = await data.get({ kind: 'search', query, language: input.queryLanguage, continuation });
      const result = z.object({ search: z.array(z.object({ id: z.string() })), 'search-continue': z.number().optional() }).parse(response.data);
      for (const item of result.search) await add(item.id, item.id, 'wikidata', query, response.ref.snapshotId);
      continuation = result['search-continue'];
      if (continuation !== undefined && (seen.has(continuation) || candidates.length >= input.limits.candidates || data.logicalRequests >= input.limits.requests)) { reasons.add('wikidata_pagination_limit'); break; }
      if (continuation !== undefined) seen.add(continuation);
    } while (continuation !== undefined);
  });
  const tasks: { kind: 'wiki-search' | 'links' | 'category'; value: string; depth: number }[] = [
    ...[...new Set([input.query, ...input.searchTerms])].map(value => ({ kind: 'wiki-search' as const, value, depth: 0 })),
    ...input.linkTitles.map(value => ({ kind: 'links' as const, value, depth: 0 })),
    ...input.categoryTitles.map(value => ({ kind: 'category' as const, value, depth: 0 })),
  ];
  const visited = new Set<string>();
  for (let index = 0; index < tasks.length; index++) {
    const task = tasks[index]!;
    if (visited.has(`${task.kind}:${task.value}`)) continue;
    visited.add(`${task.kind}:${task.value}`);
    if (candidates.length >= input.limits.candidates || data.logicalRequests >= input.limits.requests) { reasons.add('unfinished_sources'); break; }
    await safely(async () => {
      let continuation: Record<string, string | number> | undefined;
      const seen = new Set<string>();
      do {
        const request: ApiRequest = task.kind === 'wiki-search' ? { kind: task.kind, language: input.queryLanguage, query: task.value, continuation } : { kind: task.kind, language: input.queryLanguage, title: task.value, continuation };
        const response = await data.get(request), result = responseSchema.parse(response.data);
        if (task.kind === 'wiki-search' && !result.query.search || task.kind === 'category' && !result.query.categorymembers || task.kind === 'links' && !result.query.pages) throw new AppError('INVALID_RESPONSE', 'Відсутнє очікуване поле discovery-відповіді.');
        const pages = result.query.search ?? result.query.categorymembers ?? result.query.pages?.flatMap(p => p.links ?? []) ?? [];
        for (const page of pages) {
          if (page.ns === 14 && task.kind === 'category') {
            if (task.depth < input.limits.depth) tasks.push({ ...task, value: page.title, depth: task.depth + 1 }); else reasons.add('category_depth_limit');
          } else if (page.ns === 0) await add(null, page.title, task.kind === 'wiki-search' ? 'search' : task.kind === 'links' ? 'link' : 'category', task.value, response.ref.snapshotId);
        }
        const keys = task.kind === 'wiki-search' ? ['continue', 'sroffset'] : task.kind === 'links' ? ['continue', 'plcontinue'] : ['continue', 'cmcontinue'];
        if (result.continue && Object.keys(result.continue).some(k => !keys.includes(k))) throw new AppError('INVALID_RESPONSE', 'Неочікувані поля pagination.');
        continuation = result.continue;
        if (continuation && seen.has(canonical(continuation))) { reasons.add('repeated_continuation'); break; }
        if (continuation) seen.add(canonical(continuation));
        if (continuation && (candidates.length >= input.limits.candidates || data.logicalRequests >= input.limits.requests)) { reasons.add('pagination_limit'); break; }
      } while (continuation);
    });
  }
  const discovery = discoverySchema.parse({ schemaVersion: '3.0.0', discoveryId: randomUUID(), createdAt: services.clock.now().toISOString(), request: input,
    candidates, snapshots: data.snapshots, discoveryTruncated: reasons.size > 0, truncationReasons: [...reasons], logicalRequests: data.logicalRequests, metadataBasis: 'current_metadata_not_historical_membership' });
  const path = await services.store.write(['discoveries', `${discovery.discoveryId}.json`], discovery);
  return { status: 'needs_selection', identifiers: { discoveryId: discovery.discoveryId }, summary: { candidateCount: candidates.length, candidates: candidates.slice(0, 12).map(c => ({ candidateId: c.candidateId, qid: c.qid, label: c.label, description: c.description, aliases: c.aliases, status: c.status, articles: c.articles.map(a => ({ language: a.language, title: a.title, status: a.status })) })), discoveryTruncated: discovery.discoveryTruncated, truncationReasons: discovery.truncationReasons, logicalRequests: data.logicalRequests, details: path }, warnings: discovery.discoveryTruncated ? [{ code: 'DISCOVERY_TRUNCATED', message: 'Discovery обмежено; це не повний перелік тематики.' }] : [], artifacts: [{ kind: 'discovery', path }], nextAction: { operation: 'plan', message: 'Оцініть зміст кандидатів і зафіксуйте план до завантаження переглядів.' } };
}

export async function planOperation(input: z.infer<typeof planInputSchema>, services: Services): Promise<Output> {
  const discovery = await services.store.read(['discoveries', `${input.discoveryId}.json`], discoverySchema);
  getPeriod(input.period, services.clock);
  if (new Set(input.subtopics.map(s => s.id)).size !== input.subtopics.length || new Set(input.decisions.map(d => d.candidateId)).size !== input.decisions.length) throw new AppError('PLAN_DUPLICATE', 'Повторені підтематики або рішення.');
  for (const d of input.decisions) if (!discovery.candidates.some(c => c.candidateId === d.candidateId)) throw new AppError('CANDIDATE_NOT_FOUND', 'Рішення посилається на невиявленого кандидата.');
  const members = input.decisions.filter(d => d.status === 'selected').map(d => {
    const candidate = discovery.candidates.find(c => c.candidateId === d.candidateId)!;
    if (!candidate.verified || !candidate.qid || !candidate.articles.some(a => a.status === 'found')) throw new AppError('PLAN_UNVERIFIED', 'Для набору потрібні перевірені Wikidata-концепція та стаття; кандидат без QID лишається у discovery.');
    if (!d.role || (d.role !== 'root' && !input.subtopics.some(s => s.id === d.subtopic))) throw new AppError('PLAN_SUBTOPIC', 'Призначте роль та одну основну підтематику.');
    return { candidateId: d.candidateId, qid: candidate.qid, role: d.role, subtopic: d.subtopic ?? null, reason: d.reason };
  });
  if (!members.some(m => m.role === 'core') || members.filter(m => m.role === 'root').length > 1 || members.length > 30) throw new AppError('PLAN_COMPOSITION', 'Потрібен core, не більше однієї кореневої статті та 30 концепцій загалом.');
  const decisions = discovery.candidates.map(c => {
    const decision = input.decisions.find(d => d.candidateId === c.candidateId);
    return { ...c, status: decision?.status ?? 'excluded', subtopic: decision?.subtopic ?? null, reason: decision?.reason ?? 'Не включено до зафіксованих меж дослідження; динаміка не використовувалася для вибору.' };
  });
  if (input.parentPlanId) await services.store.read(['plans', `${input.parentPlanId}.json`], topicPlanSchema);
  const compositionVersion = sha256(canonical({ members, subtopics: input.subtopics, boundaries: input.boundaries, languages: discovery.request.languages }));
  const plan = topicPlanSchema.parse({ ...input, schemaVersion: '3.0.0', methodologyVersion: '3.0.0', planId: randomUUID(), compositionVersion, frozenAt: services.clock.now().toISOString(), members, decisions,
    languages: discovery.request.languages, queryLanguage: discovery.request.queryLanguage, discovery,
    comparisonRules: ['Склад фіксується до перегляду динаміки.', 'Спільний core: ті самі концепції й повна історія у всіх мовах; недостатню історію показано окремо.', 'Extended = core плюс додаткові концепції; тільки всередині мови, без міжмовного ранжування.', 'Одна основна підтематика; фізичні дублікати виключаються зі спільного набору.', 'Поточні метадані не є історичним складом категорій.'] });
  const path = await services.store.write(['plans', `${plan.planId}.json`], plan);
  return { status: 'ok', identifiers: { topicPlanId: plan.planId }, summary: { compositionVersion, members, period: plan.period, languages: plan.languages, exclusions: decisions.filter(d => d.status === 'excluded').length }, warnings: [], artifacts: [{ kind: 'topic-plan', path }], nextAction: { operation: 'analyze', message: 'Передайте mode: topic, topicPlanId і languages. Код застосує період, фільтри та склад плану.' } };
}
