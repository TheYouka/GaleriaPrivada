// KeylessCleanup (docs/DESIGN.md §13.3, paso 6): serializada por ruta; una petición sobre una ruta
// en curso se une a la tarea existente.
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { log } from '../../../src/main/log';
import { KeylessCleanup } from '../../../src/main/session/keyless-cleanup';

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const base = join(process.cwd(), 'tests', '.tmp', 'keyless');

describe('KeylessCleanup', () => {
  it('une dos peticiones sobre la misma ruta: la tarea corre una vez', async () => {
    const cleanup = new KeylessCleanup();
    const gate = deferred();
    const first = vi.fn(() => gate.promise);
    const second = vi.fn(async () => undefined);
    const path = join(base, 'Galeria-1234.partial');
    const a = cleanup.run(path, first);
    const b = cleanup.run(path, second);
    expect(b).toBe(a);
    expect(cleanup.pending(path)).toBe(a);
    await Promise.resolve();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    gate.resolve();
    await a;
    expect(cleanup.size).toBe(0);
    expect(cleanup.pending(path)).toBeUndefined();
    // Terminada la tarea, una petición nueva sí corre.
    await cleanup.run(path, second);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it.runIf(process.platform === 'win32')('en Windows la ruta no distingue mayúsculas', () => {
    const cleanup = new KeylessCleanup();
    const gate = deferred();
    const a = cleanup.run(join(base, 'Vault'), () => gate.promise);
    expect(cleanup.run(join(base, 'VAULT'), async () => undefined)).toBe(a);
    gate.resolve();
  });

  it('rutas distintas corren en paralelo', async () => {
    const cleanup = new KeylessCleanup();
    const g1 = deferred();
    const g2 = deferred();
    const t1 = vi.fn(() => g1.promise);
    const t2 = vi.fn(() => g2.promise);
    void cleanup.run(join(base, 'a'), t1);
    void cleanup.run(join(base, 'b'), t2);
    await Promise.resolve();
    expect(t1).toHaveBeenCalled();
    expect(t2).toHaveBeenCalled();
    expect(cleanup.size).toBe(2);
    g1.resolve();
    g2.resolve();
    await cleanup.idle();
    expect(cleanup.size).toBe(0);
  });

  it('un fallo no rechaza: se registra un warn sin datos y la ruta queda libre', async () => {
    const warn = vi.spyOn(log, 'warn');
    const cleanup = new KeylessCleanup();
    const path = join(base, 'c');
    await expect(
      cleanup.run(path, async () => {
        throw Object.assign(new Error(`EBUSY: ${path}`), { code: 'EBUSY' });
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('session.cleanup-failed', { errno: 'EBUSY' });
    expect(cleanup.size).toBe(0);
    warn.mockRestore();
  });

  it('una tarea que lanza de forma síncrona tampoco deja la ruta ocupada', async () => {
    const cleanup = new KeylessCleanup();
    const path = join(base, 'd');
    await cleanup.run(path, () => {
      throw new Error('x');
    });
    expect(cleanup.pending(path)).toBeUndefined();
  });

  it('runKey sirve para descriptores sin ruta', async () => {
    const cleanup = new KeylessCleanup();
    const close = vi.fn(async () => undefined);
    await cleanup.runKey('fd:1', close);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
