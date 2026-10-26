// Sesión y bloqueo (docs/DESIGN.md §13). Máquina de estados
//   locked → unlocking → unlocked → locking → locked
// con una época creciente por sesión [H3-6]. SessionManager es el único dueño del KeyRing y de la
// DB abierta: getDb(epoch) / getKeyRing(epoch) lanzan LOCKED si no hay sesión o si la época no es la
// actual (los IPC usan la actual; los trabajos, la de su JobHandle).
//
// Principio del bloqueo (§13.3): las claves se ponen a cero sin esperar a los trabajos. Con
// suspend, os-lock, error y vault-unavailable los pasos 1–4 (velo, abortar, espera de 0 ms, claves
// y DB) se ejecutan de forma síncrona dentro de lock(), antes de devolver el control al bucle de
// eventos. Con manual, inactivity y shutdown se espera como mucho 2 s a que los trabajos abortados
// llamen a done(); si mientras tanto llega un motivo inmediato, el paso 4 se hace en ese momento.
//
// Este módulo no importa `electron` en tiempo de ejecución: la ventana y los disparadores se
// inyectan (index.ts), así se prueba en Vitest con fakes.
import { stat } from 'node:fs/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { App, Dialog, PowerMonitor } from 'electron';
import { AppErrorException } from '@shared/errors';
import type { Id, LockReason, ProfilePrefs, SessionState } from '@shared/types';
import { deriveKek as defaultDeriveKek } from '../crypto/kdf';
import { KeyRing, unwrapMasterKey } from '../crypto/keys';
import type { ObjectReader } from '../crypto/object-reader';
import type { ObjectWriter } from '../crypto/object-writer';
import { zeroize } from '../crypto/secure-buffer';
import { closeDatabase, openDatabase as defaultOpenDatabase, type Db } from '../db/database';
import { migrate as defaultMigrate } from '../db/migrate';
import { log } from '../log';
import {
  kdfParamsOf,
  masterKeyWrapOf,
  saltOf,
  type StoredProfile,
} from '../profiles/profile-store';
import { readVaultJson, vaultPaths } from '../vault/vault-layout';
import { AutoLock } from './auto-lock';
import { JobRegistry, type JobHandle, type JobKind } from './jobs';
import { KeylessCleanup, relocateCommitKey } from './keyless-cleanup';

/** Espera acotada del paso 3 con manual, inactivity y shutdown. */
export const LOCK_WAIT_MS = 2000;
/** El desbloqueo espera el drained() de la sesión anterior como mucho esto [H3-6]. */
export const DRAIN_WAIT_MS = 5000;
/** Vigilante de vault.json (§13.2). */
export const VAULT_WATCH_MS = 10_000;
/** Linux: consulta de getSystemIdleState(60) (§13.2). */
export const LINUX_LOCK_POLL_MS = 5000;
/** Paso 1 del desbloqueo: espera a los pasos 5–6 de un traslado sin claves (§13.1); si no, IO. */
export const RELOCATE_COMMIT_WAIT_MS = 10_000;

/** Resolución del medidor del bucle de eventos de E2E (2.14, R6). */
export const LOOP_DELAY_RESOLUTION_MS = 10;

/**
 * Gancho de medición de carga del hilo main (PLAN.md 2.14, R6). Solo con `exposeTestHooks`
 * (GALERIA_E2E=1 sin empaquetar). `perf_hooks.monitorEventLoopDelay()` registra el intervalo real de
 * un temporizador de 10 ms: un bloqueo de B ms aparece como ≈ 10 + B ms. `snapshot()` devuelve
 * milisegundos y `blockedMs` ya descuenta la resolución; `reset()` vacía el histograma entre medidas.
 */
export interface LoopDelaySnapshot {
  count: number;
  resolutionMs: number;
  p50Ms: number;
  p99Ms: number;
  p999Ms: number;
  maxMs: number;
  /** El bloqueo más largo del hilo main: `maxMs` menos la resolución del temporizador. */
  blockedMs: number;
}

