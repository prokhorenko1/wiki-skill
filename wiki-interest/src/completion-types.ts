import { z } from 'zod';
import { languageSchema } from './schemas.js';
import { mappingEvidenceSchema } from './source-evidence.js';

export const languagePolicySchema = z.enum(['strict', 'auto-supplement']);
export const completionSchema = z.object({
  version: z.literal('1.0.0'), researchId: z.uuid(), languagePolicy: languagePolicySchema,
  requestedLanguages: z.array(languageSchema), analyzedRequestedLanguages: z.array(languageSchema),
  unavailableLanguages: z.array(z.object({ language: languageSchema, code: z.string(), reason: z.string(), missingQids: z.array(z.string()).optional() })),
  supplementalLanguages: z.array(languageSchema), selectionReasons: z.array(z.object({ language: languageSchema, selected: z.boolean(), code: z.string(), reason: z.string() })),
  comparisonLanguages: z.array(languageSchema).optional(),
  mapping: z.array(z.object({ qid: z.string(), language: languageSchema, status: z.string(), title: z.string().nullable(), evidence: mappingEvidenceSchema.optional() })),
  requestCompletion: z.enum(['complete', 'partial', 'unavailable']),
  originalPlanId: z.uuid().optional(),
});
export type Completion = z.infer<typeof completionSchema>;
