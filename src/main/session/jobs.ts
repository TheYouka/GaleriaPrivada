// Trabajos largos de una sesión desbloqueada (docs/DESIGN.md §12.11 y §13.3). JobRegistry es el
// único sitio que crea trabajos y aplica las reglas de concurrencia (BUSY) antes de abrir ningún
// diálogo. Cada sesión tiene su registro y su época [H3-6]: un trabajo pide la DB con
// SessionManager.getDb(handle.epoch), así que tras bloquear y volver a desbloquear recibe LOCKED.
//
// abortAll(reason) es síncrono (paso 2 de §13.3): dispara el AbortController de cada trabajo y el
// de la sesión (cola de miniaturas y barrido de huérfanos de F2). drained() se resuelve cuando todos
// los trabajos (también los abortados) han llamado a done().
import { randomBytes } from 'node:crypto';
import { AppErrorException } from '@shared/errors';
import type { Id, LockReason } from '@shared/types';

export type JobKind = 'import' | 'merge' | 'music-import' | 'edit' | 'relocate';

export interface JobHandle {
  readonly id: Id;
  readonly kind: JobKind;
  /** Época de la sesión al empezar [H3-6]. */
  readonly epoch: number;
  /** `edit`: el medio que se edita (uno por mediaId). */
  readonly mediaId: Id | null;
  readonly signal: AbortSignal;
  /** D18: fusiones e importaciones fuera de awaiting-confirmation pausan el auto-bloqueo. */
  setPausesAutoLock(on: boolean): void;
  /** Idempotente. Lo llama el trabajo al terminar, también tras abortarse. */
  done(): void;
}

export interface JobRegistryOptions {
  epoch: number;
  /** true si algún trabajo activo pausa el auto-bloqueo (motivo 'job'). */
  onPauseChange?: (paused: boolean) => void;
  newId?: () => Id;
}

interface Job extends JobHandle {
  controller: AbortController;
  pauses: boolean;
}

/** Como mucho uno de cada tipo; `edit`, uno por medio; `relocate` no coexiste con nada (§12.11). */
function allowed(kind: JobKind, mediaId: Id | null, active: readonly Job[]): boolean {
  if (active.some((j) => j.kind === 'relocate')) return false;
  if (kind === 'relocate') return active.length === 0;
  if (kind === 'edit') return !active.some((j) => j.kind === 'edit' && j.mediaId === mediaId);
  return !active.some((j) => j.kind === kind);
}

export class JobRegistry {
  readonly epoch: number;
  private readonly jobs = new Map<Id, Job>();
  private readonly session = new AbortController();
  private readonly onPauseChange: (paused: boolean) => void;
  private readonly newId: () => Id;
  private paused = false;
  private waiters: (() => void)[] = [];

  constructor(options: JobRegistryOptions) {
    this.epoch = options.epoch;
    this.onPauseChange = options.onPauseChange ?? (() => undefined);
    this.newId = options.newId ?? (() => randomBytes(16).toString('hex'));
  }

  /** Señal de la sesión: la cola de miniaturas y el barrido de huérfanos (F2) la usan. */
  get sessionSignal(): AbortSignal {
    return this.session.signal;
  }

  get aborted(): boolean {
    return this.session.signal.aborted;
  }

  /** BUSY si las reglas de §12.11 no lo permiten; LOCKED si la sesión ya se abortó. */
  start(kind: JobKind, options: { mediaId?: Id } = {}): JobHandle {
    if (this.aborted) throw new AppErrorException({ code: 'LOCKED' });
    const mediaId = kind === 'edit' ? (options.mediaId ?? null) : null;
    if (kind === 'edit' && !mediaId) throw new RangeError('edit necesita mediaId');
    if (!allowed(kind, mediaId, [...this.jobs.values()])) {
      throw new AppErrorException({ code: 'BUSY' });
    }
    const controller = new AbortController();
    const id = this.newId();
    const job: Job = {
      id,
      kind,
      epoch: this.epoch,
      mediaId,
      signal: controller.signal,
      controller,
      pauses: false,
      setPausesAutoLock: (on) => {
        if (!this.jobs.has(id)) return;
        job.pauses = on;
        this.updatePause();
      },
      done: () => {
        if (!this.jobs.delete(id)) return;
        this.updatePause();
        if (this.jobs.size === 0) this.flushWaiters();
      },
    };
    this.jobs.set(id, job);
    return job;
  }

  active(kind?: JobKind): JobHandle[] {
    const all = [...this.jobs.values()];
    return kind ? all.filter((j) => j.kind === kind) : all;
  }

  /** Síncrono: aborta la sesión y todos los trabajos (paso 2 de §13.3). */
  abortAll(reason: LockReason): void {
    if (!this.session.signal.aborted) this.session.abort(reason);
    for (const job of this.jobs.values()) {
      if (!job.signal.aborted) job.controller.abort(reason);
    }
  }

  /** Se resuelve cuando no queda ningún trabajo sin llamar a done() [H3-6]. */
  drained(): Promise<void> {
    if (this.jobs.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private flushWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  private updatePause(): void {
    const paused = [...this.jobs.values()].some((j) => j.pauses);
    if (paused !== this.paused) {
      this.paused = paused;
      this.onPauseChange(paused);
    }
  }
}