function installLoopDelayHook(): void {
  const g = globalThis as {
    __galeriaLoopDelay?: { reset(): void; snapshot(): LoopDelaySnapshot };
  };
  if (g.__galeriaLoopDelay) return;
  const histogram = monitorEventLoopDelay({ resolution: LOOP_DELAY_RESOLUTION_MS });
  histogram.enable();
  const ms = (ns: number): number => Math.round((ns / 1e6) * 100) / 100;
  g.__galeriaLoopDelay = {
    reset: () => histogram.reset(),
    snapshot: () => {
      const maxMs = ms(histogram.max);
      return {
        count: histogram.count,
        resolutionMs: LOOP_DELAY_RESOLUTION_MS,
        p50Ms: ms(histogram.percentile(50)),
        p99Ms: ms(histogram.percentile(99)),
        p999Ms: ms(histogram.percentile(99.9)),
        maxMs,
        blockedMs: Math.max(0, Math.round((maxMs - LOOP_DELAY_RESOLUTION_MS) * 100) / 100),
      };
    },
  };
}

/** Motivos con espera de 0 ms y pasos 1–4 síncronos. */
const IMMEDIATE: ReadonlySet<LockReason> = new Set([
  'suspend',
  'os-lock',
  'error',
  'vault-unavailable',
]);

export interface UnlockTarget {
  profile: StoredProfile;
  /** Carpeta configurada (la que contiene vault.json). */
  vaultDir: string;
}

/** La ventana, vista desde la sesión (window.ts en producción). Ninguna llamada debe lanzar. */
export interface SessionUi {
  /** Paso 1: evento session:locking a la ventana actual (el renderer pinta el velo opaco). */
  sendLocking(reason: LockReason): void;
  /** Paso 1 con suspend y os-lock: win.hide() nativo y síncrono. */
  hide(): void;
  /** Paso 5: evento session:locked a la ventana que se va a sustituir. */
  sendLocked(reason: LockReason): void;
  /** Paso 5 (salvo shutdown): ventana nueva con un proceso de renderer nuevo (§13.3). */
  replaceWindow(): void;
  /** D15 (§5.2). */
  setContentProtection(on: boolean): void;
}

export interface UnlockResult {
  profile: StoredProfile;
  prefs: ProfilePrefs;
}

export interface ReconcileContext {
  epoch: number;
  profileId: Id;
  db: Db;
  vaultDir: string;
  signal: AbortSignal;
}

export interface SessionDeps {
  /** Perfil y carpeta de su bóveda; PROFILE_NOT_FOUND si no existe. */
  loadProfile(profileId: Id): Promise<UnlockTarget>;
  readPrefs(profileId: Id): Promise<ProfilePrefs>;
  ui: SessionUi;
  keyless?: KeylessCleanup;
  deriveKek?: typeof defaultDeriveKek;
  openDatabase?: typeof defaultOpenDatabase;
  migrate?: (db: Db, dbPath: string) => void;
  /** Paso 6 del desbloqueo: reconciliar (§12.6). Gancho vacío hasta F2. */
  reconcile?: (ctx: ReconcileContext) => Promise<void>;
  /** Vigilante: rechaza si vault.json no está accesible. */
  statVaultJson?: (path: string) => Promise<void>;
  now?: () => number;
  /**
   * Solo E2E sin empaquetar (GALERIA_TEST_AUTOLOCK_MS): sustituye el tiempo del auto-bloqueo
   * cuando prefs.autoLockMinutes > 0.
   */
  testAutoLockMs?: number;
  /** Solo E2E sin empaquetar (GALERIA_E2E=1): expone globalThis.__galeriaLastZeroizeMs. */
  exposeTestHooks?: boolean;
}

type Phase = SessionState['state'];

interface Attempt {
  cancelled: boolean;
}

interface LockInFlight {
  promise: Promise<void>;
  /** Hace el paso 4 ya (un motivo inmediato llegó durante la espera). */
  finish(at: number): void;
}

const locked = (): AppErrorException => new AppErrorException({ code: 'LOCKED' });

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // el bloqueo nunca se detiene por la ventana
  }
}

export class SessionManager {
  private phase: Phase = 'locked';
  private profileId: Id | null = null;
  private maintenance: { jobId: Id } | null = null;
  private epochValue = 0;
  private keyRing: KeyRing | null = null;
  private db: Db | null = null;
  private vaultDirValue: string | null = null;
  private jobs: JobRegistry | null = null;
  private previousJobs: JobRegistry | null = null;
  private attempt: Attempt | null = null;
  private lockInFlight: LockInFlight | null = null;
  private readonly readers = new Set<ObjectReader>();
  private readonly writers = new Map<ObjectWriter, string | undefined>();
  private readonly autoLock: AutoLock;
  private watcher: ReturnType<typeof setInterval> | null = null;
  private readonly keyless: KeylessCleanup;
  private readonly now: () => number;
  private lastZeroize: number | null = null;

