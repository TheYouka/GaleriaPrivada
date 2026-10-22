// Códigos de error del contrato IPC (docs/DESIGN.md §10.1). main nunca envía textos: el renderer
// traduce code → mensaje en español (renderer/src/lib/errors-es.ts, Fase 1).
export const ERROR_CODES = [
  'VALIDATION',
  'LOCKED',
  'BUSY',
  'WRONG_PASSWORD',
  'PROFILE_NOT_FOUND',
  'PROFILE_NAME_TAKEN',
  'PROFILE_LIMIT',
  'VAULT_UNAVAILABLE',
  'VAULT_CORRUPT',
  'NOT_FOUND',
  'INTEGRITY',
  'UNSUPPORTED_FORMAT',
  'TOO_LARGE',
  'DISK_FULL',
  'IO',
  'FFMPEG_MISSING',
  'FFMPEG_FAILED',
  'CANCELLED',
  'PLAYLIST_FULL',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface AppError {
  code: ErrorCode;
  details?: Record<string, string | number | boolean>;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError };

/** Excepción que transporta un AppError. main la lanza y ipc/register.ts la convierte en Result. */
export class AppErrorException extends Error {
  readonly error: AppError;

  constructor(error: AppError) {
    super(error.code);
    this.name = 'AppErrorException';
    this.error = error;
  }
}
