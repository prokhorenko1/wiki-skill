import { z } from 'zod';
import { analyzeSchema, resolveSchema, inspectSchema, reviseSchema, outputSchema, idSchema, type Output } from '../schemas.js';
import { asError, AppError } from '../errors.js';
import { analyzeOperation, resolveOperation, reviseOperation, readRun, runOutput, type Services } from '../research.js';
import { reportOperation, reportSchema } from '../reporting/report.js';
import { analysisSchema, buildAnalysis } from '../analysis.js';
import { discoverSchema, planInputSchema } from '../topic-plan.js';
import { discoverOperation, planOperation } from '../discovery.js';
import { researchOperation, researchSchema } from '../completion.js';
import { reviewOperation, reviewSchema, sourcesOperation, sourcesSchema } from '../source-operations.js';

export interface Operation {
  name: string; inputSchema: z.ZodType; outputSchema: typeof outputSchema;
  runRequired: boolean;
  execute: (input: unknown, services: Services, runId?: string) => Promise<Output>;
}
export const operations: Record<string, Operation> = {
  review: { name: 'review', inputSchema: reviewSchema, outputSchema, runRequired: false, execute: (input, services) => reviewOperation(reviewSchema.parse(input), services) },
  sources: { name: 'sources', inputSchema: sourcesSchema, outputSchema, runRequired: true, execute: (input, services, runId) => sourcesOperation(idSchema.parse(runId), sourcesSchema.parse(input), services) },
  research: { name: 'research', inputSchema: researchSchema, outputSchema, runRequired: false, execute: (input, services) => researchOperation(researchSchema.parse(input), services) },
  discover: { name: 'discover', inputSchema: discoverSchema, outputSchema, runRequired: false, execute: (input, services) => discoverOperation(discoverSchema.parse(input), services) },
  plan: { name: 'plan', inputSchema: planInputSchema, outputSchema, runRequired: false, execute: (input, services) => planOperation(planInputSchema.parse(input), services) },
  report: { name: 'report', inputSchema: reportSchema, outputSchema, runRequired: true, execute: (input, services, runId) => reportOperation(idSchema.parse(runId), reportSchema.parse(input), services) },
  resolve: { name: 'resolve', inputSchema: resolveSchema, outputSchema, runRequired: false, execute: (input, services) => resolveOperation(resolveSchema.parse(input), services, input) },
  analyze: { name: 'analyze', inputSchema: analyzeSchema, outputSchema, runRequired: false, execute: (input, services) => analyzeOperation(analyzeSchema.parse(input), services, { originalRequest: input }) },
  inspect: { name: 'inspect', inputSchema: inspectSchema, outputSchema, runRequired: true, execute: async (input, services, runId) => {
    const request = inspectSchema.parse(input), id = idSchema.parse(runId);
    const { manifest, dataset } = await readRun(id, services, request.verifySnapshots);
    const result = runOutput(manifest, services);
    if (manifest.topicPlan && manifest.analysisChecksum) {
      const saved = await services.store.read(['runs', id, 'analysis.json'], analysisSchema);
      result.summary.topic = saved.topicStudy?.languages.map(l => ({ language: l.language, conclusion: l.conclusion, comparisons: l.comparisons, quality: l.quality, coveragePercent: l.coveragePercent }));
      if (saved.topicStudy?.languages.some(l => l.quality.stability !== 'stable')) result.status = 'partial';
    }
    if (request.view === 'findings') {
      const analysis = manifest.analysisChecksum ? await services.store.read(['runs', id, 'analysis.json'], analysisSchema) : buildAnalysis(manifest, dataset);
      const findings = analysis.findings.slice(request.offset, request.offset + request.limit);
      result.summary = { source: analysis.source, period: analysis.period, criterion: analysis.criterion, findings, total: analysis.findings.length,
        offset: request.offset, nextOffset: request.offset + findings.length < analysis.findings.length ? request.offset + findings.length : null,
        evidence: analysis.evidence.filter(e => findings.some(f => f.evidenceId === e.id)).map(e => ({ ...e, sourceIds: e.sourceIds.slice(0, 3), sourceCount: e.sourceIds.length })),
        sourceReferences: 'Повні sourceIds, URL, час та контрольні суми — в analysis.json; тут до трьох sourceIds на evidence.',
        articleSources: result.summary.articleSources,
        limitations: analysis.limitations, hypotheses: analysis.hypotheses };
    }
    return result;
  } },
  revise: { name: 'revise', inputSchema: reviseSchema, outputSchema, runRequired: true, execute: (input, services, runId) => reviseOperation(idSchema.parse(runId), reviseSchema.parse(input), services) },
};
export function errorOutput(error: unknown): Output {
  const problem = asError(error);
  return { status: 'error', identifiers: {}, summary: {}, warnings: [], artifacts: [], nextAction: { operation: null, message: 'Виправте причину помилки та повторіть операцію.' }, error: { code: problem.code, message: problem.message, details: problem.details } };
}
export async function executeOperation(name: string, input: unknown, services: Services, runId?: string): Promise<Output> {
  try {
    const operation = Object.hasOwn(operations, name) ? operations[name] : undefined;
    if (!operation) throw new AppError('UNKNOWN_OPERATION', 'Невідома операція. Доступні resolve, review, sources, discover, plan, research, analyze, inspect, revise, report.');
    if (operation.runRequired && !runId) throw new AppError('RUN_REQUIRED', 'Для операції потрібен --run.');
    if (!operation.runRequired && runId) throw new AppError('UNEXPECTED_RUN', 'Ця операція не приймає --run.');
    operation.inputSchema.parse(input);
    return operation.outputSchema.parse(await operation.execute(input, services, runId));
  } catch (error) { return outputSchema.parse(errorOutput(error)); }
}
