// Log tipado de main (docs/DESIGN.md §21.2). La API impide filtrar datos: el evento es una unión
// cerrada de literales y los campos son una lista cerrada de números, ids y códigos. Nunca se
// registran nombres de archivo, rutas, nombres de perfil o de playlist, títulos, búsquedas, EXIF,
// contraseñas, claves, tokens, URLs ni err.message.
//
// Destino: GaleriaData/logs/main.log, rotado en 1 MiB × 3 (main.log, main.log.1, main.log.2). En
// desarrollo también va a la consola. `debug` solo sin empaquetar. Antes de initLog() los mensajes
// se descartan (los pasos 1–2 del arranque no tienen log, §5.2).
//
// Este módulo no importa `electron`: index.ts le pasa isPackaged, así se puede probar en Vitest.
import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { ERROR_CODES, type ErrorCode } from '@shared/errors';
import { ID_PATTERN } from '@shared/constants';
import type { Id } from '@shared/types';

/** Eventos admitidos. Cada fase añade aquí los suyos; no hay forma de registrar texto libre. */
export const LOG_EVENTS = [
  // Arranque y rutas (§8.1)
  'app.start',
  'paths.override-active',
  'paths.override-ignored',
  'startup.tmp-cleanup',
  // Red (§5.4)
  'net.blocked',
  'download.blocked',
  // Ventana (§13.3)
  'window.replace-timeout',
  // IPC (§5.6)
  'ipc.sender-rejected',
  'ipc.validation',
  'ipc.internal',
  // Errores no controlados (§21.1)
  'process.uncaught-exception',
  'process.unhandled-rejection',
  // KDF (§6.1)
  'kdf.fast-params',
  'kdf.calibrated',
  'kdf.candidate-failed',
  'kdf.memory',
  // Formato cifrado (§7.4)
  'crypto.integrity',
  'crypto.writer-failed',
  // Sesión y bloqueo (§13)
  'session.unlocked',
  'session.unlock-failed',
  'session.wrong-password',
  'session.locked',
  'session.drain-timeout',
  'session.zeroized',
  'session.cleanup-failed',
  // Perfiles y bóvedas (§8, §14.4)
  'profile.created',
  'profile.create-failed',
  'profile.updated',
  'profile.password-changed',
  'profile.deleted',
  'profile.delete-leftover',
  'profile.wrong-password',
  'profile.not-found',
  'profiles.restored-backup',
  'profiles.corrupt',
  'profiles.write-failed',
  'settings.rewritten',
  'settings.write-failed',
  'vault.creating-removed',
  'vault.orphan-dir',
  'vault.unavailable',
  'vault.remove.leftover',
  'vault.remove.refused',
  'avatar.rejected',
  'avatar.failed',
  // DB (§9)
  'db.open-failed',
  'db.migration-failed',
  'db.newer-version',
  'db.migrated',
  'kv.invalid-value',
  // Protocolo vault:// (§11.4)
  'protocol.rejected',
  'protocol.io',
  'protocol.not-found',
  // ffmpeg (§19.4)
  'ffmpeg.missing',
  'ffmpeg.decoders-failed',
  'ffmpeg.failed',
  // Object store (§12.10)
  'object.erase-failed',
  'object.rename-retry',
  // Importación (§12.4, §12.7, §12.9, §12.9.1)
  'import.finished',
  'import.job-failed',
  'import.file.failed',
  'import.thumb-failed',
  'import.cleanup-failed',
  'import.original.hardlink',
  'import.original.changed',
  'import.original.overwrite-failed',
  'import.original.unlink-failed',
  'import.linux-cleanup',
  // Reconciliación (§12.6)
  'reconcile.done',
  'reconcile.failed',
  'reconcile.pending.dropped',
  'reconcile.replace.invalid',
  'reconcile.thumb-failed',
  'reconcile.sweep-failed',
  'reconcile.orphans-erased',
  // Edición y regeneración de miniaturas (§16.5)
  'edit.saved',
  'edit.failed',
  // Traslado de la bóveda y disco ausente (§8.7)
  'relocate.started',
  'relocate.done',
  'relocate.failed',
  'relocate.cancelled',
  'relocate.interrupted',
  'relocate.rollback-failed',
  'relocate.skipped-entry',
  'relocate.leftover',
  'relocate.pending-cleanup',
  'vault.located',
  'vault.locate-rejected',
  // Fases posteriores ya citadas en el diseño
  'protocol.integrity',
] as const;

export type LogEvent = (typeof LOG_EVENTS)[number];

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** Campos permitidos de §21.2. Cualquier otro se descarta también en tiempo de ejecución. */
export interface LogFields {
  code?: ErrorCode;
  mediaId?: Id;
  jobId?: Id;
  count?: number;
  ms?: number;
  bytes?: number;
  errno?: string;
  syscall?: string;
  stage?: string;
  scheme?: string;
}