  constructor(private readonly deps: SessionDeps) {
    this.keyless = deps.keyless ?? new KeylessCleanup();
    this.now = deps.now ?? (() => performance.now());
    this.autoLock = new AutoLock(() => {
      void this.lock('inactivity');
    });
    if (deps.exposeTestHooks) installLoopDelayHook();
  }

  // ── Estado ───────────────────────────────────────────────────────────────────────────────────

  get state(): Phase {
    return this.phase;
  }

  /** Época de la sesión actual (o de la última). */
  get epoch(): number {
    return this.epochValue;
  }

  get isUnlocked(): boolean {
    return this.phase === 'unlocked';
  }

  get inMaintenance(): boolean {
    return this.phase === 'unlocked' && this.maintenance !== null;
  }

  /** Perfil de la sesión en curso (desbloqueando, desbloqueada o bloqueándose), o null. */
  get currentProfileId(): Id | null {
    return this.profileId;
  }

  /** Milisegundos entre el disparador y el fin del paso 4 del último bloqueo (§13.3). */
  get lastZeroizeMs(): number | null {
    return this.lastZeroize;
  }

  get cleanup(): KeylessCleanup {
    return this.keyless;
  }

  getState(): SessionState {
    switch (this.phase) {
      case 'locked':
        return { state: 'locked' };
      case 'unlocked':
        return {
          state: 'unlocked',
          profileId: this.profileId as Id,
          maintenance: this.maintenance ? { ...this.maintenance } : null,
        };
      default:
        return { state: this.phase, profileId: this.profileId as Id };
    }
  }

  /** La DB de la sesión. LOCKED si no hay DB abierta o si `epoch` no es la actual [H3-6]. */
  getDb(epoch?: number): Db {
    if (!this.db || (epoch !== undefined && epoch !== this.epochValue)) throw locked();
    return this.db;
  }

  /** El KeyRing de la sesión, con la misma regla de época que getDb. */
  getKeyRing(epoch?: number): KeyRing {
    if (!this.keyRing || (epoch !== undefined && epoch !== this.epochValue)) throw locked();
    return this.keyRing;
  }

  /** Carpeta de la bóveda de la sesión, con la misma regla de época que getDb. */
  getVaultDir(epoch?: number): string {
    if (!this.vaultDirValue || (epoch !== undefined && epoch !== this.epochValue)) throw locked();
    return this.vaultDirValue;
  }

  /**
   * Señal de la sesión (se aborta en el paso 2 del bloqueo, §13.3): vault:// la usa para cortar con
   * controller.error() los streams abiertos (§11.5). Misma regla de época que getDb.
   */
  getSessionSignal(epoch?: number): AbortSignal {
    if (!this.jobs || (epoch !== undefined && epoch !== this.epochValue)) throw locked();
    return this.jobs.sessionSignal;
  }

  /** Nuevo trabajo con las reglas de §12.11. LOCKED si la sesión no está desbloqueada. */
  startJob(kind: JobKind, options: { mediaId?: Id } = {}): JobHandle {
    if (this.phase !== 'unlocked' || !this.jobs) throw locked();
    return this.jobs.start(kind, options);
  }

  /** Writers abiertos: el paso 4 llama a destroyKeys() y el 6 a abort() (borra el .part). */
  registerWriter(writer: ObjectWriter, tmpPath?: string, epoch?: number): () => void {
    this.assertLive(epoch, () => writer.destroyKeys());
    this.writers.set(writer, tmpPath);
    return () => {
      this.writers.delete(writer);
    };
  }

  /** Readers abiertos: el paso 4 llama a destroyKeys() y el 6 a close(). */
  registerReader(reader: ObjectReader, epoch?: number): () => void {
    this.assertLive(epoch, () => reader.destroyKeys());
    this.readers.add(reader);
    return () => {
      this.readers.delete(reader);
    };
  }

  private assertLive(epoch: number | undefined, kill: () => void): void {
    const live = this.keyRing !== null && (epoch === undefined || epoch === this.epochValue);
    if (!live) {
      kill();
      throw locked();
    }
  }

  // ── Actividad y preferencias ─────────────────────────────────────────────────────────────────

  /** session:activity (el renderer lo envía como mucho una vez cada 10 s). */
  activity(): void {
    if (this.phase === 'unlocked') this.autoLock.activity();
  }

