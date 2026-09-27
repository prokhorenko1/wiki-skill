import { afterEach, expect, it, vi } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkEnvironment, resolveWikimediaIdentity, hasUserAgentContact, inputPath, runtimeRoot, skillRoot, validUserAgent } from '../src/environment.js';
import { assertSmokeSelection, runLiveSmoke } from '../src/smoke-live.js';
import { createServices } from '../src/research.js';
import { FileStore } from '../src/storage.js';
import type { Candidate } from '../src/resolver.js';

const temporary: string[] = [];
async function temp() { const root = await mkdtemp(join(await realpath(tmpdir()), 'wiki interest portable ')); temporary.push(root); return root; }
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true }); });

it('doctor працює без залежностей і не показує контакт, не встановлює пакети й не звертається до мережі', async () => {
  const root = await temp();
  await mkdir(join(root, 'src')); await mkdir(join(root, 'scripts'));
  await cp(join(skillRoot, 'src/environment.ts'), join(root, 'src/environment.ts'));
  await cp(join(skillRoot, 'scripts/doctor.ts'), join(root, 'scripts/doctor.ts'));
  await cp(join(skillRoot, 'package.json'), join(root, 'package.json'));
  const response = spawnSync(process.execPath, [join(root, 'scripts/doctor.ts')], { cwd: '/', encoding: 'utf8', env: { ...process.env, WIKIMEDIA_USER_AGENT: 'test/1.0 (private@contact.invalid)' } });
  expect(response.status).toBe(1);
  const output = JSON.parse(response.stdout);
  expect(output.summary.checks).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'DEPENDENCY_MISSING' }), expect.objectContaining({ code: 'BROWSER_UNAVAILABLE' })]));
  expect(response.stdout).not.toContain('private@');
  expect(await readdir(join(root, 'runtime'))).toEqual([]);
  expect(await readdir(root)).not.toContain('node_modules');
});
it('doctor відхиляє несумісний Node і небезпечний runtime symlink', async () => {
  const root = await temp(), target = await temp();
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', dependencies: {}, devDependencies: {} }));
  await symlink(target, join(root, 'runtime'));
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('forbidden'));
  const result = await checkEnvironment({ root, nodeVersion: '22.19.0', userAgent: '' });
  expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'NODE_UNSUPPORTED' }), expect.objectContaining({ code: 'WRITE_UNAVAILABLE' }), expect.objectContaining({ status: 'blocked', code: 'USER_AGENT_INVALID' })]));
  expect(fetch).not.toHaveBeenCalled(); expect(await readdir(target)).toEqual([]);
});
it('ідентифікація потребує контакту й відхиляє placeholders та перенесення рядка', () => {
  expect(validUserAgent(undefined)).toBe(false); expect(validUserAgent('x/1.0 (YOUR_REAL_CONTACT)')).toBe(false);
  expect(validUserAgent('x/1.0 (https://example.org)')).toBe(false); expect(validUserAgent('x/1.0\ncontact@host.test')).toBe(false);
  expect(validUserAgent('unit-test/1.0 (mailto:tester@unit-fixture.dev)')).toBe(true);
  expect(validUserAgent('wiki-interest/0.1.0')).toBe(false); expect(hasUserAgentContact('wiki-interest/0.1.0')).toBe(false);
  expect(hasUserAgentContact('unit-test/1.0 (mailto:tester@host.test)')).toBe(false);
});
it('doctor відрізняє незаданий ENV від відсутньої ідентифікації та показує джерело', async () => {
  vi.stubEnv('WIKIMEDIA_USER_AGENT', undefined);
  const result = await checkEnvironment();
  const expected = resolveWikimediaIdentity();
  expect(result.liveReady).toBe(expected.valid);
  expect(result.wikimediaIdentity).toMatchObject({ source: 'package', valid: expected.valid });
  expect(result.checks).toContainEqual(expect.objectContaining({ code: 'OPTIONAL_ENV_NOT_SET', status: 'passed' }));
  const root = await temp(); await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'test-app', version: '1.0', dependencies: {}, devDependencies: {} }));
  const missing = await checkEnvironment({ root });
  expect(missing.checks).toContainEqual(expect.objectContaining({ code: 'USER_AGENT_CONTACT_MISSING', status: 'blocked' }));
});
it('offline doctor не потребує придатної мережевої ідентифікації', async () => {
  vi.stubEnv('WIKIMEDIA_USER_AGENT', '');
  const result = await checkEnvironment();
  expect(result.offlineReady).toBe(true); expect(result.liveReady).toBe(false);
  const response = spawnSync(process.execPath, [join(skillRoot, 'scripts/doctor.ts'), '--offline'], { encoding: 'utf8', env: { ...process.env, WIKIMEDIA_USER_AGENT: '' } });
  expect(response.status).toBe(0); expect(JSON.parse(response.stdout).status).toBe('ok');
});
it('npm --prefix і прямий CLI працюють з іншої cwd; вхід із пробілами та корінь через symlink', async () => {
  const root = await temp(), alias = join(root, 'skill with spaces');
  await symlink(skillRoot, alias);
  const relativeInput = spawnSync('npm', ['--prefix', alias, 'run', '--silent', 'cli', '--', 'analyze', '--input', 'examples/report-en.json'], { cwd: root, encoding: 'utf8' });
  expect(relativeInput.status).toBe(1);
  expect(JSON.parse(relativeInput.stdout).error.code).toBe('VALIDATION_ERROR');
  const input = join(root, 'input with spaces.json'); await writeFile(input, '{}');
  const direct = spawnSync(process.execPath, ['--import', join(skillRoot, 'node_modules/tsx/dist/loader.mjs'), join(alias, 'scripts/cli.ts'), 'analyze', '--input', input], { cwd: root, encoding: 'utf8' });
  expect(JSON.parse(direct.stdout).error.code).toBe('VALIDATION_ERROR');
  expect(inputPath('examples/analyze.json')).toBe(join(skillRoot, 'examples/analyze.json'));
  expect(inputPath(input)).toBe(input); expect(runtimeRoot).toBe(join(skillRoot, 'runtime'));
});
it('smoke зберігає blocked за некоректної конфігурації, не використовує fixtures і не надсилає запитів', async () => {
  const root = await temp(), get = vi.fn().mockRejectedValue(new Error('forbidden'));
  const services = createServices({ store: new FileStore(root), transport: { get }, fixtureTransport: { get }, log: () => {} });
  const result = await runLiveSmoke(services, async () => ({ schemaVersion: '1.0.0', nodeVersion: '24.21.0', skillRoot, runtimeRoot, offlineReady: true, liveReady: false, wikimediaIdentity: { source: 'environment', detail: 'test', valid: false }, checks: [{ id: 'wikimediaUserAgent', status: 'blocked', code: 'USER_AGENT_INVALID', message: 'test' }] }));
  expect(result).toMatchObject({ status: 'blocked', runId: null, logicalRequests: 0, error: { code: 'USER_AGENT_INVALID' } });
  expect(get).not.toHaveBeenCalled(); expect(JSON.parse(await readFile(result.artifact!, 'utf8')).status).toBe('blocked');
});
it('smoke обирає перевірений QID за змістом, а не перший результат', () => {
  const candidate: Candidate = { qid: 'Q333', requestedQid: 'Q333', label: 'astronomy', description: 'natural science studying celestial objects', labelLanguage: 'en', warnings: [], articles: [{ language: 'uk', project: 'uk.wikipedia.org', siteId: 'ukwiki', originalTitle: 'Астрономія', title: 'Астрономія', pageId: 1, normalized: [], redirects: [], status: 'found' }] };
  expect(assertSmokeSelection([{ ...candidate, qid: 'Q1', label: 'other' }, candidate])).toBe(candidate);
  expect(() => assertSmokeSelection([{ ...candidate, description: 'different concept' }])).toThrow(/не підтвердив/);
  expect(() => assertSmokeSelection([{ ...candidate, articles: [] }])).toThrow(/не завершилася/);
});