export interface LogOptions {
  /** Carpeta de los logs (GaleriaData/logs). Se crea si no existe. */
  dir: string;
  /** `debug` solo sin empaquetar. */
  isPackaged: boolean;
  /** Copia en la consola (desarrollo). */
  console?: boolean;
  /** Para tests: tamaño máximo por archivo (por defecto 1 MiB). */
  maxBytes?: number;
  /** Para tests: reloj. */
  now?: () => Date;
}

export const LOG_FILE_NAME = 'main.log';
export const LOG_MAX_BYTES = 1024 * 1024;
/** main.log + main.log.1 + main.log.2. */
export const LOG_FILES = 3;

const EVENT_SET: ReadonlySet<string> = new Set(LOG_EVENTS);
const CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);
/** errno, syscall, stage y scheme: identificadores cortos, nunca texto libre ni rutas. */
const TOKEN_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

type FieldKind = 'code' | 'id' | 'number' | 'token';
const FIELD_KINDS: Readonly<Record<keyof LogFields, FieldKind>> = {
  code: 'code',
  mediaId: 'id',
  jobId: 'id',
  count: 'number',
  ms: 'number',
  bytes: 'number',
  errno: 'token',
  syscall: 'token',
  stage: 'token',
  scheme: 'token',
};

interface Sink {
  path: string;
  fd: number | null;
  size: number;
  maxBytes: number;
  isPackaged: boolean;
  console: boolean;
  now: () => Date;
}

let sink: Sink | null = null;

function validField(kind: FieldKind, value: unknown): boolean {
  switch (kind) {
    case 'code':
      return typeof value === 'string' && CODE_SET.has(value);
    case 'id':
      return typeof value === 'string' && ID_PATTERN.test(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'token':
      return typeof value === 'string' && TOKEN_PATTERN.test(value);
  }
}

/** Copia solo los campos permitidos y con el formato esperado (defensa ante casts). */
function sanitize(fields: LogFields | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (!fields || typeof fields !== 'object') return out;
  for (const key of Object.keys(FIELD_KINDS) as (keyof LogFields)[]) {
    const value: unknown = fields[key];
    if (value !== undefined && validField(FIELD_KINDS[key], value)) {
      out[key] = value as string | number;
    }
  }
  return out;
}

function openFd(s: Sink): void {
  s.fd = openSync(s.path, 'a', 0o600);
  try {
    s.size = statSync(s.path).size;
  } catch {
    s.size = 0;
  }
}

function closeFd(s: Sink): void {
  if (s.fd === null) return;
  try {
    closeSync(s.fd);
  } catch {
    // ignorado
  }
  s.fd = null;
}

/** main.log → .1 → .2; el anterior .2 se descarta. */
function rotate(s: Sink): void {
  closeFd(s);
  for (let i = LOG_FILES - 1; i >= 1; i -= 1) {
    const from = i === 1 ? s.path : `${s.path}.${i - 1}`;
    const to = `${s.path}.${i}`;
    try {
      if (i === LOG_FILES - 1) rmSync(to, { force: true });
      renameSync(from, to);
    } catch {
      // Si falta alguno (primeras rotaciones) se sigue.
    }
  }
  openFd(s);
}

function write(level: LogLevel, event: LogEvent, fields?: LogFields): void {
  const s = sink;
  if (!s) return;
  if (level === 'debug' && s.isPackaged) return;
  if (!EVENT_SET.has(event)) return; // defensa ante casts: nunca texto libre
  try {
    const line = `${JSON.stringify({ ts: s.now().toISOString(), level, event, ...sanitize(fields) })}\n`;
    if (s.console) {
      const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      out(line.trimEnd());
    }
    const bytes = Buffer.byteLength(line);
    if (s.fd === null) openFd(s);
    if (s.size > 0 && s.size + bytes > s.maxBytes) rotate(s);
    if (s.fd === null) return;
    writeSync(s.fd, line);
    s.size += bytes;
  } catch {
    // El log nunca hace fallar a quien lo llama.
  }
}

/** Abre GaleriaData/logs/main.log. Se puede llamar otra vez (tests): cierra el anterior. */
export function initLog(options: LogOptions): void {
  closeLog();
  mkdirSync(options.dir, { recursive: true });
  const s: Sink = {
    path: join(options.dir, LOG_FILE_NAME),
    fd: null,
    size: 0,
    maxBytes: options.maxBytes ?? LOG_MAX_BYTES,
    isPackaged: options.isPackaged,
    console: options.console ?? false,
    now: options.now ?? (() => new Date()),
  };
  try {
    openFd(s);
  } catch {
    // Sin archivo (disco de solo lectura…): write() lo reintenta.
  }
  sink = s;
}

/** Cierra el archivo; los mensajes siguientes se descartan hasta otro initLog(). */
export function closeLog(): void {
  if (sink) closeFd(sink);
  sink = null;
}

export const log = {
  error(event: LogEvent, fields?: LogFields): void {
    write('error', event, fields);
  },
  warn(event: LogEvent, fields?: LogFields): void {
    write('warn', event, fields);
  },
  info(event: LogEvent, fields?: LogFields): void {
    write('info', event, fields);
  },
  debug(event: LogEvent, fields?: LogFields): void {
    write('debug', event, fields);
  },
} as const;
