import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));
it('CLI повертає один JSON у stdout та ненульовий exit code за помилки', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/cli.ts', 'analyze', '--input', 'examples/does-not-exist.json'], { cwd, encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: 'error', error: { code: 'INPUT_READ_ERROR' } });
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
});
it('CLI не починає аналіз без валідного вхідного файлу', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/cli.ts', 'analyze'], { cwd, encoding: 'utf8' });
  expect(result.status).toBe(1); expect(JSON.parse(result.stdout).error.code).toBe('INPUT_REQUIRED');
});
it('реєстр не приймає успадковані властивості як операції', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/cli.ts', 'toString', '--input', 'examples/revise.json'], { cwd, encoding: 'utf8' });
  expect(result.status).toBe(1); expect(JSON.parse(result.stdout).error.code).toBe('UNKNOWN_OPERATION');
});
