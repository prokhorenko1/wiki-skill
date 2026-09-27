import { z } from 'zod';

export const SCHEMA_VERSION = '1.0.0';
export const METHODOLOGY_VERSION = '3.0.0';
export const idSchema = z.uuid();
export const qidSchema = z.string().regex(/^Q[1-9]\d*$/);
export const languageSchema = z.string().regex(/^[a-z]{2,12}(?:-[a-z0-9]{1,12}){0,2}$/);
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Невалідна календарна дата.');
export const periodSchema = z.strictObject({ start: dateSchema, end: dateSchema });
export const filtersSchema = z.strictObject({
  access: z.enum(['all-access', 'desktop', 'mobile-app', 'mobile-web']).default('all-access'),
  agent: z.enum(['user', 'all-agents', 'spider', 'automated']).default('user'),
});
export const criterionSchema = z.enum(['views', 'yearOverYear', 'relativeInterestChange']);
const languagesSchema = z.array(languageSchema).min(1).max(12).refine(v => new Set(v).size === v.length, 'Мови не повинні повторюватися.');
export const conceptSchema = z.strictObject({ qid: qidSchema, resolutionId: idSchema.optional() });
export const topicSchema = z.strictObject({
  topicId: z.string().regex(/^[a-z][a-z0-9-]{0,159}$/), label: z.string().trim().min(1).max(500),
  concepts: z.array(conceptSchema).min(1).max(30),
});
const topicsSchema = z.array(topicSchema).min(1).max(5).refine(v => new Set(v.map(t => t.topicId)).size === v.length, 'topicId має бути унікальним.');
const sourceFields = {
  source: z.enum(['live', 'offline', 'fixtures']).default('live'),
  fixtureId: z.literal('demo-v1').optional(),
  cachePolicy: z.enum(['reuse', 'refresh']).default('reuse'),
};
function validSource(value: { source: string; fixtureId?: string; cachePolicy: string }) {
  return (value.source === 'fixtures') === Boolean(value.fixtureId) && !(value.source === 'offline' && value.cachePolicy === 'refresh');
}
export const resolveSchema = z.strictObject({
  query: z.string().trim().min(1).max(300).optional(), qid: qidSchema.optional(), articleUrl: z.string().url().max(2000).optional(),
  queryLanguage: languageSchema, languages: languagesSchema, ...sourceFields,
}).refine(v => [v.query, v.qid, v.articleUrl].filter(Boolean).length === 1, 'Задайте рівно одне з query, qid або articleUrl.')
  .refine(validSource, 'fixtures потребує fixtureId; offline не підтримує refresh.');
export const analyzeSchema = z.strictObject({
  sourceResolutionIds: z.array(idSchema).max(100).optional(),
  recoverGaps: z.boolean().optional(),
  mode: z.enum(['article', 'topic']).optional(), topicPlanId: idSchema.optional(),
  topics: topicsSchema.optional(), languages: languagesSchema, queryLanguage: languageSchema.default('uk'),
  period: periodSchema.optional(), filters: filtersSchema.default({ access: 'all-access', agent: 'user' }),
  criterion: criterionSchema.default('views'), ...sourceFields,
}).refine(validSource, 'fixtures потребує fixtureId; offline не підтримує refresh.')
  .refine(v => v.mode === 'topic' ? Boolean(v.topicPlanId) : Boolean(v.topics) && !v.topicPlanId, 'topic потребує topicPlanId; article потребує topics.')
  .refine(v => v.mode !== 'article' || v.topics?.every(t => new Set(t.concepts.map(c => c.qid)).size === 1), 'article описує одну концепцію в кожному рядку.');
export const inspectSchema = z.strictObject({ verifySnapshots: z.boolean().default(true), view: z.enum(['summary', 'findings']).default('summary'), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(14).default(7) });
export const reviseSchema = z.strictObject({
  mode: z.enum(['revise', 'replay']).default('revise'),
  changes: z.strictObject({
    topics: topicsSchema.optional(), languages: languagesSchema.optional(), queryLanguage: languageSchema.optional(),
    period: periodSchema.optional(), filters: filtersSchema.optional(), criterion: criterionSchema.optional(),
    topicPlanId: idSchema.optional(),
  }).default({}),
  source: z.enum(['live', 'offline', 'fixtures']).optional(),
  cachePolicy: z.enum(['reuse', 'refresh']).default('reuse'),
}).refine(v => v.mode !== 'replay' || (Object.keys(v.changes).length === 0 && !v.source && v.cachePolicy === 'reuse'), 'replay не допускає змін параметрів.');
export const warningSchema = z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()).optional() });
export const outputSchema = z.object({
  status: z.enum(['ok', 'partial', 'needs_selection', 'error']),
  identifiers: z.record(z.string(), z.string()), summary: z.record(z.string(), z.unknown()),
  warnings: z.array(warningSchema), artifacts: z.array(z.object({ kind: z.string(), path: z.string() })),
  nextAction: z.object({ operation: z.string().nullable(), message: z.string() }),
  error: z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()) }).optional(),
});
export type Period = z.infer<typeof periodSchema>;
export type Filters = z.infer<typeof filtersSchema>;
export type Criterion = z.infer<typeof criterionSchema>;
export type AnalyzeInput = z.infer<typeof analyzeSchema>;
export type ResolveInput = z.infer<typeof resolveSchema>;
export type ReviseInput = z.infer<typeof reviseSchema>;
export type Warning = z.infer<typeof warningSchema>;
export type Output = z.infer<typeof outputSchema>;
export type Topic = z.infer<typeof topicSchema>;
export type SourceOptions = Pick<AnalyzeInput, 'source' | 'fixtureId' | 'cachePolicy'>;

export function warning(code: string, message: string, details?: Record<string, unknown>): Warning {
  return { code, message, ...(details ? { details } : {}) };
}
