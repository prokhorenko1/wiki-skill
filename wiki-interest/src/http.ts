import { z } from 'zod';
import { AppError } from './errors.js';
import { assertAllowedUrl, requestUrl, type ApiRequest } from './requests.js';
import { systemClock, type Clock } from './calendar.js';
import { resolveWikimediaIdentity } from './environment.js';

export interface Transport { get(request: ApiRequest): Promise<{ body: string; url: string }> }
export interface HttpOptions {
  userAgent?: string; fetch?: typeof globalThis.fetch; clock?: Clock;
  sleep?: (ms: number) => Promise<void>; timeoutMs?: number; maxAttempts?: number;
  log?: (message: string) => void;
}
const apiErrorSchema = z.object({ error: z.object({ code: z.string(), info: z.string().optional() }).passthrough() }).passthrough();

export class HttpClient implements Transport {
  private queue: Promise<unknown> = Promise.resolve();
  private blockedUntil = 0;
  constructor(private readonly options: HttpOptions = {}) {}
  get(request: ApiRequest): Promise<{ body: string; url: string }> {
    const result = this.queue.then(() => this.request(request));
    this.queue = result.catch(() => {});
    return result;
  }
  private async request(request: ApiRequest): Promise<{ body: string; url: string }> {
    const identity = resolveWikimediaIdentity({ userAgent: this.options.userAgent });
    if (!identity.valid) throw new AppError(identity.code, identity.message, { source: identity.source, detail: identity.detail });
    const userAgent = identity.userAgent!;
    const url = requestUrl(request); assertAllowedUrl(url);
    const fetcher = this.options.fetch ?? globalThis.fetch;
    const clock = this.options.clock ?? systemClock;
    if (clock.now().getTime() < this.blockedUntil) throw new AppError('RATE_LIMITED', 'Нові запити призупинено відповідно до Retry-After.', { retryAt: new Date(this.blockedUntil).toISOString() });
    const sleep = this.options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const attempts = this.options.maxAttempts ?? 3;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);
      let response: Response;
      let body: string;
      try {
        response = await fetcher(url, { signal: controller.signal, redirect: 'manual', headers: { 'User-Agent': userAgent, Accept: 'application/json' } });
        body = await response.text();
      } catch (error) {
        const timeoutError = controller.signal.aborted;
        if (attempt + 1 === attempts) throw new AppError(timeoutError ? 'HTTP_TIMEOUT' : 'NETWORK_ERROR', timeoutError ? 'Час очікування Wikimedia API вичерпано.' : 'Wikimedia API недоступний.', { url, attempts, cause: String(error) });
        clearTimeout(timeout);
        this.options.log?.('Тимчасовий збій запиту; повторюю.');
        await sleep(500 * 2 ** attempt); continue;
      } finally { clearTimeout(timeout); }
      if (response.status >= 300 && response.status < 400) throw new AppError('HTTP_REDIRECT', 'Неочікуване HTTP-перенаправлення API; запит зупинено.', { url, status: response.status });
      let apiCode: string | undefined;
      try { const parsed = apiErrorSchema.safeParse(JSON.parse(body)); if (parsed.success) apiCode = parsed.data.error.code; } catch { /* Перевірка JSON нижче. */ }
      const temporary = [429, 500, 502, 503, 504].includes(response.status) || apiCode === 'maxlag' || apiCode === 'ratelimited';
      if (temporary) {
        const retryAfter = response.headers.get('retry-after');
        const delay = retryAfter === null ? 500 * 2 ** attempt : /^\d+(?:\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - clock.now().getTime();
        const wait = Number.isFinite(delay) ? Math.max(0, delay) : 500 * 2 ** attempt;
        const retryAt = new Date(clock.now().getTime() + wait).toISOString();
        if (wait > 60_000 || attempt + 1 === attempts) {
          this.blockedUntil = clock.now().getTime() + wait;
          throw new AppError(response.status === 429 || apiCode === 'ratelimited' ? 'RATE_LIMITED' : 'HTTP_TEMPORARY_ERROR', 'API тимчасово не може виконати запит.', { url, status: response.status, retryAt, apiCode });
        }
        this.options.log?.('API просить зачекати; повторюю запит після паузи.');
        await sleep(wait); continue;
      }
      if (!response.ok) throw new AppError(response.status === 404 ? 'DATA_NOT_FOUND' : 'HTTP_ERROR', response.status === 404 ? '404: AQS не розрізняє нульові перегляди й ще не завантажені дані; значення невідоме.' : 'Wikimedia API повернув помилку.', { url, status: response.status, ...(response.status === 404 ? { assumption: 'unknown_not_zero', uncertainty: 'zero_or_not_loaded', responseBody: body, source: 'https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/documentation/troubleshooting.html' } : {}) });
      if (apiCode) throw new AppError('API_ERROR', 'Action API повернув помилку.', { url, apiCode });
      try { JSON.parse(body); } catch { throw new AppError('INVALID_RESPONSE', 'API повернув невалідний JSON.', { url }); }
      return { body, url };
    }
    throw new AppError('HTTP_ERROR', 'Запит не виконано.');
  }
}
