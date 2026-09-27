import { z } from 'zod';
import type { Manifest } from './models.js';
import { mappingEvidenceSchema, pageSourceSchema, sourceSummary } from './source-evidence.js';

export const pageviewRequestSchema = z.object({
  sourceId: z.string().nullable(), kind: z.enum(['article', 'project']), project: z.string(), title: z.string().nullable(),
  access: z.string(), agent: z.string(), granularity: z.enum(['daily', 'monthly']), start: z.string(), end: z.string(),
  requestUrl: z.url(), fetchedAt: z.string(), snapshotId: z.string(), snapshotPath: z.string(),
});
export const sourceLinksSchema = z.object({ pages: z.array(pageSourceSchema), mappings: z.array(mappingEvidenceSchema), requests: z.array(pageviewRequestSchema) });
export function sourceLinks(manifest: Manifest): z.infer<typeof sourceLinksSchema> {
  const mappings = [...new Map([
    ...manifest.completion?.mapping.flatMap(m => m.evidence ? [m.evidence] : []) ?? [],
    ...manifest.topics.flatMap(t => t.candidates.flatMap(c => c.articles.flatMap(a => a.evidence ? [a.evidence] : []))),
  ].map(m => [`${m.qid}:${m.language}`, m])).values()];
  const used = manifest.topics.flatMap(t => Object.values(t.coverage.pages).flatMap(p => p.flatMap(a => a.source ? [a.source] : [])));
  return { pages: [...new Map(used.map(s => [s.sourceId, s])).values()], mappings, requests: manifest.pageviewRequests ?? [] };
}
export function compactSources(manifest: Manifest) {
  const links = sourceLinks(manifest);
  return { pages: links.pages.map(sourceSummary), mappings: links.mappings.map(m => ({ ...m, candidates: m.candidates.map(sourceSummary) })), requestCount: links.requests.length, requestArtifact: 'manifest.json#pageviewRequests' };
}