  /** session:setPlayback (D12): una presentación o un vídeo pausan el auto-bloqueo. */
  setPlayback(active: boolean): void {
    if (this.phase !== 'unlocked') return;
    if (active) this.autoLock.pause('playback');
    else this.autoLock.resume('playback');
  }

  /** prefs:set: nuevo tiempo de inactividad y protección de contenido (D15) al momento. */
  applyPrefs(prefs: ProfilePrefs): void {
    if (this.phase !== 'unlocked') return;
    this.autoLock.setTimeoutMs(this.autoLockMs(prefs));
    safely(() => this.deps.ui.setContentProtection(prefs.contentProtection));
  }

  /** Motivos de pausa actuales del auto-bloqueo (tests y diagnóstico). */
  get autoLockPauseReasons(): string[] {
    return this.autoLock.pauseReasons;
  }

  get autoLockRunning(): boolean {
    return this.autoLock.running;
  }

  private autoLockMs(prefs: ProfilePrefs): number {
    if (prefs.autoLockMinutes === 0) return 0;
    return this.deps.testAutoLockMs ?? prefs.autoLockMinutes * 60_000;
  }

  // ── Desbloqueo (§13.1) ───────────────────────────────────────────────────────────────────────

  /**
   * Desbloquea `profileId` con `password` (que se pone a cero al terminar). Errores:
   * PROFILE_NOT_FOUND, VAULT_UNAVAILABLE { path }, WRONG_PASSWORD, VAULT_CORRUPT { stage },
   * INTERNAL { reason: 'kdf-memory' }, BUSY (otro desbloqueo en curso) y LOCKED (un bloqueo llegó
   * a mitad). Si falla cualquier paso se deshace todo lo anterior y se vuelve a `locked`.
   */
  async unlock(profileId: Id, password: Uint8Array): Promise<UnlockResult> {
    try {
      if (this.phase === 'unlocking') throw new AppErrorException({ code: 'BUSY' });
      if (this.lockInFlight) await this.lockInFlight.promise;
      if (this.phase === 'unlocked') await this.lock('manual'); // otro perfil (o el mismo)
      if (this.phase !== 'locked') throw new AppErrorException({ code: 'BUSY' });
      return await this.runUnlock(profileId, password);
    } finally {
      zeroize(password);
    }
  }

  private async runUnlock(profileId: Id, password: Uint8Array): Promise<UnlockResult> {
    const attempt: Attempt = { cancelled: false };
    this.attempt = attempt;
    this.phase = 'unlocking';
    this.profileId = profileId;
    const epoch = ++this.epochValue;
    const check = (): void => {
      if (attempt.cancelled) throw locked();
    };
    let kek: Buffer | null = null;
    let mk: Buffer | null = null;
    try {
      // 1. Trabajos de la sesión anterior [H3-6], pasos 5–6 de un traslado sin claves de este
      //    perfil (para leer ya la ruta definitiva de profiles.json, §13.1) y perfil.
      await this.waitPreviousDrained();
      check();
      await this.waitRelocateCommit(profileId);
      check();
      const target = await this.deps.loadProfile(profileId);
      check();

      // 2. vault.json (la ruta configurada ya está en claro en profiles.json, [H3-8]).
      const vault = await readVaultJson(target.vaultDir);
      check();
      if (!vault || vault.profileId !== profileId) {
        log.warn('vault.unavailable', { stage: 'unlock' });
        throw new AppErrorException({
          code: 'VAULT_UNAVAILABLE',
          details: { path: target.vaultDir },
        });
      }
      const prefs = await this.deps.readPrefs(profileId);
      check();

      // 3. Argon2id y desenvolver la MK.
      const derive = this.deps.deriveKek ?? defaultDeriveKek;
      const { profile } = target;
      kek = await derive(password, saltOf(profile), kdfParamsOf(profile));
      check();
      try {
        mk = unwrapMasterKey(
          masterKeyWrapOf(profile),
          kek,
          profileId,
          kdfParamsOf(profile),
          saltOf(profile),
        );
      } catch (err) {
        log.info('session.wrong-password');
        throw err;
      }
      zeroize(kek);
      kek = null;

      // 4. HKDF → KeyRing (toma posesión de la MK).
      this.keyRing = new KeyRing(mk, profileId);
      mk = null;

      // 5. DB y migraciones.
      const dbPath = vaultPaths(target.vaultDir).db;
      const open = this.deps.openDatabase ?? defaultOpenDatabase;
      this.db = open(dbPath, this.keyRing.kDb, { creating: false });
      (this.deps.migrate ?? defaultMigrate)(this.db, dbPath);
      this.vaultDirValue = target.vaultDir;
      const registry: JobRegistry = new JobRegistry({
        epoch,
        onPauseChange: (paused) => {
          // Un trabajo de una sesión anterior nunca toca el auto-bloqueo de la actual.
          if (this.jobs !== registry) return;
          if (paused) this.autoLock.pause('job');
          else this.autoLock.resume('job');
        },
      });
      this.jobs = registry;

      // 6. Reconciliar (F2).
      if (this.deps.reconcile) {
        await this.deps.reconcile({
          epoch,
          profileId,
          db: this.db,
          vaultDir: target.vaultDir,
          signal: this.jobs.sessionSignal,
        });
        check();
      }

      // 7. Auto-bloqueo, vigilante y protección de contenido (D15).
      this.autoLock.start(this.autoLockMs(prefs));
      this.startWatcher(vaultPaths(target.vaultDir).vaultJson);
      if (prefs.contentProtection) safely(() => this.deps.ui.setContentProtection(true));

      // 8. Desbloqueada.
      this.phase = 'unlocked';
      this.maintenance = null;
      this.attempt = null;
      log.info('session.unlocked');
      return { profile, prefs };
    } catch (err) {
      zeroize(kek, mk);
      if (attempt.cancelled) {
        // lock() ya puso todo a cero y dejó el estado en locked (o empezó otra sesión).
        throw locked();
      }
      this.undoUnlock();
      const code = err instanceof AppErrorException ? err.error.code : 'INTERNAL';
      if (code !== 'WRONG_PASSWORD') log.warn('session.unlock-failed', { code });
      throw err;
    }
  }

