import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { executeOperation, errorOutput } from '../src/operations/index.js';
import { createServices } from '../src/research.js';
import { AppError } from '../src/errors.js';
import { inputPath } from '../src/environment.js';

try {
  const { values, positionals } = parseArgs({ options: { input: { type: 'string' }, run: { type: 'string' } }, allowPositionals: true, strict: true });
  if (positionals.length !== 1) throw new AppError('INVALID_ARGUMENTS', 'Вкажіть одну операцію: resolve, review, sources, discover, plan, research, analyze, inspect, revise або report.');
  const name = positionals[0]!;
  if (name !== 'inspect' && name !== 'report' && !values.input) throw new AppError('INPUT_REQUIRED', 'Вкажіть JSON-файл через --input.');
  let input: unknown = {};
  if (values.input) {
    let body: string;
    try { body = await readFile(inputPath(values.input), 'utf8'); }
    catch { throw new AppError('INPUT_READ_ERROR', 'Не вдалося прочитати вхідний JSON-файл.', { path: values.input }); }
    try { input = JSON.parse(body); }
    catch { throw new AppError('INVALID_JSON', 'Вхідний файл містить невалідний JSON.'); }
  }
  const result = await executeOperation(name, input, createServices(), values.run);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'error') process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify(errorOutput(error))}\n`); process.exitCode = 1;
}
