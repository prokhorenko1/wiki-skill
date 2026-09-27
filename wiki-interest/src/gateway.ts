import { z } from 'zod';
import { AppError, asError } from './errors.js';
import { canonical, sha256, snapshotRefSchema, type FileStore, type SnapshotRef, type Snapshot } from './storage.js';
import { SCHEMA_VERSION, type SourceOptions } from './schemas.js';
import { requestSchema, type ApiRequest } from './requests.js';
import type { Clock } from './calendar.js';
import type { Transport } from './http.js';

const cacheEntrySchema = z.object({ request: requestSchema, ref: snapshotRefSchema });
const cacheSchema = z.array(cacheEntrySchema);
function cacheKey(request: ApiRequest): string {
  if (request.kind === 'article' || request.kind === 'project') {
    const { period, ...identity } = request;
    return sha256(canonical({ ...identity, month: period.start.slice(0, 7) }));
  }
  return sha256(canonical(request));
}
function covers(saved: ApiRequest, requested: ApiRequest): boolean {
  if ((saved.kind === 'article' || saved.kind === 'project') && (requested.kind === 'article' || requested.kind === 'project')) {
    return cacheKey(saved) === cacheKey(requested) && saved.period.start <= requested.period.start && saved.period.end >= requested.period.end;
  }
  return canonical(saved) === canonical(requested);
}
export interface GatewayResult { data: unknown; request: ApiRequest; ref: SnapshotRef }

export class DataGateway {
  private readonly used = new Map<string, SnapshotRef>();
  private readonly memo = new Map<string, GatewayResult>();
  private readonly loaded = new Map<string, Promise<Snapshot>>();
  readonly stats = { cacheHits: 0, fetched: 0, replayed: 0 };
  private requests = 0;
  private lastBlocker: AppError | undefined;
  constructor(private readonly store: FileStore, private readonly options: SourceOptions, private readonly clock: Clock,
    private readonly transport: Transport, private readonly replayRefs?: SnapshotRef[], private readonly maxRequests = Infinity, private readonly preferredRefs?: SnapshotRef[]) {}
  get logicalRequests(): number { return this.requests; }
  get blocker(): AppError | undefined { return this.lastBlocker; }
  get snapshots(): SnapshotRef[] { return [...this.used.values()]; }
  private snapshot(ref: SnapshotRef): Promise<Snapshot> {
    let value = this.loaded.get(ref.snapshotId);
    if (!value) { value = this.store.loadSnapshot(ref); this.loaded.set(ref.snapshotId, value); }
    return value;
  }

  private async use(ref: SnapshotRef): Promise<GatewayResult> {
    const snapshot = await this.snapshot(ref);
    this.used.set(ref.snapshotId, ref);
    try { return { data: JSON.parse(snapshot.body), request: requestSchema.parse(snapshot.request), ref }; }
    catch { throw new AppError('SNAPSHOT_INVALID', 'Знімок містить невалідну відповідь або запит.'); }
  }

  async get(input: ApiRequest): Promise<GatewayResult> {
    const request = requestSchema.parse(input);
    const key = sha256(canonical(request));
    // Метадані (зокрема негативний пошук) у live живуть одну добу. Replay незмінний.
    const fresh = (ref: SnapshotRef) => this.options.source !== 'live' || request.kind === 'article' || request.kind === 'project' || this.clock.now().getTime() - Date.parse(ref.receivedAt) <= 86_400_000;
    const existing = this.memo.get(key);
    if (existing && (this.replayRefs || fresh(existing.ref))) return existing;
    if (this.requests >= this.maxRequests) throw new AppError('DISCOVERY_REQUEST_LIMIT', 'Досягнуто бюджету discovery; список неповний.');
    this.requests++;
    if (this.replayRefs) {
      for (const ref of this.replayRefs) {
        const snapshot = await this.snapshot(ref);
        if (covers(requestSchema.parse(snapshot.request), request)) {
          this.stats.replayed++; const result = await this.use(ref); this.memo.set(key, result); return result;
        }
      }
      throw new AppError('REPLAY_DATA_MISSING', 'Дослідження не містить потрібного знімка.', { request });
    }
    if (this.options.cachePolicy === 'reuse') for (const ref of this.preferredRefs ?? []) {
      const snapshot = await this.snapshot(ref);
      if (fresh(ref) && covers(requestSchema.parse(snapshot.request), request)) {
        this.stats.replayed++; const result = await this.use(ref); this.memo.set(key, result); return result;
      }
    }
    const namespace = this.options.source === 'fixtures' ? `fixtures-${this.options.fixtureId}` : 'wikimedia';
    const path = ['cache', namespace, `${cacheKey(request)}.json`];
    const entries = await this.store.optional(path, cacheSchema) ?? [];
    if (this.options.cachePolicy === 'reuse') {
      const entry = [...entries].reverse().find(e => fresh(e.ref) && covers(e.request, request));
      if (entry) {
        this.stats.cacheHits++; const result = await this.use(entry.ref); this.memo.set(key, result); return result;
      }
    }
    if (this.options.source === 'offline') throw new AppError('OFFLINE_CACHE_MISS', 'Offline-кеш не містить потрібних даних; мережа та fixtures не використовувалися.', { request });
    const cooldownPath = ['network', namespace, 'cooldown.json'];
    const cooldown = await this.store.optional(cooldownPath, z.object({ retryAt: z.iso.datetime() }));
    if (cooldown && Date.parse(cooldown.retryAt) > this.clock.now().getTime()) {
      this.lastBlocker = new AppError('RATE_LIMITED', 'Збережений cooldown забороняє новий запит; наявний кеш залишається доступним.', cooldown); throw this.lastBlocker;
    }
    let response: Awaited<ReturnType<Transport['get']>>;
    try { response = await this.transport.get(request); }
    catch (error) {
      const problem = asError(error), retryAt = z.iso.datetime().safeParse(problem.details.retryAt);
      if (['RATE_LIMITED', 'HTTP_TEMPORARY_ERROR'].includes(problem.code)) this.lastBlocker = problem;
      if (['RATE_LIMITED', 'HTTP_TEMPORARY_ERROR'].includes(problem.code) && retryAt.success && Date.parse(retryAt.data) > this.clock.now().getTime()) await this.store.write(cooldownPath, { retryAt: retryAt.data }, false);
      throw error;
    }
    this.stats.fetched++;
    const ref = await this.store.snapshot({ schemaVersion: SCHEMA_VERSION, key, request, url: response.url,
      receivedAt: this.clock.now().toISOString(), origin: this.options.source === 'fixtures' ? 'fixtures' : 'wikimedia', body: response.body });
    await this.store.write(path, [...entries.filter(e => e.ref.key !== key), { request, ref }], false);
    const result = await this.use(ref); this.memo.set(key, result); return result;
  }
}
