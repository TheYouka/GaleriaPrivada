// Reloj falso para el planificador y el audio de la presentación (Timers inyectables). `advance(ms)`
// dispara los temporizadores vencidos en orden, incluidos los que se crean durante la espera.
import type { Timers } from '../../../../src/renderer/src/screens/presentation/scheduler';

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
}

export class FakeClock implements Timers {
  private time = 0;
  private nextId = 1;
  private timers: FakeTimer[] = [];

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ id, at: this.time + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  get pending(): number {
    return this.timers.length;
  }

  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      let next: FakeTimer | undefined;
      for (const t of this.timers) {
        if (t.at <= end && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) {
          next = t;
        }
      }
      if (!next) break;
      this.timers = this.timers.filter((t) => t !== next);
      this.time = Math.max(this.time, next.at);
      next.fn();
    }
    this.time = end;
  }
}
