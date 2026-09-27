import { z } from 'zod';
import { idSchema, qidSchema, languageSchema, periodSchema, filtersSchema } from './schemas.js';
import { candidateSchema, articleSchema } from './resolver.js';
import { snapshotRefSchema } from './storage.js';

const label = z.string().trim().min(1).max(300);
const slug = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const discoverSchema = z.strictObject({
  query: label, queryLanguage: languageSchema.default('uk'), languages: z.array(languageSchema).min(1).max(10),
  seedQids: z.array(qidSchema).max(30).default([]), searchTerms: z.array(label).max(8).default([]),
  pageTitles: z.array(label).max(30).default([]),
  linkTitles: z.array(label).max(5).default([]), categoryTitles: z.array(label).max(5).default([]),
  limits: z.strictObject({ candidates: z.number().int().min(1).max(80).default(40), depth: z.number().int().min(0).max(2).default(1), requests: z.number().int().min(1).max(400).default(160) }).default({ candidates: 40, depth: 1, requests: 160 }),
  source: z.enum(['live', 'offline', 'fixtures']).default('live'), fixtureId: z.literal('demo-v1').optional(), cachePolicy: z.enum(['reuse', 'refresh']).default('reuse'),
}).refine(v => (v.source === 'fixtures') === Boolean(v.fixtureId) && !(v.source === 'offline' && v.cachePolicy === 'refresh'), 'Неузгоджене джерело discovery.');
export const discoveredCandidateSchema = z.object({
  candidateId: z.string(), qid: qidSchema.nullable(), label: z.string(), description: z.string().nullable(), aliases: z.array(z.string()),
  sources: z.array(z.object({ kind: z.enum(['seed', 'wikidata', 'search', 'link', 'category']), value: z.string(), snapshotIds: z.array(z.string()) })),
  articles: z.array(articleSchema), verified: candidateSchema.optional(), subtopic: z.string().nullable(),
  status: z.enum(['proposed', 'selected', 'excluded']), reason: z.string(),
});
export const discoverySchema = z.object({
  schemaVersion: z.literal('3.0.0'), discoveryId: idSchema, createdAt: z.iso.datetime(), request: discoverSchema,
  candidates: z.array(discoveredCandidateSchema), snapshots: z.array(snapshotRefSchema),
  discoveryTruncated: z.boolean(), truncationReasons: z.array(z.string()), logicalRequests: z.number(),
  metadataBasis: z.literal('current_metadata_not_historical_membership'),
});
export type Discovery = z.infer<typeof discoverySchema>;
export const planInputSchema = z.strictObject({
  discoveryId: idSchema, parentPlanId: idSchema.optional(), basketId: slug, label,
  question: z.string().min(1).max(700), productContext: z.string().min(1).max(700), boundaries: z.string().min(1).max(1200),
  subtopics: z.array(z.strictObject({ id: slug, label, rationale: z.string().min(1).max(500) })).min(1).max(8),
  decisions: z.array(z.strictObject({ candidateId: z.string(), status: z.enum(['selected', 'excluded']), reason: z.string().min(1).max(600), role: z.enum(['root', 'core', 'extended']).optional(), subtopic: slug.optional() })).min(1).max(80),
  period: periodSchema, filters: filtersSchema.default({ access: 'all-access', agent: 'user' }),
  assumptions: z.array(z.string().min(1).max(700)).min(1).max(12), limitations: z.array(z.string().min(1).max(700)).min(1).max(12),
});
export const topicPlanSchema = z.object({
  schemaVersion: z.literal('3.0.0'), methodologyVersion: z.literal('3.0.0'), planId: idSchema, parentPlanId: idSchema.optional(),
  compositionVersion: z.string(), frozenAt: z.iso.datetime(), basketId: slug, label, question: z.string(), productContext: z.string(), boundaries: z.string(),
  subtopics: planInputSchema.shape.subtopics, languages: z.array(languageSchema), queryLanguage: languageSchema, period: periodSchema, filters: filtersSchema,
  members: z.array(z.object({ candidateId: z.string(), qid: qidSchema, role: z.enum(['root', 'core', 'extended']), subtopic: z.string().nullable(), reason: z.string() })),
  decisions: z.array(discoveredCandidateSchema), discovery: discoverySchema,
  assumptions: z.array(z.string()), limitations: z.array(z.string()), comparisonRules: z.array(z.string()),
});
export type TopicPlan = z.infer<typeof topicPlanSchema>;
