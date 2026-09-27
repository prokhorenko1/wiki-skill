import { constants, readFileSync, realpathSync } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Корінь визначається від модуля, включно із запуском через symlink.
export const skillRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
export const runtimeRoot = join(skillRoot, 'runtime');
export const chromiumRoot = join(runtimeRoot, 'browser');
export const inputPath = (value: string): string => isAbsolute(value) ? value : resolve(skillRoot, value);

export interface IdentityPackage { name?: string; version?: string; bugs?: string | { url?: string }; homepage?: string; repository?: string | { url?: string }; author?: { url?: string; email?: string } }
export interface WikimediaIdentity {
  source: 'environment' | 'application' | 'package'; detail: string; valid: boolean;
  userAgent: string | null; code: 'OK' | 'USER_AGENT_INVALID' | 'USER_AGENT_CONTACT_MISSING'; message: string;
}
function packageIdentity(root: string): IdentityPackage {
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as IdentityPackage; }
  catch { return {}; }
}
const placeholder = /YOUR_|your-real|placeholder|<[^>]*>/i;
function publicContactHost(host: string): boolean {
  return host.includes('.') && !/(^|\.)(example\.(com|org|net)|example|invalid|test|localhost|local)$|^[\d.]+$|[:\[\]]/i.test(host);
}
export function hasUserAgentContact(value: string): boolean {
  if (placeholder.test(value)) return false;
  const urls = value.match(/https?:\/\/[^\s);]+/gi) ?? [];
  if (urls.some(raw => { try { const url = new URL(raw); return !url.username && !url.password && publicContactHost(url.hostname); } catch { return false; } })) return true;
  return [...value.matchAll(/[\w.+-]+@([\w.-]+\.[a-z]{2,})/gi)].some(match => publicContactHost(match[1]!));
}
export function validUserAgent(value: string | undefined): boolean {
  if (!value?.trim() || /[^\x20-\x7e]/.test(value) || placeholder.test(value)) return false;
  if (/^(Mozilla|Chrome|Safari|Firefox|curl|python-requests|Python-urllib)\//i.test(value)) return false;
  return /^[\w@.-]+(?:\/[\w.-]+)?\/[\w.-]+(?:\s|$)/.test(value) && hasUserAgentContact(value);
}

// The only header builder: explicit ENV > existing in-process identity > package metadata.
// Presence is distinct from validity: a blank or invalid override never silently falls back.
export function resolveWikimediaIdentity(options: { userAgent?: string; env?: NodeJS.ProcessEnv; root?: string; metadata?: IdentityPackage } = {}): WikimediaIdentity {
  const envValue = (options.env ?? process.env).WIKIMEDIA_USER_AGENT;
  let source: WikimediaIdentity['source'], detail: string, value: string;
  if (envValue !== undefined) { source = 'environment'; detail = 'WIKIMEDIA_USER_AGENT'; value = envValue; }
  else if (options.userAgent !== undefined) { source = 'application'; detail = 'HttpOptions.userAgent'; value = options.userAgent; }
  else {
    source = 'package'; const pkg = options.metadata ?? packageIdentity(options.root ?? skillRoot);
    const contacts = [
      ['bugs.url', typeof pkg.bugs === 'string' ? pkg.bugs : pkg.bugs?.url], ['author.url', pkg.author?.url],
      ['homepage', pkg.homepage], ['repository.url', typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url], ['author.email', pkg.author?.email],
    ] as const;
    const contact = contacts.find(([, v]) => v !== undefined);
    detail = `package.json: name, version, ${contact?.[0] ?? 'contact missing'}`;
    value = pkg.name && pkg.version ? `${pkg.name}/${pkg.version}${contact ? ` (${contact[1]})` : ''}` : '';
  }
  const valid = validUserAgent(value);
  const code = valid ? 'OK' : source === 'package' && !hasUserAgentContact(value) ? 'USER_AGENT_CONTACT_MISSING' : 'USER_AGENT_INVALID';
  return { source, detail, valid, userAgent: valid ? value : null, code, message: valid ? `Ідентифікація Wikimedia придатна; джерело: ${detail}.` : source === 'package' ? 'У package.json немає придатної назви/версії та публічного контакту проєкту. Потрібно завершити метадані пакета; ENV є необов’язковим перевизначенням.' : `Некоректна ідентифікація з ${detail}: потрібні назва/версія й справжній контакт без порожніх значень, placeholders або перенесень рядка.` };
}
export interface EnvironmentCheck { id: string; status: 'passed' | 'warning' | 'blocked'; code: string; message: string }
export async function checkEnvironment(options: { root?: string; nodeVersion?: string; userAgent?: string } = {}) {
  const root = options.root ?? skillRoot, version = options.nodeVersion ?? process.versions.node;
  const identity = resolveWikimediaIdentity({ root, userAgent: options.userAgent });
  const checks: EnvironmentCheck[] = [];
  const add = (id: string, ready: boolean, code: string, message: string) => checks.push({ id, status: ready ? 'passed' : 'blocked', code: ready ? 'OK' : code, message });
  const nodeReady = Number(version.split('.')[0]) === 24;
  add('node', nodeReady, 'NODE_UNSUPPORTED', nodeReady ? `Node.js ${version}: підтримувана гілка 24.` : `Node.js ${version}: потрібна гілка 24; встановіть версію з .nvmrc.`);
  const require = createRequire(join(root, 'package.json'));
  let dependenciesReady = true;
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const ownModules = join(await realpath(root), 'node_modules');
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      try {
        const entry = await realpath(require.resolve(`${name}/package.json`));
        const rel = relative(ownModules, entry);
        if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('outside skill');
      } catch { dependenciesReady = false; add(`dependency:${name}`, false, 'DEPENDENCY_MISSING', `Пакет ${name} не встановлений у цій копії навички. Виконайте npm ci.`); }
    }
  } catch { dependenciesReady = false; add('dependencies', false, 'PACKAGE_INVALID', 'Не вдалося прочитати package.json.'); }
  if (dependenciesReady) add('dependencies', true, 'OK', 'Усі залежності знайдені в node_modules цієї навички.');
  let browserReady = false;
  try {
    process.env.PLAYWRIGHT_BROWSERS_PATH = join(root, 'runtime', 'browser');
    const { chromium } = require('playwright') as typeof import('playwright');
    await access(chromium.executablePath(), constants.X_OK); browserReady = true;
  } catch { /* Нічого не встановлюємо й не запускаємо. */ }
  add('chromium', browserReady, 'BROWSER_UNAVAILABLE', browserReady ? 'Chromium знайдено; запуск і системні бібліотеки перевіряє demo:offline.' : 'Chromium не знайдено. Після npm ci виконайте npm run setup:browser.');
  checks.push({ id: 'wikimediaEnvironment', status: 'passed', code: process.env.WIKIMEDIA_USER_AGENT === undefined ? 'OPTIONAL_ENV_NOT_SET' : 'ENV_OVERRIDE_SET', message: process.env.WIKIMEDIA_USER_AGENT === undefined ? 'Необов’язковий WIKIMEDIA_USER_AGENT не задано; використовується конфігурація програми або метадані пакета.' : 'Необов’язкове ENV-перевизначення задано; його значення не виводиться.' });
  add('wikimediaUserAgent', identity.valid, identity.code, identity.message);
  let writable = false, probe: string | undefined;
  try {
    const runtime = join(root, 'runtime');
    for (let current = runtime; ; current = dirname(current)) {
      try { if ((await lstat(current)).isSymbolicLink()) throw new Error('symlink'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (dirname(current) === current) break;
    }
    await mkdir(runtime, { recursive: true }); probe = await mkdtemp(join(runtime, '.doctor-'));
    await writeFile(join(probe, 'probe'), 'wiki-interest', { flag: 'wx', mode: 0o600 }); writable = true;
  } catch { /* Повідомлення без конфігурації та системних подробиць. */ }
  finally { if (probe) await rm(probe, { recursive: true, force: true }); }
  add('runtimeWrite', writable, 'WRITE_UNAVAILABLE', writable ? 'Тимчасовий запис у runtime успішний, тестовий файл видалено.' : 'Немає безпечного запису в runtime; перевірте права й відсутність symlink усередині сховища.');
  const offlineReady = nodeReady && dependenciesReady && browserReady && writable;
  return { schemaVersion: '1.0.0', nodeVersion: version, skillRoot: root, runtimeRoot: join(root, 'runtime'), offlineReady, liveReady: offlineReady && identity.valid, wikimediaIdentity: { source: identity.source, detail: identity.detail, valid: identity.valid }, checks };
}
