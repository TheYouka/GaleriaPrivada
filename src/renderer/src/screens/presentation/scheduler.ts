// Temporización de la presentación (docs/DESIGN.md §17.4–§17.6). Puro: sin React ni DOM; el reloj,
// los temporizadores y el RNG se inyectan, así que se prueba en Node con un reloj falso.
//
// El planificador no carga nada: pide la precarga con eventos `prepare` y recibe `loaded`, `failed`
// y `ended` del anfitrión. Cada llamada pública termina de mutar el estado ANTES de avisar a los
// oyentes, y los avisos se encolan: un oyente puede llamar de vuelta (p. ej. `loaded` síncrono con la
// diapositiva ya en caché) sin ver un estado a medias.
//
// Estados de cada diapositiva: preparing → entering (D) → showing → leaving (D, solapado con el
// entering de la siguiente). El evento `tick` de §17.4 no existe: los plazos son temporizadores
// inyectados (PLAN.md nota 172).
import type { MediaKind, TransitionKind } from '@shared/types';
import { DEFAULT_PRESENTATION } from '@shared/presentation';
import {
  TransitionPicker,
  type Direction,
  type Rng,
  type TransitionPlan,
  type TransitionSetting,
} from './transitions';

/** Una diapositiva no lista se espera hasta 8 s más (§17.4). */
export const READY_TIMEOUT_MS = 8000;

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
};

export interface SlideSpec {
  kind: MediaKind;
  /** Duración propia de una foto; sin ella, `slideMs`. Los vídeos duran lo que duran. */
  durationMs?: number;
}

export interface SchedulerSettings {
  transition: TransitionSetting;
  randomPool: readonly TransitionKind[];
  transitionMs: number;
  slideMs: number;
  loop: boolean;
  /** `prefers-reduced-motion`: todo pasa a un fundido de 150 ms. */
  reducedMotion: boolean;
  /** «Animaciones»: si es false, Ken Burns se queda en el fundido. */
  kenBurns: boolean;
}

export const DEFAULT_SCHEDULER_SETTINGS: Readonly<SchedulerSettings> = {
  transition: DEFAULT_PRESENTATION.transition,
  randomPool: DEFAULT_PRESENTATION.randomPool,
  transitionMs: DEFAULT_PRESENTATION.transitionMs,
  slideMs: DEFAULT_PRESENTATION.slideMs,
  loop: DEFAULT_PRESENTATION.loop,
  reducedMotion: false,
  kenBurns: true,
};

export type SchedulerEvent =
  /** Hay que cargar la diapositiva (idempotente: el anfitrión puede tenerla ya). */
  | { type: 'prepare'; index: number }
  /** Empieza la entrada de `to`; `from` sale a la vez (null en la primera). */
  | {
      type: 'transition';
      from: number | null;
      to: number;
      fromKind: MediaKind | null;
      toKind: MediaKind;
      direction: Direction;
      manual: boolean;
      plan: TransitionPlan;
    }
  /** Termina la entrada: un vídeo empieza a sonar (salvo `paused`); `early` = entrada cortada. */
  | { type: 'showing'; index: number; kind: MediaKind; early: boolean }
  /** La diapositiva ya no se ve; `dropped` = la cortó una navegación manual. */
  | { type: 'left'; index: number; dropped: boolean }
  /** Se omite una diapositiva que no se pudo cargar (toast, §17.4). */
  | { type: 'skipped'; index: number }
  /** Única diapositiva en bucle: un vídeo vuelve a empezar. */
  | { type: 'replay'; index: number }
  | { type: 'paused' }
  | { type: 'resumed' }
  /** Sin bucle, acabó la última (capa «Fin de la presentación»). */
  | { type: 'finished' }
  /** No se pudo cargar ninguna (§17.10). */
  | { type: 'failed-all' };

export type SnapshotPhase = 'idle' | 'preparing' | 'entering' | 'showing' | 'finished' | 'failed';

