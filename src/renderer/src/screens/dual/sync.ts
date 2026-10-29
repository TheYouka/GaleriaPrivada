// Sincronización de la reproducción dual (docs/DESIGN.md §18.1, PLAN.md 5.2). Sin React ni DOM: el
// controlador trabaja con dos "medios" (`SyncMedia`, que cumple un <video> envuelto) y un reloj
// inyectable, así que Vitest lo prueba con elementos falsos y un reloj falso.
//
// - El reloj maestro es el vídeo MÁS LARGO; el otro es el esclavo. La línea de tiempo común mide
//   `max(dL, dR)`.
// - Buscar a `t`: maestro en `t` y esclavo en `min(t, dEsclavo)`. Si `t ≥ dEsclavo`, el esclavo se
//   queda pausado en su último fotograma.
// - Cada 250 ms, mientras suenan los dos, `drift = esclavo − maestro`: si `|drift| > 0,5 s` el
//   esclavo salta al tiempo del maestro; si `0,04 < |drift| ≤ 0,5` su `playbackRate` pasa a
//   `rate · (1 − signo(drift) · 0,05)` hasta que `|drift| < 0,02` y vuelve a `rate`.
// - Si uno emite `waiting`, el otro se pausa hasta que los dos pueden seguir (`canplay`).
// - Con el bucle, cuando termina el maestro los dos vuelven a 0 (sin el atributo `loop` nativo, que
//   desincronizaría a los dos vídeos).
import { realTimers, type Timers } from '../presentation/scheduler';

export type Side = 'left' | 'right';

/** Período de la corrección de deriva. */
export const DRIFT_TICK_MS = 250;
/** Por encima de esta deriva el esclavo salta al tiempo del maestro. */
export const DRIFT_JUMP_S = 0.5;
/** Por encima de esta deriva (y hasta DRIFT_JUMP_S) se ajusta la velocidad del esclavo. */
export const DRIFT_ADJUST_MIN_S = 0.04;
/** Con el ajuste en marcha, por debajo de esta deriva se vuelve a la velocidad normal. */
export const DRIFT_SETTLE_S = 0.02;
/** ±5 % de velocidad para alcanzar al maestro. */
export const DRIFT_RATE_DELTA = 0.05;
/** A menos de esto del final se considera que el esclavo ya terminó. */
export const END_EPSILON_S = 0.05;
/** HAVE_FUTURE_DATA: el medio puede reproducir (`canplay`). */
export const HAVE_FUTURE_DATA = 3;

export type DriftAction =
  { kind: 'none' } | { kind: 'jump' } | { kind: 'adjust'; rate: number } | { kind: 'restore' };

/** `rate · (1 − signo(drift) · 0,05)`: el esclavo adelantado (drift > 0) va más despacio. */
export function adjustedRate(rate: number, drift: number): number {
  return rate * (1 - Math.sign(drift) * DRIFT_RATE_DELTA);
}

/**
 * Qué hacer con una deriva `drift = esclavo − maestro` (segundos). `adjusting`: el esclavo ya va con
 * la velocidad ajustada; entre 0,02 y 0,04 s se sigue ajustando (histéresis) y por debajo de 0,02 se
 * restablece.
 */
export function driftAction(drift: number, rate: number, adjusting: boolean): DriftAction {
  if (!Number.isFinite(drift)) return { kind: 'none' };
  const abs = Math.abs(drift);
  if (abs > DRIFT_JUMP_S) return { kind: 'jump' };
  if (abs > DRIFT_ADJUST_MIN_S) return { kind: 'adjust', rate: adjustedRate(rate, drift) };
  if (!adjusting) return { kind: 'none' };
  return abs < DRIFT_SETTLE_S
    ? { kind: 'restore' }
    : { kind: 'adjust', rate: adjustedRate(rate, drift) };
}

/** El vídeo más largo manda; con la misma duración (o sin conocerla), el izquierdo. */
export function masterSide(durationLeft: number, durationRight: number): Side {
  return durationRight > durationLeft ? 'right' : 'left';
}

/** Tiempo del esclavo al buscar a `t`: `min(t, dEsclavo)` (sin duración conocida, `t`). */
export function slaveSeekTime(t: number, slaveDuration: number): number {
  return slaveDuration > 0 && Number.isFinite(slaveDuration) ? Math.min(t, slaveDuration) : t;
}

/** Duración de la línea de tiempo común. */
export function timelineDuration(durationLeft: number, durationRight: number): number {
  return Math.max(durationLeft, durationRight, 0);
}

/** Lo que el controlador necesita de un vídeo (un <video> envuelto o uno falso). */
export interface SyncMedia {
  currentTime: number;
  /** En segundos; 0 si no se conoce. */
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  /** `HTMLMediaElement.readyState`. */
  readonly readyState: number;
  playbackRate: number;
  play(): Promise<void> | void;
  pause(): void;
}