  private undoUnlock(): void {
    this.stopWatcher();
    this.autoLock.stop();
    this.jobs?.abortAll('error');
    this.previousJobs = this.jobs ?? this.previousJobs;
    this.jobs = null;
    closeDatabase(this.db);
    this.db = null;
    this.vaultDirValue = null;
    this.keyRing?.zeroize();
    this.keyRing = null;
    this.phase = 'locked';
    this.profileId = null;
    this.attempt = null;
  }

  /** Paso 1 del desbloqueo: drained() de la sesión anterior, como mucho 5 s; si no, warn [H3-6]. */
  private async waitPreviousDrained(): Promise<void> {
    const previous = this.previousJobs;
    if (!previous) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = await Promise.race([
      previous.drained().then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), DRAIN_WAIT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      log.warn('session.drain-timeout', { count: previous.active().length });
    }
    if (this.previousJobs === previous) this.previousJobs = null;
  }

  /** Paso 1 del desbloqueo (§13.1): la unidad rename + profiles.json de un traslado, ≤ 10 s. */
  private async waitRelocateCommit(profileId: Id): Promise<void> {
    const pending = this.keyless.pendingKey(relocateCommitKey(profileId));
    if (!pending) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = await Promise.race([
      pending.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), RELOCATE_COMMIT_WAIT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      throw new AppErrorException({ code: 'IO', details: { reason: 'relocate-commit' } });
    }
  }

  // ── Mantenimiento: traslado de la bóveda (§8.7, §13.1) ───────────────────────────────────────

  /**
   * Paso 2: subestado `maintenance { jobId }`. Los canales "U" devuelven BUSY (register.ts),
   * vault:// responde 503 y se pausan el auto-bloqueo (motivo 'maintenance') y el vigilante.
   */
  enterMaintenance(jobId: Id, epoch: number): void {
    if (this.phase !== 'unlocked' || epoch !== this.epochValue) throw locked();
    if (this.maintenance) throw new AppErrorException({ code: 'BUSY' });
    this.maintenance = { jobId };
    this.autoLock.pause('maintenance');
  }

  /** Paso 7 (o la vuelta atrás): sale de `maintenance`. Sin efecto si ya no es ese traslado. */
  exitMaintenance(jobId: Id, epoch: number): void {
    if (epoch !== this.epochValue || this.maintenance?.jobId !== jobId) return;
    this.maintenance = null;
    if (this.phase === 'unlocked') this.autoLock.resume('maintenance');
  }