export interface SchedulerSnapshot {
  /** Diapositiva que entra o se muestra; en `preparing`, la que se espera. */
  index: number | null;
  phase: SnapshotPhase;
  leavingIndex: number | null;
  /** Diapositiva esperada para cambiar a ella. */
  pendingIndex: number | null;
  paused: boolean;
  total: number;
}

export interface SchedulerDeps {
  timers?: Timers;
  rng?: Rng;
}

type TimerKind = 'enter-end' | 'show-end' | 'wait-timeout';

interface ActiveTimer {
  kind: TimerKind;
  handle: unknown;
  deadline: number;
  gen: number;
}

interface Pending {
  index: number;
  direction: Direction;
  manual: boolean;
}

type Target =
  { kind: 'index'; index: number } | { kind: 'self' } | { kind: 'end' } | { kind: 'none' };

type Status = 'idle' | 'running' | 'finished' | 'failed';

export class PresentationScheduler {
  private settings: SchedulerSettings;
  private readonly timers: Timers;
  private readonly picker: TransitionPicker;
  private readonly listeners = new Set<(event: SchedulerEvent) => void>();
  private queue: SchedulerEvent[] = [];
  private draining = false;

  private status: Status = 'idle';
  private current: number | null = null;
  private currentPhase: 'entering' | 'showing' = 'showing';
  private leaving: number | null = null;
  private pending: Pending | null = null;
  private readonly ready = new Set<number>();
  private readonly requested = new Set<number>();
  private readonly failedSet = new Set<number>();

  private timer: ActiveTimer | null = null;
  private frozen: { kind: TimerKind; remaining: number } | null = null;
  private timerGen = 0;
  private paused = false;
  private dueAdvance = false;

  constructor(
    private readonly slides: readonly SlideSpec[],
    settings: Partial<SchedulerSettings> = {},
    deps: SchedulerDeps = {},
  ) {
    this.settings = { ...DEFAULT_SCHEDULER_SETTINGS, ...settings };
    this.timers = deps.timers ?? realTimers;
    this.picker = new TransitionPicker(deps.rng ?? Math.random);
  }

  // ---- Suscripción y estado ----

