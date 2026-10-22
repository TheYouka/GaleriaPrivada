// Registro de canales IPC (docs/DESIGN.md §5.6), versión del scaffold: pasos 1 (emisor), 2 (zod),
// 5 (Result) y 6 (excepciones). requiresUnlock (paso 3) y maintenance (paso 4) llegan en F1.
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { AppErrorException, type Result } from '@shared/errors';
import type { InvokeChannel, ReqOf, ResOf } from '@shared/ipc-contract';
import { originOf } from '../security/navigation-guard';
import { getMainWindow, getRendererOrigin } from '../window';
import { SCHEMAS } from './schemas';

export interface HandleOptions {
  /** F1: si es true y la sesión no está desbloqueada, LOCKED. El scaffold no registra canales "U". */
  requiresUnlock: boolean;
}

export type Handler<C extends InvokeChannel> = (
  req: ReqOf<C>,
  event: IpcMainInvokeEvent,
) => ResOf<C> | Promise<ResOf<C>>;

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

export function handle<C extends InvokeChannel>(
  channel: C,
  _options: HandleOptions,
  fn: Handler<C>,
): void {
  const schema = SCHEMAS[channel];
  ipcMain.handle(channel, async (event, payload: unknown): Promise<Result<ResOf<C>>> => {
    // 1. Emisor: la ventana actual y el origen del renderer. F1: log.warn.
    if (!isTrustedSender(event)) {
      return { ok: false, error: { code: 'VALIDATION', details: { reason: 'sender' } } };
    }
    // 2. Payload: esquema estricto; details.path sin el valor.
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      const path = parsed.error.issues[0]?.path.map(String).join('.') ?? '';
      return { ok: false, error: { code: 'VALIDATION', details: { path } } };
    }
    // 5 y 6. Los errores nunca se lanzan al renderer ni llevan err.message (incluye rutas).
    try {
      return { ok: true, data: await fn(parsed.data, event) };
    } catch (err) {
      if (err instanceof AppErrorException) return { ok: false, error: err.error };
      return { ok: false, error: { code: 'INTERNAL' } }; // F1: log.error con err.code/err.syscall
    }
  });
}