  /**
   * Paso 3: `PRAGMA wal_checkpoint(TRUNCATE)` y cerrar la DB. Desde aquí getDb() lanza LOCKED hasta
   * reopenDb() (en `maintenance` los canales y el protocolo ya responden BUSY).
   */
  closeDbForMaintenance(epoch: number): void {
    if (!this.maintenance) throw new AppErrorException({ code: 'BUSY' });
    const db = this.getDb(epoch);
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      closeDatabase(db);
      if (this.db === db) this.db = null;
    }
  }

  /**
   * Paso 7 (o la vuelta atrás a la bóveda antigua): abre la DB de `vaultDir` con K_db, la pasa a
   * ser la carpeta de la sesión y reinicia el vigilante con su vault.json. Errores de openDatabase.
   */
  reopenDb(epoch: number, vaultDir: string): void {
    if (!this.maintenance || this.phase !== 'unlocked') throw locked();
    const keyRing = this.getKeyRing(epoch);
    if (this.db) throw new AppErrorException({ code: 'INTERNAL', details: { reason: 'db-open' } });
    const open = this.deps.openDatabase ?? defaultOpenDatabase;
    this.db = open(vaultPaths(vaultDir).db, keyRing.kDb, { creating: false });
    this.vaultDirValue = vaultDir;
    this.startWatcher(vaultPaths(vaultDir).vaultJson);
  }

  // ── Bloqueo (§13.3) ──────────────────────────────────────────────────────────────────────────

  /**
   * Bloquea. Con suspend, os-lock, error y vault-unavailable, las claves están a cero cuando
   * lock() devuelve (la promesa ya está resuelta). Con manual, inactivity y shutdown, la promesa se
   * resuelve tras la espera acotada (≤ 2 s) y el paso 4.
   */
  lock(reason: LockReason): Promise<void> {
    const calledAt = this.now();
    const inFlight = this.lockInFlight;
    if (inFlight) {
      if (IMMEDIATE.has(reason)) {
        if (reason === 'suspend' || reason === 'os-lock') safely(() => this.deps.ui.hide());
        inFlight.finish(calledAt);
      }
      return inFlight.promise;
    }
    if (this.phase === 'locked') return Promise.resolve();

    // 1. Velo. Desde aquí los canales "U" devuelven LOCKED (register.ts mira el estado).
    this.phase = 'locking';
    if (this.attempt) this.attempt.cancelled = true;
    this.attempt = null;
    safely(() => this.deps.ui.sendLocking(reason));
    if (reason === 'suspend' || reason === 'os-lock') safely(() => this.deps.ui.hide());
    this.autoLock.stop();
    this.stopWatcher();

    // 2. Abortar (síncrono): los manejadores de 'abort' de cada trabajo destruyen sus claves.
    const jobs = this.jobs;
    jobs?.abortAll(reason);

    let finished = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let resolveLock: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });
    const finish = (at: number): void => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      this.completeLock(reason, at, jobs);
      this.lockInFlight = null;
      resolveLock();
    };
    this.lockInFlight = { promise, finish };

    // 3. Espera acotada: 0 ms con los motivos inmediatos o sin trabajos activos.
    if (IMMEDIATE.has(reason) || !jobs || jobs.active().length === 0) {
      finish(calledAt);
    } else {
      timer = setTimeout(() => finish(calledAt), LOCK_WAIT_MS);
      void jobs.drained().then(() => finish(calledAt));
    }
    return promise;
  }

  /** Pasos 4–6. Los 4 y 5 son síncronos. */
  private completeLock(reason: LockReason, startedAt: number, jobs: JobRegistry | null): void {
    // 4. Claves y DB.
    closeDatabase(this.db);
    this.db = null;
    this.vaultDirValue = null;
    this.keyRing?.zeroize();
    this.keyRing = null;
    const readers = [...this.readers];
    const writers = [...this.writers];
    this.readers.clear();
    this.writers.clear();
    for (const reader of readers) safely(() => reader.destroyKeys());
    for (const [writer] of writers) safely(() => writer.destroyKeys());
    const ms = this.now() - startedAt;
    this.lastZeroize = ms;
    if (this.deps.exposeTestHooks) {
      (globalThis as { __galeriaLastZeroizeMs?: number }).__galeriaLastZeroizeMs = ms;
    }

    // 5. Fin del bloqueo.
    if (jobs) this.previousJobs = jobs;
    this.jobs = null;
    this.maintenance = null;
    this.phase = 'locked';
    this.profileId = null;
    log.info('session.locked', { stage: reason, ms: Math.round(ms) });
    safely(() => this.deps.ui.sendLocked(reason));
    if (reason === 'shutdown') return; // index.ts llama a app.quit()
    safely(() => this.deps.ui.replaceWindow());

    // 6. Limpiezas sin claves en segundo plano.
    let n = 0;
    for (const reader of readers) {
      n += 1;
      void this.keyless.runKey(`reader:${this.epochValue}:${n}`, () => reader.close());
    }
    for (const [writer, tmpPath] of writers) {
      n += 1;
      const task = (): Promise<void> => writer.abort();
      void (tmpPath
        ? this.keyless.run(tmpPath, task)
        : this.keyless.runKey(`writer:${this.epochValue}:${n}`, task));
    }
  }

  // ── Vigilante de la bóveda (§13.2) ───────────────────────────────────────────────────────────

  private startWatcher(vaultJsonPath: string): void {
    this.stopWatcher();
    const statFile = this.deps.statVaultJson ?? ((p: string) => stat(p).then(() => undefined));
    let busy = false;
    this.watcher = setInterval(() => {
      if (busy || this.phase !== 'unlocked' || this.maintenance) return;
      busy = true;
      statFile(vaultJsonPath)
        .then(
          () => undefined,
          () => {
            if (this.phase !== 'unlocked' || this.maintenance) return;
            log.warn('vault.unavailable', { stage: 'watcher' });
            void this.lock('vault-unavailable');
          },
        )
        .finally(() => {
          busy = false;
        });
    }, VAULT_WATCH_MS);
    this.watcher.unref?.();
  }

  private stopWatcher(): void {
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
  }
}

