import { afterEach, expect, it, vi } from 'vitest';
import { resolveWikimediaIdentity, type IdentityPackage } from '../src/environment.js';
import { HttpClient } from '../src/http.js';
import type { ApiRequest } from '../src/requests.js';

// Only synthetic metadata for pure validation and injected fetch; never a production default.
const metadata: IdentityPackage = { name: 'unit-client', version: '2.7.1', bugs: { url: 'https://contact.unit-fixture.dev/issues' } };
const expected = 'unit-client/2.7.1 (https://contact.unit-fixture.dev/issues)';
afterEach(() => vi.unstubAllEnvs());

it('без ENV формує стандартний заголовок із name/version/contact package.json', () => {
  expect(resolveWikimediaIdentity({ env: {}, metadata })).toMatchObject({ source: 'package', valid: true, userAgent: expected, detail: 'package.json: name, version, bugs.url' });
  expect(resolveWikimediaIdentity({ env: {}, metadata: { ...metadata, version: '3.0.0' } }).userAgent).toBe('unit-client/3.0.0 (https://contact.unit-fixture.dev/issues)');
});
it('пріоритет ENV → наявна конфігурація програми → пакет', () => {
  const app = 'configured-app/1.0 (https://contact.unit-fixture.dev)', env = 'env-client/4.0 (https://contact.unit-fixture.dev)';
  expect(resolveWikimediaIdentity({ env: {}, metadata, userAgent: app })).toMatchObject({ source: 'application', userAgent: app });
  expect(resolveWikimediaIdentity({ env: { WIKIMEDIA_USER_AGENT: env }, metadata, userAgent: app })).toMatchObject({ source: 'environment', userAgent: env });
});
it('порожні або placeholder-контакти не приймаються й не маскуються fallback', () => {
  for (const value of ['', ' ', 'bad/1.0 (https://example.com)', 'bad/1.0 (https://sub.example.org)', 'bad/1.0 (https://localhost)', 'bad/1.0 (https://127.0.0.1)', 'bad/1.0 (you@host.invalid)', 'bad/1.0 (YOUR_CONTACT)', 'Mozilla/5.0 (https://contact.unit-fixture.dev)']) {
    expect(resolveWikimediaIdentity({ env: { WIKIMEDIA_USER_AGENT: value }, metadata })).toMatchObject({ source: 'environment', valid: false, userAgent: null, code: 'USER_AGENT_INVALID' });
  }
  expect(resolveWikimediaIdentity({ env: {}, metadata: { name: 'unit-client', version: '1.0' } })).toMatchObject({ source: 'package', valid: false, code: 'USER_AGENT_CONTACT_MISSING' });
  expect(resolveWikimediaIdentity({ env: {}, metadata: { ...metadata, bugs: { url: '' } } }).valid).toBe(false);
});
it('усі Wikimedia, MediaWiki та Wikidata endpoint використовують єдину ідентифікацію', async () => {
  vi.stubEnv('WIKIMEDIA_USER_AGENT', undefined);
  const fetcher = vi.fn<typeof fetch>(async () => new Response('{}'));
  const client = new HttpClient({ userAgent: expected, fetch: fetcher });
  const period = { start: '2021-01-01', end: '2021-01-31' }, filters = { access: 'all-access', agent: 'user' } as const;
  const requests: ApiRequest[] = [
    { kind: 'search', query: 'test', language: 'uk' }, { kind: 'entity', qid: 'Q2329', language: 'uk' },
    { kind: 'site', language: 'uk' }, { kind: 'page', title: 'Хімія', language: 'uk' }, { kind: 'wiki-search', query: 'хімія', language: 'uk' },
    { kind: 'links', title: 'Хімія', language: 'uk' }, { kind: 'category', title: 'Категорія:Хімія', language: 'uk' },
    { kind: 'article', title: 'Хімія', language: 'uk', filters, period }, { kind: 'project', language: 'uk', filters, period },
  ];
  for (const request of requests) await client.get(request);
  expect(fetcher).toHaveBeenCalledTimes(9);
  expect(new Set(fetcher.mock.calls.map(([url]) => new URL(String(url)).hostname))).toEqual(new Set(['www.wikidata.org', 'uk.wikipedia.org', 'wikimedia.org']));
  for (const [, options] of fetcher.mock.calls) expect(options?.headers).toMatchObject({ 'User-Agent': expected });
});
