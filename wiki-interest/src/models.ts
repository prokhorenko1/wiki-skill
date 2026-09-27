import { z } from 'zod';
import { analyzeSchema, idSchema, periodSchema, topicSchema, warningSchema, SCHEMA_VERSION, METHODOLOGY_VERSION } from './schemas.js';
import { articleSchema, candidateSchema } from './resolver.js';
import { dailyPointSchema, seriesSchema } from './series.js';
import { calculationSchema } from './calculations.js';
import { snapshotRefSchema } from './storage.js';
import { diagnosticSchema } from './diagnostics.js';
import { topicPlanSchema } from './topic-plan.js';
import { completionSchema } from './completion-types.js';
import { recoverySchema } from './recovery.js';
import { pageviewRequestSchema } from './source-links.js';

export const coverageSchema = z.object({
  topicId: z.string(), label: z.string(), includedQids: z.array(z.string()), excludedQids: z.array(z.string()),
  matrix: z.array(z.object({ qid: z.string(), languages: z.record(z.string(), articleSchema.shape.status) })),
  pages: z.record(z.string(), z.array(articleSchema)), warnings: z.array(warningSchema),
});
export const resolutionSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION), resolutionId: idSchema, createdAt: z.iso.datetime(),
  source: z.enum(['live', 'offline', 'fixtures']), query: z.unknown(), candidates: z.array(candidateSchema), snapshots: z.array(snapshotRefSchema),
});
export const datasetSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION), period: periodSchema, series: z.array(seriesSchema),
  topics: z.array(z.object({ topicId: z.string(), language: z.string(), points: z.array(dailyPointSchema) })),
});
export type Dataset = z.infer<typeof datasetSchema>;
export const manifestSchema = z.object({
  pageviewRequests: z.array(pageviewRequestSchema).optional(),
  completion: completionSchema.optional(),
  schemaVersion: z.literal(SCHEMA_VERSION), methodologyVersion: z.enum(['1.0.0', '3.0.0']),
  topicPlan: topicPlanSchema.optional(), artifactChecksums: z.record(z.string(), z.string()).optional(),
  runId: idSchema, parentRunId: idSchema.optional(), createdAt: z.iso.datetime(),
  mode: z.enum(['analyze', 'revise', 'replay']), source: z.enum(['wikimedia', 'fixtures']),
  originalRequest: z.unknown(), request: analyzeSchema,
  topics: z.array(z.object({ topic: topicSchema, candidates: z.array(candidateSchema), coverage: coverageSchema })),
  report: z.array(z.object({ topicId: z.string(), language: z.string(), metrics: calculationSchema, recovery: recoverySchema.optional() })),
  warnings: z.array(warningSchema), snapshots: z.array(snapshotRefSchema),
  seriesChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  analysisChecksum: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  diagnosticVersion: z.enum(['2.0.0', '3.0.0']).optional(),
  diagnostics: z.array(diagnosticSchema.pick({ kind: true, status: true, reasons: true }).extend({ id: z.string() })).optional(),
  dataAccess: z.object({ cacheHits: z.number().int(), fetched: z.number().int(), replayed: z.number().int() }),
});
export type Manifest = z.infer<typeof manifestSchema>;
