// Registro de canales IPC (docs/DESIGN.md §5.6). Cada canal se registra con
// handle(channel, { requiresUnlock }, fn) y el esquema se toma de SCHEMAS. El wrapper hace, en orden:
//   1. emisor: la ventana actual (cambia al bloquear, §13.3) y el origen del renderer → VALIDATION;
//   2. payload: zod estricto → VALIDATION con details.path del primer error, sin el valor;
//   3. desbloqueo: requiresUnlock y la sesión no está `unlocked` → LOCKED;
//   4. mantenimiento (traslado de la bóveda, F2): canales "U" fuera de la lista → BUSY;
//   5. ejecuta fn y devuelve Result<T> (los errores nunca se lanzan al renderer);
//   6. AppErrorException → { ok: false, error }; cualquier otra → INTERNAL, registrando como mucho
//      err.code y err.syscall, nunca err.message (los mensajes de fs incluyen rutas).
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { AppErrorException, type Result } from '@shared/errors';
import type { AnyInvokeChannel, ReqOf, ResOf } from '@shared/ipc-contract';
import { log } from '../log';
import { originOf } from '../security/navigation-guard';
import { getMainWindow, getRendererOrigin } from '../window';
import { SCHEMAS } from './schemas';

export interface HandleOptions {
  /** Canal "U" de §10.2: si la sesión no está desbloqueada, LOCKED. */
  requiresUnlock: boolean;
}

export type Handler<C extends AnyInvokeChannel> = (
  req: ReqOf<C>,
  event: IpcMainInvokeEvent,
) => ResOf<C> | Promise<ResOf<C>>;

/** Estado de la sesión que necesita el wrapper (SessionManager en producción). */
export interface SessionGate {
  readonly isUnlocked: boolean;
  readonly inMaintenance: boolean;
}

/** Canales "U" que siguen disponibles durante un traslado de la bóveda (§5.6, punto 4). */
export const MAINTENANCE_ALLOWED: ReadonlySet<string> = new Set([
  'vault:getInfo',
  'vault:relocateCancel',
  'session:lock',
  'session:activity',
  'session:setPlayback',
  'session:getState',
]);

const LOCKED_GATE: SessionGate = { isUnlocked: false, inMaintenance: false };
let gate: SessionGate = LOCKED_GATE;

/** index.ts conecta el SessionManager antes de registrar los canales "U". */
export function setSessionGate(next: SessionGate | null): void {
  gate = next ?? LOCKED_GATE;
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const win = getMainWindow();
  if (!win || event.sender.id !== win.webContents.id) return false;
  const frameUrl = event.senderFrame?.url;
  if (!frameUrl) return false;
  try {
    return originOf(frameUrl) === getRendererOrigin();
  } catch {
    return false;
  }
}

/** Ruta del primer error de zod, sin el valor. Para una clave extra, el nombre de la clave. */
function issuePath(issue: { path: PropertyKey[]; code?: string; keys?: string[] } | undefined) {
  if (!issue) return '';
  const parts = issue.path.map(String);
  if (issue.code === 'unrecognized_keys' && issue.keys?.[0] !== undefined)
    parts.push(issue.keys[0]);
  return parts.join('.');
}

/**
 * Contraseñas (Uint8Array de primer nivel) de un payload que no llega al handler: se ponen a cero
 * también en las rutas de error (§6.7). Los handlers ponen a cero las que reciben.
 */
function zeroizePayloadBytes(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  for (const value of Object.values(payload)) {
    if (value instanceof Uint8Array) value.fill(0);
  }
}

function errInfo(err: unknown): { errno?: string; syscall?: string } {
  const e = err as { code?: unknown; syscall?: unknown } | null;
  const token = (v: unknown): string | undefined =>
    typeof v === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(v) ? v : undefined;
  return { errno: token(e?.code), syscall: token(e?.syscall) };
}

export function handle<C extends AnyInvokeChannel>(
  channel: C,
  options: HandleOptions,
  fn: Handler<C>,
): void {
  const schema = SCHEMAS[channel];
  ipcMain.handle(channel, async (event, payload: unknown): Promise<Result<ResOf<C>>> => {
    // 1. Emisor.
    if (!isTrustedSender(event)) {
      log.warn('ipc.sender-rejected');
      zeroizePayloadBytes(payload);
      return { ok: false, error: { code: 'VALIDATION', details: { reason: 'sender' } } };
    }
    // 2. Payload.
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      log.debug('ipc.validation');
      zeroizePayloadBytes(payload);
      return {
        ok: false,
        error: { code: 'VALIDATION', details: { path: issuePath(parsed.error.issues[0]) } },
      };
    }
    // 3. Desbloqueo.
    if (options.requiresUnlock && !gate.isUnlocked) {
      zeroizePayloadBytes(payload);
      return { ok: false, error: { code: 'LOCKED' } };
    }
    // 4. Mantenimiento.
    if (options.requiresUnlock && gate.inMaintenance && !MAINTENANCE_ALLOWED.has(channel)) {
      zeroizePayloadBytes(payload);
      return { ok: false, error: { code: 'BUSY' } };
    }
    // 5 y 6.
    try {
      return { ok: true, data: await fn(parsed.data, event) };
    } catch (err) {
      if (err instanceof AppErrorException) return { ok: false, error: err.error };
      log.error('ipc.internal', errInfo(err));
      return { ok: false, error: { code: 'INTERNAL' } };
    }
  });
}