// ── Disparadores (§13.2) ───────────────────────────────────────────────────────────────────────

export interface LockTriggerEnv {
  app: Pick<App, 'on' | 'quit'>;
  powerMonitor: Pick<PowerMonitor, 'on' | 'getSystemIdleState'>;
  dialog: Pick<Dialog, 'showMessageBox'>;
  platform?: NodeJS.Platform;
  /** Por defecto `process`. */
  proc?: Pick<NodeJS.Process, 'on'>;
}

function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : undefined;
}

/**
 * Suspensión y bloqueo del SO (en Linux, getSystemIdleState(60) cada 5 s, best-effort), cierre de
 * la app (before-quit → shutdown antes de salir) y errores no controlados (bloqueo `error` y
 * diálogo nativo). El vigilante de vault.json y la inactividad viven en SessionManager.
 */
export function installLockTriggers(session: SessionManager, env: LockTriggerEnv): void {
  const { app, powerMonitor, dialog } = env;
  const platform = env.platform ?? process.platform;
  const proc = env.proc ?? process;

  powerMonitor.on('suspend', () => {
    void session.lock('suspend');
  });
  powerMonitor.on('lock-screen', () => {
    void session.lock('os-lock');
  });
  if (platform === 'linux') {
    const poll = setInterval(() => {
      if (session.state === 'locked') return;
      if (powerMonitor.getSystemIdleState(60) === 'locked') void session.lock('os-lock');
    }, LINUX_LOCK_POLL_MS);
    poll.unref?.();
  }

  // before-quit: la primera vez se impide la salida, se bloquea (shutdown) y se vuelve a salir.
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting || session.state === 'locked') return;
    event.preventDefault();
    quitting = true;
    void session.lock('shutdown').finally(() => app.quit());
  });

  // §21.1: ningún error tumba la app; bloquea la sesión y avisa.
  let dialogOpen = false;
  const onFatal = (kind: 'exception' | 'rejection') => (err: unknown) => {
    log.error(kind === 'exception' ? 'process.uncaught-exception' : 'process.unhandled-rejection', {
      errno: errnoOf(err),
    });
    const wasActive = session.state !== 'locked';
    void session.lock('error');
    if (!wasActive || dialogOpen) return;
    dialogOpen = true;
    void dialog
      .showMessageBox({
        type: 'error',
        title: 'Galería',
        message: 'Se produjo un error inesperado; la bóveda se ha bloqueado.',
        buttons: ['Aceptar'],
      })
      .catch(() => undefined)
      .finally(() => {
        dialogOpen = false;
      });
  };
  proc.on('uncaughtException', onFatal('exception'));
  proc.on('unhandledRejection', onFatal('rejection'));
}