export interface SyncDeps {
  timers?: Timers;
  /** El estado "reproduciendo" del conjunto cambió (incluye la pausa al terminar sin bucle). */
  onPlayingChange?(playing: boolean): void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export class SyncController {
  private readonly timers: Timers;
  private rate = 1;
  private loop = false;
  private wantPlaying = false;
  private crossPaused = false;
  private adjusting = false;
  private lastMaster: Side | null = null;
  private tickHandle: unknown = null;
  private disposed = false;

  constructor(
    private readonly left: SyncMedia,
    private readonly right: SyncMedia,
    private readonly deps: SyncDeps = {},
  ) {
    this.timers = deps.timers ?? realTimers;
  }

  /** El conjunto está (o debería estar) reproduciéndose. */
  get playing(): boolean {
    return this.wantPlaying;
  }

  get duration(): number {
    return timelineDuration(this.left.duration, this.right.duration);
  }

  get masterSide(): Side {
    return masterSide(this.left.duration, this.right.duration);
  }

  /** Posición común: la del maestro. */
  get time(): number {
    return this.master.currentTime;
  }

  private get master(): SyncMedia {
    return this.masterSide === 'left' ? this.left : this.right;
  }

  private get slave(): SyncMedia {
    return this.masterSide === 'left' ? this.right : this.left;
  }

  private setPlaying(on: boolean): void {
    if (this.wantPlaying === on) return;
    this.wantPlaying = on;
    this.deps.onPlayingChange?.(on);
  }

  private start(media: SyncMedia): void {
    if (!media.paused) return;
    void Promise.resolve(media.play()).catch(() => undefined);
  }

  /** El esclavo todavía tiene vídeo que mostrar en la posición actual. */
  private slaveInRange(): boolean {
    const slave = this.slave;
    if (slave.ended) return false;
    return !(slave.duration > 0) || slave.currentTime < slave.duration - END_EPSILON_S;
  }

  private restoreRate(): void {
    this.adjusting = false;
    this.left.playbackRate = this.rate;
    this.right.playbackRate = this.rate;
  }

  /** Velocidad (0,25×–2×) de los dos vídeos. */
  setRate(rate: number): void {
    this.rate = rate;
    this.restoreRate();
  }

  setLoop(on: boolean): void {
    this.loop = on;
  }

  private resume(): void {
    this.start(this.master);
    if (this.slaveInRange()) this.start(this.slave);
    else this.slave.pause();
  }

  play(): void {
    if (this.disposed) return;
    const total = this.duration;
    if (total > 0 && this.master.currentTime >= total - END_EPSILON_S) this.seek(0);
    this.crossPaused = false;
    this.setPlaying(true);
    this.resume();
    this.scheduleTick();
  }

  pause(): void {
    this.crossPaused = false;
    this.setPlaying(false);
    this.left.pause();
    this.right.pause();
    this.cancelTick();
    this.restoreRate();
  }

  toggle(): void {
    if (this.wantPlaying) this.pause();
    else this.play();
  }

  /** Busca a `t` en la línea de tiempo común (se acota a [0, duración]). */
  seek(t: number): void {
    if (this.disposed) return;
    const total = this.duration;
    const target = total > 0 ? clamp(t, 0, total) : Math.max(0, t);
    const master = this.master;
    const slave = this.slave;
    master.currentTime = target;
    slave.currentTime = slaveSeekTime(target, slave.duration);
    this.restoreRate();
    if (this.wantPlaying && !this.crossPaused) this.resume();
  }

  seekBy(delta: number): void {
    this.seek(this.time + delta);
  }

  /** Un tic de corrección de deriva (público para las pruebas; el reloj lo llama cada 250 ms). */
  tick(): void {
    this.tickHandle = null;
    if (this.disposed || !this.wantPlaying) return;
    if (!this.crossPaused) this.correct();
    this.scheduleTick();
  }

  private correct(): void {
    // Si el maestro cambia (las duraciones se conocen tarde), la velocidad ajustada ya no vale.
    const masterNow = this.masterSide;
    if (this.lastMaster !== null && this.lastMaster !== masterNow) this.restoreRate();
    this.lastMaster = masterNow;
    const master = this.master;
    const slave = this.slave;
    if (master.paused || slave.paused || !this.slaveInRange()) return;
    const action = driftAction(slave.currentTime - master.currentTime, this.rate, this.adjusting);
    switch (action.kind) {
      case 'jump':
        slave.currentTime = master.currentTime;
        this.restoreRate();
        break;
      case 'adjust':
        slave.playbackRate = action.rate;
        this.adjusting = true;
        break;
      case 'restore':
        this.restoreRate();
        break;
      case 'none':
        break;
    }
  }

  private scheduleTick(): void {
    if (this.tickHandle !== null || this.disposed) return;
    this.tickHandle = this.timers.setTimeout(() => this.tick(), DRIFT_TICK_MS);
  }

  private cancelTick(): void {
    if (this.tickHandle !== null) this.timers.clearTimeout(this.tickHandle);
    this.tickHandle = null;
  }

  /** `waiting` de un lado: el otro se pausa hasta que los dos puedan seguir. */
  handleWaiting(side: Side): void {
    if (this.disposed || !this.wantPlaying) return;
    if (side === this.slaveSide && !this.slaveInRange()) return;
    this.crossPaused = true;
    (side === 'left' ? this.right : this.left).pause();
  }

  /** `canplay` de un lado: con los dos listos, se reanudan. */
  handleCanPlay(): void {
    if (this.disposed || !this.wantPlaying || !this.crossPaused) return;
    if (this.left.readyState < HAVE_FUTURE_DATA || this.right.readyState < HAVE_FUTURE_DATA) return;
    this.crossPaused = false;
    this.resume();
  }

  /** `ended` de un lado: si es el maestro, bucle o pausa; el esclavo se queda en su último fotograma. */
  handleEnded(side: Side): void {
    if (this.disposed || !this.wantPlaying || side !== this.masterSide) return;
    this.crossPaused = false;
    if (this.loop) {
      this.seek(0);
    } else {
      this.pause();
    }
  }

  private get slaveSide(): Side {
    return this.masterSide === 'left' ? 'right' : 'left';
  }

  /** Deja de corregir y devuelve la velocidad normal; no pausa nada. */
  dispose(): void {
    if (this.disposed) return;
    this.restoreRate();
    this.disposed = true;
    this.cancelTick();
  }
}
