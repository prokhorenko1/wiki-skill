import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(public readonly code: string, message: string, public readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AppError';
  }
}

export function asError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) return new AppError('VALIDATION_ERROR', 'Дані не відповідають контракту.', {
    issues: error.issues.map(({ path, code, message }) => ({ path, code, message })),
  });
  if (error && typeof error === 'object' && 'code' in error && ['EACCES', 'EPERM', 'EROFS', 'ENOSPC'].includes(String(error.code))) return new AppError('STORAGE_UNAVAILABLE', 'Недостатньо прав або місця для запису. Перевірте runtime та дозволи середовища.', { systemCode: error.code });
  return new AppError('INTERNAL_ERROR', 'Операцію не завершено.', {
    cause: error instanceof Error ? error.message : String(error),
  });
}