  subscribe(listener: (event: SchedulerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): SchedulerSnapshot {
    let phase: SnapshotPhase;
    if (this.status === 'idle') phase = 'idle';
    else if (this.status === 'finished') phase = 'finished';
    else if (this.status === 'failed') phase = 'failed';
    else phase = this.current === null ? 'preparing' : this.currentPhase;
    return {
      index: this.current ?? this.pending?.index ?? null,
      phase,
      leavingIndex: this.leaving,
      pendingIndex: this.pending?.index ?? null,
      paused: this.paused,
      total: this.slides.length,
    };
  }

  getSettings(): Readonly<SchedulerSettings> {
    return this.settings;
  }

  /** La transición y la duración se aplican desde la siguiente diapositiva; `loop`, al momento. */
  updateSettings(partial: Partial<SchedulerSettings>): void {
    this.run(() => {
      const loopChanged = partial.loop !== undefined && partial.loop !== this.settings.loop;
      this.settings = { ...this.settings, ...partial };
      if (
        loopChanged &&
        this.status === 'running' &&
        this.current !== null &&
        this.currentPhase === 'showing' &&
        !this.pending
      ) {
        this.preloadNext();
      }
    });
  }

  // ---- Ciclo de vida ----

  /** Empieza (o vuelve a empezar) por `index`. */
  start(index = 0): void {
    this.run(() => {
      this.clearTimer();
      this.current = null;
      this.leaving = null;
      this.pending = null;
      this.ready.clear();
      this.requested.clear();
      this.failedSet.clear();
      this.paused = false;
      this.dueAdvance = false;
      if (this.slides.length === 0) {
        this.failAll();
        return;
      }
      this.status = 'running';
      const first = Math.min(this.slides.length - 1, Math.max(0, Math.trunc(index) || 0));
      this.goTo({ index: first, direction: 'forward', manual: false });
    });
  }

  /** «Volver a empezar» de la capa final. */
  restart(): void {
    this.start(0);
  }

  destroy(): void {
    this.clearTimer();
    this.status = 'idle';
    this.current = null;
    this.leaving = null;
    this.pending = null;
    this.queue = [];
    this.listeners.clear();
  }

  // ---- Eventos del anfitrión ----

  loaded(index: number): void {
    this.run(() => {
      if (this.status !== 'running' || !this.valid(index)) return;
      this.failedSet.delete(index);
      this.requested.add(index);
      this.ready.add(index);
      if (this.pending?.index === index) {
        this.clearTimer();
        this.tryBegin();
      }
    });
  }

  /** No cargó (404/500/timeout) o falló al reproducirse. */
  failed(index: number): void {
    this.run(() => {
      if (this.status !== 'running' || !this.valid(index)) return;
      if (this.pending?.index === index) {
        this.skipPending();
        return;
      }
      const wasShowing = index === this.current && this.currentPhase === 'showing' && !this.pending;
      this.markFailed(index);
      if (this.status !== 'running' || !wasShowing) return;
      if (this.paused) this.dueAdvance = true;
      else this.advance();
    });
  }

  /** El vídeo de la diapositiva llegó al final. */
  ended(index: number): void {
    this.run(() => {
      if (
        this.status !== 'running' ||
        index !== this.current ||
        this.currentPhase !== 'showing' ||
        this.slides[index].kind !== 'video' ||
        this.pending
      ) {
        return;
      }
      if (this.paused) this.dueAdvance = true;
      else this.advance();
    });
  }

  // ---- Órdenes del usuario ----

  /** Siguiente diapositiva. false = no hay (borde sin bucle, una sola, terminada). */
  next(): boolean {
    return this.manual('forward');
  }

  prev(): boolean {
    return this.manual('back');
  }

  /** Congela el tiempo que queda; el anfitrión pausa vídeo, música y animaciones. */
  pause(): void {
    this.run(() => {
      if (this.status !== 'running' || this.paused) return;
      this.paused = true;
      const t = this.timer;
      if (t) {
        this.timers.clearTimeout(t.handle);
        this.timer = null;
        this.frozen = { kind: t.kind, remaining: Math.max(0, t.deadline - this.timers.now()) };
      }
      this.emit({ type: 'paused' });
    });
  }

  resume(): void {
    this.run(() => {
      if (this.status !== 'running' || !this.paused) return;
      this.paused = false;
      this.emit({ type: 'resumed' });
      if (this.frozen) {
        const f = this.frozen;
        this.frozen = null;
        this.startTimer(f.kind, f.remaining);
      }
      if (this.dueAdvance) {
        this.dueAdvance = false;
        this.advance();
      }
      this.tryBegin();
    });
  }

  togglePause(): void {
    if (this.paused) this.resume();
    else this.pause();
  }

  // ---- Internos ----

  private run<T>(fn: () => T): T {
    const result = fn();
    this.flush();
    return result;
  }

  private emit(event: SchedulerEvent): void {
    this.queue.push(event);
  }

  private flush(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let e = this.queue.shift(); e !== undefined; e = this.queue.shift()) {
        for (const listener of [...this.listeners]) listener(e);
      }
    } finally {
      this.draining = false;
    }
  }

  private valid(index: number): boolean {
    return Number.isInteger(index) && index >= 0 && index < this.slides.length;
  }

  private slideDuration(index: number): number {
    const own = this.slides[index].durationMs;
    return own !== undefined && Number.isFinite(own) && own > 0 ? own : this.settings.slideMs;
  }

  // Temporizadores. Con `paused`, un temporizador nuevo queda congelado salvo `runWhilePaused`
  // (la navegación manual en pausa sí hace su transición; el tiempo de la foto sigue congelado).
  private arm(kind: TimerKind, ms: number, runWhilePaused = false): void {
    this.clearTimer();
    if (this.paused && !runWhilePaused) {
      this.frozen = { kind, remaining: ms };
      return;
    }
    this.startTimer(kind, ms);
  }

  private startTimer(kind: TimerKind, ms: number): void {
    const gen = ++this.timerGen;
    const handle = this.timers.setTimeout(() => {
      if (this.timer?.gen !== gen) return;
      this.timer = null;
      this.run(() => this.onTimer(kind));
    }, ms);
    this.timer = { kind, handle, deadline: this.timers.now() + ms, gen };
  }

  private clearTimer(): void {
    if (this.timer) this.timers.clearTimeout(this.timer.handle);
    this.timer = null;
    this.frozen = null;
  }

  private onTimer(kind: TimerKind): void {
    if (this.status !== 'running') return;
    if (kind === 'enter-end') this.finishEntering(false);
    else if (kind === 'show-end') this.advance();
    else this.skipPending();
  }

  private request(index: number): void {
    if (this.requested.has(index)) return;
    this.requested.add(index);
    this.emit({ type: 'prepare', index });
  }

  private release(index: number): void {
    this.ready.delete(index);
    this.requested.delete(index);
  }

  /** Busca la siguiente diapositiva válida (sin las que fallaron) en esa dirección. */
  private findTarget(base: number, direction: Direction): Target {
    const n = this.slides.length;
    const step = direction === 'forward' ? 1 : -1;
    for (let k = 1; k <= n; k += 1) {
      let i = base + step * k;
      if (i < 0 || i >= n) {
        if (!this.settings.loop) return { kind: 'end' };
        i = ((i % n) + n) % n;
      }
      if (i === base) return this.failedSet.has(base) ? { kind: 'none' } : { kind: 'self' };
      if (!this.failedSet.has(i)) return { kind: 'index', index: i };
    }
    return { kind: 'none' };
  }

  private preloadNext(): void {
    if (this.current === null) return;
    const t = this.findTarget(this.current, 'forward');
    if (t.kind === 'index') this.request(t.index);
  }

  /** Quiere cambiar a `p.index`: pide su carga y empieza en cuanto esté lista. */
  private goTo(p: Pending): void {
    this.clearTimer();
    this.pending = p;
    this.request(p.index);
    if (this.ready.has(p.index)) {
      this.tryBegin();
      return;
    }
    this.arm('wait-timeout', READY_TIMEOUT_MS, p.manual);
  }

  private tryBegin(): void {
    const p = this.pending;
    if (!p || !this.ready.has(p.index)) return;
    // En pausa solo empieza una transición pedida a mano.
    if (this.paused && !p.manual) return;
    this.beginTransition(p);
  }

  private beginTransition(p: Pending): void {
    this.clearTimer();
    this.pending = null;
    this.dropLeaving();
    const from = this.current;
    const to = p.index;
    const toKind = this.slides[to].kind;
    const plan = this.picker.next({
      setting: this.settings.transition,
      randomPool: this.settings.randomPool,
      transitionMs: this.settings.transitionMs,
      slideMs: this.slideDuration(to),
      slideKind: toKind,
      direction: p.direction,
      reducedMotion: this.settings.reducedMotion,
      kenBurns: this.settings.kenBurns,
    });
    this.current = to;
    this.currentPhase = 'entering';
    this.leaving = from;
    this.emit({
      type: 'transition',
      from,
      to,
      fromKind: from === null ? null : this.slides[from].kind,
      toKind,
      direction: p.direction,
      manual: p.manual,
      plan,
    });
    if (plan.durationMs <= 0) this.finishEntering(false);
    else this.arm('enter-end', plan.durationMs, p.manual);
  }

  /** Navegación manual en mitad de otra transición: la capa saliente se corta. */
  private dropLeaving(): void {
    if (this.leaving === null) return;
    const dropped = this.leaving;
    this.leaving = null;
    this.release(dropped);
    this.emit({ type: 'left', index: dropped, dropped: true });
  }

  private finishEntering(early: boolean): void {
    this.clearTimer();
    const cur = this.current;
    if (cur === null) return;
    this.currentPhase = 'showing';
    if (this.leaving !== null) {
      const left = this.leaving;
      this.leaving = null;
      this.release(left);
      this.emit({ type: 'left', index: left, dropped: false });
    }
    const kind = this.slides[cur].kind;
    this.emit({ type: 'showing', index: cur, kind, early });
    this.preloadNext();
    if (kind === 'photo') this.arm('show-end', this.slideDuration(cur));
  }

  /** Se acabó el tiempo de la foto, `ended` del vídeo o falló la actual: sigue la siguiente. */
  private advance(): void {
    if (
      this.status !== 'running' ||
      this.current === null ||
      this.currentPhase !== 'showing' ||
      this.pending
    ) {
      return;
    }
    this.dueAdvance = false;
    this.route(this.findTarget(this.current, 'forward'), 'forward', false);
  }

  private route(target: Target, direction: Direction, manual: boolean): void {
    switch (target.kind) {
      case 'index':
        if (target.index === this.current) this.selfLoop();
        else this.goTo({ index: target.index, direction, manual });
        return;
      case 'self':
        this.selfLoop();
        return;
      case 'end':
        if (this.current === null) this.failAll();
        else if (direction === 'forward') this.finish();
        else this.abandon();
        return;
      case 'none':
        this.failAll();
        return;
    }
  }

  /** Una sola diapositiva válida en bucle: la foto reinicia su tiempo y el vídeo vuelve a empezar. */
  private selfLoop(): void {
    const cur = this.current;
    if (cur === null) return;
    this.clearTimer();
    if (this.slides[cur].kind === 'photo') this.arm('show-end', this.slideDuration(cur));
    else this.emit({ type: 'replay', index: cur });
  }

  /** Cancela el cambio pendiente y sigue con la diapositiva que se ve. */
  private abandon(): void {
    this.clearTimer();
    this.pending = null;
    const cur = this.current;
    if (cur !== null && this.currentPhase === 'showing' && this.slides[cur].kind === 'photo') {
      this.arm('show-end', this.slideDuration(cur));
    }
  }

  private finish(): void {
    this.clearTimer();
    this.pending = null;
    this.status = 'finished';
    this.emit({ type: 'finished' });
  }

  private failAll(): void {
    this.clearTimer();
    this.pending = null;
    this.status = 'failed';
    this.emit({ type: 'failed-all' });
  }

  private markFailed(index: number): void {
    this.ready.delete(index);
    if (!this.failedSet.has(index)) {
      this.failedSet.add(index);
      this.emit({ type: 'skipped', index });
    }
    if (this.failedSet.size >= this.slides.length) this.failAll();
  }

  /** La esperada no llegó a tiempo (8 s) o falló: se omite y se busca la siguiente. */
  private skipPending(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.clearTimer();
    this.markFailed(p.index);
    if (this.status !== 'running') return;
    this.route(this.findTarget(p.index, p.direction), p.direction, p.manual);
  }

  private manual(direction: Direction): boolean {
    // Sin una diapositiva en pantalla (se está esperando la primera) no hay desde dónde navegar.
    if (this.status !== 'running' || this.slides.length <= 1 || this.current === null) return false;
    const base = this.pending ? this.pending.index : this.current;
    const t = this.findTarget(base, direction);
    if (t.kind !== 'index') return false;
    const target = t.index;
    return this.run(() => {
      this.dueAdvance = false;
      // Si la saliente era el destino, se corta antes de decidir si hay que volver a cargarla.
      this.dropLeaving();
      if (target === this.current) {
        // Volver atrás desde una espera: basta con cancelarla.
        this.abandon();
        return true;
      }
      if (this.current !== null && this.currentPhase === 'entering' && !this.ready.has(target)) {
        // Mientras llega la nueva, la que estaba entrando se queda como la actual.
        this.finishEntering(true);
      }
      this.goTo({ index: target, direction, manual: true });
      return true;
    });
  }
}
