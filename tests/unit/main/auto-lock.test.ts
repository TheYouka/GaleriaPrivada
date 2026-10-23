// Auto-bloqueo por inactividad con motivos de pausa (docs/DESIGN.md §12.11 y §13.2; D12, D18).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoLock } from '../../../src/main/session/auto-lock';

const MIN = 60_000;
let expired: number;
let lock: AutoLock;

beforeEach(() => {
  vi.useFakeTimers();
  expired = 0;
  lock = new AutoLock(() => {
    expired += 1;
  });
});

afterEach(() => {
  lock.stop();
  vi.useRealTimers();
});

describe('AutoLock', () => {
  it('bloquea a los autoLockMinutes sin actividad', () => {
    lock.start(5 * MIN);
    vi.advanceTimersByTime(5 * MIN - 1);
    expect(expired).toBe(0);
    vi.advanceTimersByTime(1);
    expect(expired).toBe(1);
    vi.advanceTimersByTime(60 * MIN);
    expect(expired).toBe(1); // una sola vez por sesión
  });

  it('la actividad reinicia desde cero', () => {
    lock.start(MIN);
    vi.advanceTimersByTime(MIN - 10);
    lock.activity();
    vi.advanceTimersByTime(MIN - 10);
    expect(expired).toBe(0);
    vi.advanceTimersByTime(10);
    expect(expired).toBe(1);
  });

  it('0 = desactivado', () => {
    lock.start(0);
    vi.advanceTimersByTime(24 * 60 * MIN);
    expect(expired).toBe(0);
    expect(lock.running).toBe(false);
  });

  it("D12: 'playback' pausa; al quitarse, el temporizador empieza desde cero", () => {
    lock.start(MIN);
    vi.advanceTimersByTime(MIN - 1000);
    lock.pause('playback');
    vi.advanceTimersByTime(10 * MIN);
    expect(expired).toBe(0);
    lock.activity(); // en pausa no lo arranca
    expect(lock.running).toBe(false);
    lock.resume('playback');
    vi.advanceTimersByTime(MIN - 1);
    expect(expired).toBe(0);
    vi.advanceTimersByTime(1);
    expect(expired).toBe(1);
  });

  it("'maintenance' y 'job' (D18): solo corre con el conjunto vacío", () => {
    lock.start(MIN);
    lock.pause('maintenance');
    lock.pause('job');
    expect(lock.pauseReasons.sort()).toEqual(['job', 'maintenance']);
    lock.resume('job');
    vi.advanceTimersByTime(10 * MIN);
    expect(expired).toBe(0);
    lock.resume('maintenance');
    expect(lock.running).toBe(true);
    vi.advanceTimersByTime(MIN);
    expect(expired).toBe(1);
  });

  it('el mismo motivo dos veces es uno solo; quitar uno que no está no hace nada', () => {
    lock.start(MIN);
    lock.pause('job');
    lock.pause('job');
    lock.resume('playback');
    expect(lock.running).toBe(false);
    lock.resume('job');
    expect(lock.running).toBe(true);
  });

  it('setTimeoutMs cambia el tiempo y reinicia; stop lo detiene todo', () => {
    lock.start(10 * MIN);
    vi.advanceTimersByTime(5 * MIN);
    lock.setTimeoutMs(MIN);
    vi.advanceTimersByTime(MIN - 1);
    expect(expired).toBe(0);
    lock.stop();
    vi.advanceTimersByTime(60 * MIN);
    expect(expired).toBe(0);
    expect(lock.pauseReasons).toEqual([]);
  });

  it('sin start no corre aunque se quiten motivos', () => {
    lock.pause('job');
    lock.resume('job');
    vi.advanceTimersByTime(60 * MIN);
    expect(expired).toBe(0);
  });
});
