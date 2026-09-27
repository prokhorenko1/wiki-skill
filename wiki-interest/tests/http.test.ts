import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../src/http.js';
import { assertAllowedUrl, requestUrl, type ApiRequest } from '../src/requests.js';

const request: ApiRequest = { kind: 'site', language: 'uk' };
// Syntactic identities for injected fetch mocks; these contacts are never sent to the network.
const userAgent = 'wiki-interest-tests/1.0 (https://contact.unit-fixture.dev)';
afterEach(() => vi.unstubAllEnvs());
describe('HTTP-клієнт', () => {
  it('враховує Retry-After 429 у секундах', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': '2' } })).mockResolvedValueOnce(new Response('{}'));
    const sleep = vi.fn(async () => {});
    await new HttpClient({ userAgent, fetch: fetcher, sleep }).get(request);
    expect(sleep).toHaveBeenCalledWith(2000); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('враховує Retry-After як HTTP-дату', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': 'Fri, 01 Jan 2021 00:00:03 GMT' } })).mockResolvedValueOnce(new Response('{}'));
    const sleep = vi.fn(async () => {});
    await new HttpClient({ userAgent, fetch: fetcher, sleep, clock: { now: () => new Date('2021-01-01T00:00:00Z') } }).get(request);
    expect(sleep).toHaveBeenCalledWith(3000);
  });
  it('не надсилає наступні запити до завершення довгого Retry-After', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 429, headers: { 'retry-after': '120' } }));
    const client = new HttpClient({ userAgent, fetch: fetcher });
    await expect(client.get(request)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(client.get(request)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('перериває timeout через AbortController і обмежує повтори', async () => {
    const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
    await expect(new HttpClient({ userAgent, fetch: fetcher, timeoutMs: 5, sleep: async () => {} }).get(request)).rejects.toMatchObject({ code: 'HTTP_TIMEOUT' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });
  it('не повторює 404 і не прирівнює його до відсутності статті', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 404 }));
    await expect(new HttpClient({ userAgent, fetch: fetcher }).get(request)).rejects.toMatchObject({ code: 'DATA_NOT_FOUND' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('обробляє помилку Action API всередині HTTP 200', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"error":{"code":"badvalue","info":"bad"}}'));
    await expect(new HttpClient({ userAgent, fetch: fetcher }).get(request)).rejects.toMatchObject({ code: 'API_ERROR' });
  });
  it('повторює maxlag і тимчасову 503', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{"error":{"code":"maxlag"}}')).mockResolvedValueOnce(new Response('{}', { status: 503 })).mockResolvedValueOnce(new Response('{}'));
    await new HttpClient({ userAgent, fetch: fetcher, sleep: async () => {} }).get(request);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('перевіряє JSON і User-Agent', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new HttpClient({ userAgent: 'bad/1.0\r\nInjected: value', fetch: fetcher }).get(request)).rejects.toMatchObject({ code: 'USER_AGENT_INVALID' });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(new HttpClient({ userAgent, fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('html')) }).get(request)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('ENV має пріоритет над наявною конфігурацією клієнта', async () => {
    const override = 'custom-client/2.0 (https://contact.unit-fixture.dev)';
    vi.stubEnv('WIKIMEDIA_USER_AGENT', override);
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}'));
    await new HttpClient({ userAgent, fetch: fetcher }).get(request);
    expect(fetcher.mock.lastCall?.[1]?.headers).toMatchObject({ 'User-Agent': override });
  });
  it('порожні та placeholder-перевизначення відхиляються до мережі', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const value of ['', '   ', 'bad/1.0 (https://example.org)', 'bad/1.0 (someone@host.invalid)']) {
      vi.stubEnv('WIKIMEDIA_USER_AGENT', value);
      await expect(new HttpClient({ userAgent, fetch: fetcher }).get(request)).rejects.toMatchObject({ code: 'USER_AGENT_INVALID' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('виконує запити послідовно навіть за паралельного виклику', async () => {
    let active = 0, maximum = 0;
    const fetcher = vi.fn<typeof fetch>(async () => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 2)); active--; return new Response('{}'); });
    const client = new HttpClient({ userAgent, fetch: fetcher });
    await Promise.all([client.get(request), client.get(request), client.get(request)]);
    expect(maximum).toBe(1);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual', headers: { 'User-Agent': userAgent } });
  });
  it('блокує довільні домени, credentials і HTTP redirects', async () => {
    for (const url of ['https://evil.test/a', 'http://uk.wikipedia.org/w/api.php', 'https://uk.wikipedia.org.evil.test/a', 'https://user:secret@uk.wikipedia.org/a']) expect(() => assertAllowedUrl(url)).toThrow();
    await expect(new HttpClient({ userAgent, fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://evil.test' } })) }).get(request)).rejects.toMatchObject({ code: 'HTTP_REDIRECT' });
  });
  it('кодує Unicode, slash, percent і question mark як один сегмент', () => {
    const url = requestUrl({ kind: 'article', language: 'uk', title: 'Астрономія / 100%? #', filters: { access: 'all-access', agent: 'user' }, period: { start: '2021-01-01', end: '2021-01-31' } });
    const encoded = new URL(url).pathname.split('/')[9]!;
    expect(decodeURIComponent(encoded)).toBe('Астрономія_/_100%?_#');
    expect(new URL(url).search).toBe(''); expect(new URL(url).hash).toBe('');
  });
});
