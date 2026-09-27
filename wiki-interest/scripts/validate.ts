import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { operations } from '../src/operations/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const skill = await readFile(resolve(root, 'SKILL.md'), 'utf8');
const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill);
assert(frontmatter, 'SKILL.md потребує YAML frontmatter.');
const metadata = parse(frontmatter[1]!) as Record<string, unknown>;
assert.equal(metadata.name, basename(root));
assert.equal(metadata.name, 'wiki-interest');
assert(typeof metadata.description === 'string' && metadata.description.length > 0 && metadata.description.length <= 1024);
assert(typeof metadata.compatibility === 'string' && metadata.compatibility.length > 0 && metadata.compatibility.length <= 500);
assert(skill.split('\n').length < 500);
assert(!/TODO|TBD|PLACEHOLDER/.test(skill), 'SKILL.md містить незавершений шаблон.');
for (const match of skill.matchAll(/\]\(([^)]+)\)/g)) if (!/^https?:/.test(match[1]!)) await access(resolve(root, match[1]!));
const operationByFile: Record<string, string> = {
  'resolve-keto.json': 'resolve', 'sources-historical.json': 'sources', 'sources-refresh.json': 'sources',
  'research.json': 'research',
  'discover-topic.json': 'discover',
  'resolve.json': 'resolve', 'resolve-fixtures.json': 'resolve', 'analyze.json': 'analyze', 'offline.json': 'analyze',
  'demo-offline.json': 'analyze', 'revise.json': 'revise', 'refresh.json': 'revise', 'replay.json': 'revise',
  'report.json': 'report', 'report-en.json': 'report', 'report-ru.json': 'report',
  'inspect-findings.json': 'inspect', 'resolve-astronomy.json': 'resolve', 'revise-views.json': 'revise', 'add-language.json': 'revise',
};
for (const filename of await readdir(resolve(root, 'examples'))) {
  const operation = operationByFile[filename]; assert(operation, `Не визначена схема прикладу ${filename}`);
  operations[operation]!.inputSchema.parse(JSON.parse(await readFile(resolve(root, 'examples', filename), 'utf8')));
}
for (const folder of ['scripts', 'src', 'references', 'tests/fixtures', 'examples']) await access(resolve(root, folder));
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
const documents = ['SKILL.md', 'README.md', ...(await readdir(resolve(root, 'references'))).filter(f => f.endsWith('.md')).map(f => `references/${f}`)];
for (const filename of documents) {
  const document = await readFile(resolve(root, filename), 'utf8');
  for (const match of document.matchAll(/\]\(([^)]+)\)/g)) {
    const link = match[1]!;
    if (!/^https?:|^#/.test(link)) await access(resolve(root, dirname(filename), link.split('#')[0]!));
  }
  for (const match of document.matchAll(/npm(?: --prefix "[^"]+")? run(?: --silent)? ([\w:]+)/g)) assert(Object.hasOwn(pkg.scripts, match[1]!), `Невідомий npm script у ${filename}: ${match[1]}`);
  for (const match of document.matchAll(/cli -- (\w+)/g)) assert(Object.hasOwn(operations, match[1]!), `Невідома CLI операція у ${filename}: ${match[1]}`);
  for (const match of document.matchAll(/--input (examples\/[\w.-]+\.json)/g)) assert(Object.hasOwn(operationByFile, basename(match[1]!)), `Невідомий приклад у ${filename}: ${match[1]}`);
}
const evaluation = JSON.parse(await readFile(resolve(root, 'references/evaluation-results.template.json'), 'utf8')) as { status: string; cases: { status: string }[] };
assert.equal(evaluation.status, 'not_run'); assert.equal(evaluation.cases.length, 18);
assert(evaluation.cases.every(c => c.status === 'not_run'), 'Шаблон модельних перевірок не є звітом виконання.');
assert.equal((await readFile(resolve(root, '.nvmrc'), 'utf8')).trim(), '24.21.0');
console.log('Навичка, відносні посилання та всі JSON-приклади валідні.');
