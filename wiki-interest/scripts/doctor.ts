// Навмисно без tsx/Zod: doctor має працювати до npm ci на Node.js 24.
import { checkEnvironment } from '../src/environment.ts';
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--offline')) {
  process.stdout.write(`${JSON.stringify({ status: 'error', error: { code: 'INVALID_ARGUMENTS', message: 'doctor приймає лише необов’язковий --offline.' } })}\n`);
  process.exitCode = 1;
} else {
  const summary = await checkEnvironment();
  const ready = args.includes('--offline') ? summary.offlineReady : summary.liveReady;
  const warnings = summary.checks.filter(check => check.status === 'warning').map(({ code, message }) => ({ code, message }));
  process.stdout.write(`${JSON.stringify({ status: ready ? 'ok' : 'error', identifiers: {}, summary, warnings, artifacts: [], nextAction: { operation: null, message: ready ? 'Локальне середовище готове; це не підтверджує доступ Wikimedia. Doctor не запускає браузер і мережу.' : 'Виправте blocked-перевірки. Права не обходьте.' } })}\n`);
  if (!ready) process.exitCode = 1;
}
