// Wrapper de los canales IPC (docs/DESIGN.md §5.6): emisor, zod estricto, LOCKED, BUSY y errores.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppErrorException, type Result } from '../../../src/shared/errors';

type Listener = (event: unknown, payload: unknown) => Promise<Result<unknown>>;
const state = vi.hoisted(() => ({
  handlers: new Map<string, Listener>(),
  windowId: 1,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Listener) => state.handlers.set(channel, fn),
  },
}));
vi.mock('../../../src/main/window', () => ({
  getMainWindow: () => ({ webContents: { id: state.windowId } }),
  getRendererOrigin: () => 'app://bundle',
}));

const { handle, setSessionGate } = await import('../../../src/main/ipc/register');

function event(senderId = state.windowId, url = 'app://bundle/index.html'): unknown {
  return { sender: { id: senderId }, senderFrame: { url } };
}

function invoke(channel: string, payload?: unknown, ev = event()): Promise<Result<unknown>> {
  const fn = state.handlers.get(channel);
  if (!fn) throw new Error(`sin handler: ${channel}`);
  return fn(ev, payload);
}

beforeEach(() => {
  state.handlers.clear();
  state.windowId = 1;
  setSessionGate(null);
});

describe('register.handle', () => {
  it('paso 1: un emisor que no es la ventana actual, o de otro origen → VALIDATION', async () => {
    const fn = vi.fn(() => ({ maximized: false }) as never);
    handle('window:getState', { requiresUnlock: false }, fn);
    for (const ev of [
      event(2),
      event(1, 'https://example.com/'),
      event(1, 'app://otro/index.html'),
      event(1, 'about:blank'),
      { sender: { id: 1 }, senderFrame: null },
    ]) {
      expect(await invoke('window:getState', undefined, ev)).toEqual({
        ok: false,
        error: { code: 'VALIDATION', details: { reason: 'sender' } },
      });
    }
    expect(fn).not.toHaveBeenCalled();
    // Tras sustituir la ventana, la antigua deja de ser un emisor válido.
    state.windowId = 7;
    expect((await invoke('window:getState', undefined, event(1))).ok).toBe(false);
    expect((await invoke('window:getState', undefined, event(7))).ok).toBe(true);
  });

  it('paso 2: una clave extra → VALIDATION con details.path (sin el valor)', async () => {
    handle('window:setFullScreen', { requiresUnlock: false }, () => undefined);
    expect(await invoke('window:setFullScreen', { on: true, extra: 'C:\\secreto' })).toEqual({
      ok: false,
      error: { code: 'VALIDATION', details: { path: 'extra' } },
    });
    expect(await invoke('window:setFullScreen', { on: 'sí' })).toEqual({
      ok: false,
      error: { code: 'VALIDATION', details: { path: 'on' } },
    });
    expect(await invoke('window:setFullScreen', { on: true })).toEqual({
      ok: true,
      data: undefined,
    });
  });

  it('una contraseña de un payload rechazado queda a cero', async () => {
    handle('session:unlock', { requiresUnlock: false }, () => ({}) as never);
    const password = new TextEncoder().encode('contraseña larga');
    const result = await invoke('session:unlock', { profileId: 'no-es-un-id', password });
    expect(result.ok).toBe(false);
    expect(password.every((b) => b === 0)).toBe(true);
    const other = new TextEncoder().encode('contraseña larga');
    await invoke('session:unlock', { profileId: '0'.repeat(32), password: other }, event(9));
    expect(other.every((b) => b === 0)).toBe(true);
  });

  it('paso 2: canales sin petición rechazan cualquier payload', async () => {
    handle('session:getState', { requiresUnlock: false }, () => ({ state: 'locked' }) as never);
    expect((await invoke('session:getState', { x: 1 })).ok).toBe(false);
    expect((await invoke('session:getState')).ok).toBe(true);
  });

  it('paso 3: un canal "U" con la sesión bloqueada → LOCKED sin ejecutar el handler', async () => {
    const fn = vi.fn();
    handle('session:activity', { requiresUnlock: true }, fn);
    expect(await invoke('session:activity')).toEqual({ ok: false, error: { code: 'LOCKED' } });
    setSessionGate({ isUnlocked: false, inMaintenance: false });
    expect(await invoke('session:activity')).toEqual({ ok: false, error: { code: 'LOCKED' } });
    expect(fn).not.toHaveBeenCalled();
    setSessionGate({ isUnlocked: true, inMaintenance: false });
    expect(await invoke('session:activity')).toEqual({ ok: true, data: undefined });
  });

  it('paso 4: en mantenimiento, los canales "U" fuera de la lista → BUSY', async () => {
    handle('prefs:get', { requiresUnlock: true }, () => ({}) as never);
    handle('session:activity', { requiresUnlock: true }, () => undefined);
    handle('settings:get', { requiresUnlock: false }, () => ({}) as never);
    setSessionGate({ isUnlocked: true, inMaintenance: true });
    expect(await invoke('prefs:get')).toEqual({ ok: false, error: { code: 'BUSY' } });
    expect((await invoke('session:activity')).ok).toBe(true);
    expect((await invoke('settings:get')).ok).toBe(true);
  });

  it('pasos 5 y 6: AppError → { ok: false, error }; otra excepción → INTERNAL sin message', async () => {
    handle('profiles:list', { requiresUnlock: false }, () => {
      throw new AppErrorException({ code: 'VAULT_CORRUPT', details: { stage: 'profiles' } });
    });
    expect(await invoke('profiles:list')).toEqual({
      ok: false,
      error: { code: 'VAULT_CORRUPT', details: { stage: 'profiles' } },
    });

    handle('window:getState', { requiresUnlock: false }, async () => {
      throw Object.assign(new Error("ENOENT: no such file, open 'C:\\Users\\x\\foto.jpg'"), {
        code: 'ENOENT',
        syscall: 'open',
      });
    });
    const result = await invoke('window:getState');
    expect(result).toEqual({ ok: false, error: { code: 'INTERNAL' } });
    expect(JSON.stringify(result)).not.toContain('foto');
  });
});
