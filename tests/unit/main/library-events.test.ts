// ipc/library-events.ts (docs/DESIGN.md §10.2): agrupación de library:changed con reloj falso.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LibraryEvents } from '../../../src/main/ipc/library-events';
import type { LibraryChanged } from '../../../src/shared/types';

interface Sent {
  at: number;
  payload: LibraryChanged;
}

let sent: Sent[];
let events: LibraryEvents;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  sent = [];
  events = new LibraryEvents((payload) => sent.push({ at: Date.now(), payload }));
});

afterEach(() => {
  events.dispose();
  vi.useRealTimers();
});

const id = (n: number): string => n.toString(16).padStart(32, '0');

describe('fuera de los trabajos', () => {
  it('cada cambio sale al momento con sus ids', () => {
    events.changed('rename', [id(1)]);
    events.changed('delete', [id(2), id(3)]);
    expect(sent.map((s) => s.payload)).toEqual([
      { reason: 'rename', ids: [id(1)] },
      { reason: 'delete', ids: [id(2), id(3)] },
    ]);
  });
});

describe('durante una importación', () => {
  it('1000 confirmaciones en 3 s → ≤ 5 eventos import y el último después de la última', async () => {
    const end = events.beginJob();
    let lastConfirm = 0;
    for (let i = 0; i < 1000; i += 1) {
      await vi.advanceTimersByTimeAsync(3);
      events.changed('import', [id(i)]);
      lastConfirm = Date.now();
    }
    expect(lastConfirm).toBe(3000);
    await vi.advanceTimersByTimeAsync(50);
    end();
    await vi.advanceTimersByTimeAsync(5000);
    const imports = sent.filter((s) => s.payload.reason === 'import');
    expect(imports.length).toBeGreaterThanOrEqual(2);
    expect(imports.length).toBeLessThanOrEqual(5);
    expect(imports.every((s) => s.payload.ids === undefined)).toBe(true);
    expect(imports.at(-1)?.at).toBeGreaterThan(lastConfirm);
    // Como mucho uno por ventana de 1 s.
    for (let i = 1; i < imports.length - 1; i += 1) {
      expect((imports[i]?.at ?? 0) - (imports[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(1000);
    }
  });

  it('por razón: un renombrado durante la importación también se agrupa, sin ids', async () => {
    const end = events.beginJob();
    events.changed('import');
    events.changed('rename', [id(1)]);
    events.changed('import');
    events.changed('rename', [id(2)]);
    expect(sent.map((s) => s.payload)).toEqual([{ reason: 'import' }, { reason: 'rename' }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveLength(4);
    end();
    expect(sent).toHaveLength(6); // el final de cada razón
    end(); // idempotente
    expect(sent).toHaveLength(6);
    events.changed('rename', [id(3)]);
    expect(sent.at(-1)?.payload).toEqual({ reason: 'rename', ids: [id(3)] });
  });

  it('un trabajo sin cambios no emite nada al terminar', () => {
    const end = events.beginJob();
    end();
    expect(sent).toEqual([]);
  });

  it('un envío que falla (sin ventana) no rompe la agrupación', () => {
    const failing = new LibraryEvents(() => {
      throw new Error('sin ventana');
    });
    const end = failing.beginJob();
    expect(() => failing.changed('import')).not.toThrow();
    expect(() => end()).not.toThrow();
    failing.dispose();
  });
});
