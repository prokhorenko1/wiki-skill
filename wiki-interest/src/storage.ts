import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, link, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { AppError } from './errors.js';
import { SCHEMA_VERSION } from './schemas.js';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export const snapshotSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION), key: z.string(), request: z.record(z.string(), z.unknown()),
  url: z.url(), receivedAt: z.iso.datetime(), origin: z.enum(['wikimedia', 'fixtures']), body: z.string(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export const snapshotRefSchema = z.object({
  snapshotId: z.string().regex(/^[a-f0-9]{64}$/), key: z.string(), url: z.url(),
  receivedAt: z.iso.datetime(), origin: z.enum(['wikimedia', 'fixtures']), checksum: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SnapshotRef = z.infer<typeof snapshotRefSchema>;

export class FileStore {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }

  path(...parts: string[]): string {
    if (parts.some(part => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..')) throw new AppError('UNSAFE_PATH', 'Недопустимий компонент шляху.');
    const target = resolve(this.root, ...parts);
    const rel = relative(this.root, target);
    if (rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new AppError('UNSAFE_PATH', 'Шлях виходить за корінь сховища.');
    return target;
  }

  private async guard(target: string): Promise<void> {
    let current = target;
    while (true) {
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new AppError('UNSAFE_PATH', 'Символічні посилання у шляху сховища заборонені.', { path: current });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  async read<T>(parts: string[], schema: z.ZodType<T>): Promise<T> {
    const path = this.path(...parts); await this.guard(path);
    let text: string;
    try { text = await readFile(path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('NOT_FOUND', 'Локальний артефакт не знайдено.', { path });
      throw error;
    }
    try { return schema.parse(JSON.parse(text)); }
    catch (error) {
      throw new AppError('STORAGE_INVALID', 'Локальний артефакт має невалідний формат.', { path, cause: String(error) });
    }
  }

  async optional<T>(parts: string[], schema: z.ZodType<T>): Promise<T | undefined> {
    try { return await this.read(parts, schema); }
    catch (error) { if (error instanceof AppError && error.code === 'NOT_FOUND') return undefined; throw error; }
  }

  async write(parts: string[], value: unknown, immutable = true): Promise<string> {
    return this.writeBytes(parts, `${canonical(value)}\n`, immutable);
  }

  async readBytes(parts: string[]): Promise<Buffer> {
    const path = this.path(...parts); await this.guard(path);
    try { return await readFile(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('NOT_FOUND', 'Локальний артефакт не знайдено.', { path });
      throw error;
    }
  }

  async writeBytes(parts: string[], value: string | Uint8Array, immutable = true): Promise<string> {
    const path = this.path(...parts); await this.guard(path);
    await mkdir(dirname(path), { recursive: true }); await this.guard(path);
    const temp = join(dirname(path), `.tmp-${randomUUID()}`);
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(value); await file.sync(); }
    finally { await file.close(); }
    try {
      if (immutable) { await link(temp, path); await unlink(temp); }
      else await rename(temp, path);
    } catch (error) { await unlink(temp).catch(() => {}); throw error; }
    return path;
  }

  async snapshot(snapshot: Snapshot): Promise<SnapshotRef> {
    const checked = snapshotSchema.parse(snapshot);
    const checksum = sha256(`${canonical(checked)}\n`);
    try { await this.write(['snapshots', `${checksum}.json`], checked); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const ref = { snapshotId: checksum, checksum, key: checked.key, url: checked.url, receivedAt: checked.receivedAt, origin: checked.origin };
    await this.loadSnapshot(ref);
    return ref;
  }

  async loadSnapshot(reference: SnapshotRef): Promise<Snapshot> {
    const ref = snapshotRefSchema.parse(reference);
    if (ref.snapshotId !== ref.checksum) throw new AppError('CHECKSUM_MISMATCH', 'Ідентифікатор знімка не відповідає checksum.');
    const path = this.path('snapshots', `${ref.snapshotId}.json`); await this.guard(path);
    let text: string;
    try { text = await readFile(path, 'utf8'); }
    catch { throw new AppError('SNAPSHOT_MISSING', 'Збережений знімок недоступний.', { snapshotId: ref.snapshotId }); }
    if (sha256(text) !== ref.checksum) throw new AppError('CHECKSUM_MISMATCH', 'Контрольна сума знімка не збігається.', { snapshotId: ref.snapshotId });
    const snapshot = snapshotSchema.parse(JSON.parse(text));
    if (sha256(canonical(snapshot.request)) !== snapshot.key) throw new AppError('SNAPSHOT_MISMATCH', 'Ключ знімка не відповідає збереженому запиту.');
    if (snapshot.key !== ref.key || snapshot.origin !== ref.origin || snapshot.url !== ref.url || snapshot.receivedAt !== ref.receivedAt) throw new AppError('SNAPSHOT_MISMATCH', 'Метадані знімка не відповідають manifest.');
    return snapshot;
  }
}
