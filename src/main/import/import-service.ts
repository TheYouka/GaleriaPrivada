// Servicio de importación (docs/DESIGN.md §12.3–§12.7, §12.11; PLAN.md 2.9). Un trabajo `import`
// del JobRegistry de la sesión: escaneo y validación (§12.3, con path-guard [H3-3]), preescaneo de
// vídeos y `awaiting-confirmation` (D8, §12.5.1), los pasos 0–9 de §12.4 de uno en uno y en orden,
// duplicados (§12.7, incluida la sustitución de un objeto dañado en dos transacciones), cancelación
// y bloqueo.
//
// PROTECCIÓN CONTRA PÉRDIDA DE DATOS. El orden es fijo: cifrar a tmp/<id>.part → fsync (finish) →
// descifrar y verificar el hash (y ffprobe por loopback si lo procesó ffmpeg) → miniatura y
// metadatos → transacción en la DB (`pending`) → renombrados atómicos → `ready` → SOLO ENTONCES
// comprobar y borrar el original (secure-delete.ts). Cualquier fallo antes del paso 8 deja el
// original intacto. Las rutas se usan exactamente como llegaron (sin NFC ni trim, [H3-3]).
//
// Sesión [H3-6]: toda la DB y las claves se piden con la época del JobHandle (getDb(epoch) lanza
// LOCKED tras bloquear, también si ya hay otra sesión abierta). Después de un abort (bloqueo), el
// trabajo no ejecuta más sentencias, no toca `objects/` ni `thumbs/` (ni renombra ni borra) y los
// `.part` de la rama de fallo se borran a través de KeylessCleanup; lo que quede (una fila
// `pending` con su objeto) lo resuelve la reconciliación del siguiente desbloqueo (§12.6). Nunca se
// ejecutan los pasos 8 y 9 tras un bloqueo, y no se envían eventos a la ventana nueva.
//
// Nada descifrado se escribe en disco: las fotos van en memoria (sharp sin temporales), ffmpeg lee
// el original del usuario o el `.part` cifrado por el loopback y escribe en pipe:1 hacia el writer.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { lstat, open, statfs } from 'node:fs/promises';
import { basename } from 'node:path';
import { AppErrorException } from '@shared/errors';
import { foldEdits, sameEditState, type EditState } from '@shared/edits';
import {
  DISK_FREE_FACTOR,
  DISK_FREE_MARGIN_BYTES,
  PHOTO_MAX_BYTES,
  VIDEO_MAX_BYTES,
} from '@shared/constants';
import type {
  Id,
  ImportConfirmNeeded,
  ImportFailureCode,
  ImportProgress,
  ImportReport,
} from '@shared/types';
import { KIND_MEDIA, KIND_THUMB, type ObjectKind } from '../crypto/file-format';
import { openObject, type ObjectReader } from '../crypto/object-reader';
import type { ObjectWriter, ObjectWriterResult } from '../crypto/object-writer';
import type { Db } from '../db/database';
import { listEdits } from '../db/repos/edit-repo';
import {
  completeReplacement,
  deletePending,
  findByHmac,
  insertPending,
  insertReplacing,
  markReady,
  setRegeneratedThumb,
  undoReplacement,
  type MediaExifInput,
  type NewMedia,
} from '../db/repos/media-repo';
import type { LibraryEvents } from '../ipc/library-events';
import { log } from '../log';
import type { Ffmpeg } from '../media/ffmpeg';
import { LoopbackServer, type LoopbackTarget } from '../media/loopback-server';
import { renderEdits } from '../media/edits-render';
import { photoThumbnail, videoThumbnail } from '../media/thumbnails';
import type { JobHandle } from '../session/jobs';
import type { SessionManager } from '../session/session-manager';
import type { InFlight } from '../vault/in-flight';
import { fileIdOf, ObjectStore } from '../vault/object-store';
import { replaceThumb } from '../vault/thumb-replace';
import { videoCapturedAt } from './capture-date';
import { analyzePhoto, readPhotoOriginal, type PhotoAnalysis } from './image-pipeline';
import { removeRecentEntries } from './linux-recent';
import { cleanupThumbnails, fileUri } from './linux-thumbnails';
import { deriveName } from './naming';
import { isInsideProtectedRoot, resolveProtectedRoots } from './path-guard';
import {
  defaultSecureDeleteIo,
  secureDeleteOriginal,
  type SecureDeleteIo,
  type SecureDeleteResult,
} from './secure-delete';
import { detectedExtOf, dispositionOf, sniffFile, type SniffResult } from './sniff';
import {
  confirmationSummary,
  prescanVideo,
  transcodeToSink,
  verifyProcessedVideo,
  type VideoDecision,
  type VideoPrescan,
  type VideoSummary,
} from './video-pipeline';
import { newWalkBudget, sameSnapshot, snapshotOf, walk, type Snapshot } from './walk';

/**
 * D18 (importaciones, recomendación aplicada): el temporizador de inactividad está en pausa durante
 * la importación salvo en `awaiting-confirmation`. Es el ÚNICO punto de cambio: con `false` el
 * temporizador corre siempre (y hay que ajustar su test y el límite 10 de la Ayuda). La suspensión,
 * el bloqueo del SO y el bloqueo manual bloquean siempre y cancelan el trabajo (§13.2).
 */
export const IMPORT_PAUSES_AUTOLOCK = true;

/** import:progress como mucho cada esto (los cambios de fase salen al momento). */
export const PROGRESS_INTERVAL_MS = 100;
/** Lectura del original en streaming (HMAC del paso 1 y copia tal cual del paso 2). */
const READ_CHUNK_BYTES = 1024 * 1024;

/**
 * Puntos de inyección de fallos (tests y gancho de E2E, PLAN.md nota 108). Cada uno se llama al
 * EMPEZAR su paso; `step6b` va entre los dos renombrados del paso 6 y `step9` justo antes del
 * unlink del original (después de la comprobación del paso 8). `scan` al empezar el escaneo y
 * `begin` al empezar cada archivo, antes de repetir el lstat.
 */
export const FAULT_POINTS = [
  'scan',
  'begin',
  'step0',
  'step1',
  'step2',
  'step3',
  'step4',
  'step5',
  'step6',
  'step6b',
  'step7',
  'step8',
  'step9',
] as const;
export type FaultPoint = (typeof FAULT_POINTS)[number];

export interface FaultContext {
  /** Original en curso (null en `scan`). */
  path: string | null;
  /** Señal del trabajo (bloqueo o cancelar). */
  signal: AbortSignal;
}

/** Puede lanzar (fallo del paso) o esperar (para simular una caída o un bloqueo a mitad). */
export type FaultHook = (point: FaultPoint, ctx: FaultContext) => void | Promise<void>;

export interface ImportEvents {
  progress(progress: ImportProgress): void;
  done(report: ImportReport): void;
  confirmNeeded(payload: ImportConfirmNeeded): void;
}

export type ImportSession = Pick<
  SessionManager,
  | 'startJob'
  | 'getDb'
  | 'getKeyRing'
  | 'getVaultDir'
  | 'registerWriter'
  | 'registerReader'
  | 'cleanup'
>;

export type ImportFfmpeg = Pick<Ffmpeg, 'available' | 'loadDecoders' | 'run' | 'start'>;

export interface ImportServiceDeps {
  session: ImportSession;
  ffmpeg: ImportFfmpeg;
  events: ImportEvents;
  library: Pick<LibraryEvents, 'beginJob' | 'changed'>;
  /** Un único conjunto por proceso (index.ts), compartido con la reconciliación (§12.6). */
  inFlight: InFlight;
  /**
   * GaleriaData y la carpeta de bóveda de cada perfil conocido (y sus pendingCleanup). La bóveda de
   * la sesión se añade siempre (§12.3 punto 2).
   */
  protectedRoots(): Promise<readonly string[]>;
  /** Solo tests y E2E sin empaquetar (PLAN.md nota 108). */
  faults?: FaultHook;
  /** Bytes libres del volumen de `dir` (null si no se puede saber). Inyectable para los tests. */
  freeBytes?: (dir: string) => Promise<number | null>;
  /** E/S de secure-delete (tests). */
  secureDeleteIo?: SecureDeleteIo;
  platform?: NodeJS.Platform;
}

const IMPORT_FAILURE_CODES: ReadonlySet<string> = new Set<ImportFailureCode>([
  'UNSUPPORTED_FORMAT',
  'TOO_LARGE',
  'DISK_FULL',
  'IO',
  'INTEGRITY',
  'FFMPEG_MISSING',
  'FFMPEG_FAILED',
  'CANCELLED',
  'CHANGED_DURING_IMPORT',
]);

type PhotoSniff = Extract<SniffResult, { kind: 'photo' }>;
type VideoSniff = Extract<SniffResult, { kind: 'video' }>;
type StorableDecision = Extract<VideoDecision, { kind: 'store' | 'process' }>;

interface CandidateBase {
  path: string;
  snapshot: Snapshot;
  size: number;
  explicit: boolean;
}

type Candidate =
  | (CandidateBase & { kind: 'photo'; sniff: PhotoSniff })
  | (CandidateBase & {
      kind: 'video';
      sniff: VideoSniff;
      prescan: VideoPrescan;
      decision: StorableDecision;
    });

/** Lo que el trabajo ha creado para el archivo en curso (para la rama de fallo). */
interface FileWork {
  id: Id | null;
  thumbId: Id | null;
  /** Writers sin terminar (con su baja del SessionManager). */
  writers: Set<{ writer: ObjectWriter; unregister: () => void }>;
  mediaPromoted: boolean;
  thumbPromoted: boolean;
  /** Fila `pending` insertada (paso 5). */
  inserted: boolean;
  /** Paso 7 confirmado. */
  committed: boolean;
  replaceOld: Id | null;
  hmac: Buffer | null;
  release: (() => void) | null;
}

/** El trabajo se detiene: bloqueo (`abort`) o "Cancelar" antes del paso 5 del archivo en curso. */
class Stop extends Error {
  constructor(readonly kind: 'abort' | 'cancel') {
    super(kind);
  }
}

/** Resultado de un archivo que no se importa: `skipped` o un código de `failed`. */
class Outcome extends Error {
  constructor(readonly result: 'skipped' | ImportFailureCode) {
    super(result);
  }
}

const newId = (): Id => randomBytes(16).toString('hex');

function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : undefined;
}

function failureCodeOf(err: unknown): ImportFailureCode {
  if (err instanceof Outcome && err.result !== 'skipped') return err.result;
  if (err instanceof AppErrorException) {
    const code = err.error.code;
    if (IMPORT_FAILURE_CODES.has(code)) return code as ImportFailureCode;
    if (code === 'NOT_FOUND') return 'CHANGED_DURING_IMPORT';
    return 'IO';
  }
  return errnoOf(err) === 'ENOSPC' ? 'DISK_FULL' : 'IO';
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/**
 * Win32 quita los espacios y puntos finales de cada componente al abrir una ruta: `foto.jpg ` (un
 * nombre que solo se crea con `\\?\`) abriría `foto.jpg`, otro archivo. Esas rutas se omiten en
 * Windows para no tocar nunca un archivo distinto del soltado ([H3-3], PLAN.md nota 106).
 */
export function hasWin32AmbiguousSegment(p: string): boolean {
  return p
    .split(/[\\/]/)
    .some((s) => s !== '' && s !== '.' && s !== '..' && (s.endsWith(' ') || s.endsWith('.')));
}

async function defaultFreeBytes(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir, { bigint: true });
    return Number(s.bavail * s.bsize);
  } catch {
    return null;
  }
}

/** Espacio exigido para un archivo (§12.3 punto 5): tamaño × 1,2 + 100 MiB. */
export function requiredFreeBytes(size: number): number {
  return size * DISK_FREE_FACTOR + DISK_FREE_MARGIN_BYTES;
}

/**
 * Lee el original por el descriptor cuyo fstat coincide con el snapshot. 'changed' si ya no es el
 * archivo del escaneo (o desapareció, o cambió de tamaño mientras se leía).
 */
async function readOriginal(
  path: string,
  snapshot: Snapshot,
  signal: AbortSignal,
  onChunk: (chunk: Buffer) => void | Promise<void>,
): Promise<'ok' | 'changed'> {
  let fh;
  try {
    fh = await open(path, 'r');
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return 'changed';
    throw new AppErrorException({ code: 'IO' });
  }
  try {
    const st = await fh.stat({ bigint: true });
    if (!st.isFile() || !sameSnapshot(snapshotOf(st), snapshot)) return 'changed';
    const buf = Buffer.alloc(READ_CHUNK_BYTES);
    let pos = 0;
    for (;;) {
      if (signal.aborted) throw new AppErrorException({ code: 'CANCELLED' });
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead <= 0) break;
      await onChunk(Buffer.from(buf.subarray(0, bytesRead)));
      pos += bytesRead;
    }
    return BigInt(pos) === snapshot.size ? 'ok' : 'changed';
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** SHA-256 (y HMAC opcional) del plaintext de un objeto, descifrándolo entero y verificando cada tag. */
async function digestObject(
  reader: ObjectReader,
  signal: AbortSignal,
  hmacKey?: Buffer,
): Promise<{ sha256: Buffer; hmac: Buffer | null }> {
  const sha = createHash('sha256');
  const mac = hmacKey ? createHmac('sha256', hmacKey) : null;
  const take = (chunk: Buffer): void => {
    sha.update(chunk);
    mac?.update(chunk);
    chunk.fill(0); // plaintext descifrado: fuera de la memoria en cuanto se ha contado
  };
  if (reader.plaintextSize === 0) {
    take(await reader.readAll());
  } else {
    for await (const chunk of reader.createReadStream(0, reader.plaintextSize - 1)) {
      if (signal.aborted) throw new AppErrorException({ code: 'CANCELLED' });
      take(chunk as Buffer);
    }
  }
  return { sha256: sha.digest(), hmac: mac ? mac.digest() : null };
}

/** Un trabajo de importación (uno por JobHandle). */
class ImportJob {
  readonly id: Id;
  private readonly epoch: number;
  private readonly cancelCtl = new AbortController();
  /** Bloqueo (JobHandle) o "Cancelar". */
  private readonly signal: AbortSignal;
  private store: ObjectStore | null = null;
  private phase: ImportProgress['phase'] = 'scanning';
  private total = 0;
  private doneCount = 0;
  private imported = 0;
  private duplicates = 0;
  private skipped = 0;
  private readonly failed: ImportReport['failed'] = [];
  private readonly notDeleted: ImportReport['originalsNotDeleted'] = [];
  private currentName: string | null = null;
  private lastProgress = 0;
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  private confirmResolve: ((convert: boolean | null) => void) | null = null;
  private lbPromise: Promise<LoopbackServer> | null = null;
  private readonly recentUris = new Set<string>();
  private readonly platform: NodeJS.Platform;

  constructor(
    private readonly deps: ImportServiceDeps,
    private readonly handle: JobHandle,
    private readonly paths: readonly string[],
  ) {
    this.id = handle.id;
    this.epoch = handle.epoch;
    this.signal = AbortSignal.any([handle.signal, this.cancelCtl.signal]);
    this.platform = deps.platform ?? process.platform;
  }

  get awaitingConfirmation(): boolean {
    return this.confirmResolve !== null;
  }

  /** Bloqueo de la sesión (no "Cancelar"). */
  private get aborted(): boolean {
    return this.handle.signal.aborted;
  }

  private get cancelled(): boolean {
    return this.cancelCtl.signal.aborted;
  }

  answer(convert: boolean): void {
    this.confirmResolve?.(convert);
  }

  cancel(): void {
    if (!this.cancelCtl.signal.aborted) this.cancelCtl.abort('cancel');
  }

  // ── Acceso a la sesión con la época del trabajo [H3-6] ────────────────────────────────────────

  private db(): Db {
    return this.deps.session.getDb(this.epoch);
  }

  private keyRing(): ReturnType<ImportSession['getKeyRing']> {
    return this.deps.session.getKeyRing(this.epoch);
  }

  private storeOf(): ObjectStore {
    if (!this.store) throw new AppErrorException({ code: 'LOCKED' });
    return this.store;
  }

  private async fault(point: FaultPoint, path: string | null): Promise<void> {
    if (this.deps.faults) await this.deps.faults(point, { path, signal: this.signal });
  }

  // ── Progreso y contadores ──────────────────────────────────────────────────────────────────────

  private snapshotProgress(): ImportProgress {
    return {
      jobId: this.id,
      total: this.total,
      done: this.doneCount,
      imported: this.imported,
      duplicates: this.duplicates,
      skipped: this.skipped,
      failed: this.failed.length,
      currentName: this.currentName,
      phase: this.phase,
    };
  }

  private sendProgress(): void {
    this.lastProgress = Date.now();
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = null;
    if (this.aborted) return; // nunca a la ventana nueva tras un bloqueo
    try {
      this.deps.events.progress(this.snapshotProgress());
    } catch {
      // la ventana puede no existir
    }
  }

  private progress(force = false): void {
    if (force) return this.sendProgress();
    const wait = this.lastProgress + PROGRESS_INTERVAL_MS - Date.now();
    if (wait <= 0) return this.sendProgress();
    if (this.progressTimer) return;
    this.progressTimer = setTimeout(() => this.sendProgress(), wait);
    this.progressTimer.unref?.();
  }

  private setPhase(phase: ImportProgress['phase']): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.progress(true);
  }

  private countSkipped(): void {
    this.skipped += 1;
    this.doneCount += 1;
    this.progress();
  }

  private countFailed(path: string, code: ImportFailureCode, stage: string): void {
    this.failed.push({ name: basename(path), code });
    this.doneCount += 1;
    log.warn('import.file.failed', {
      jobId: this.id,
      code: code === 'CHANGED_DURING_IMPORT' ? undefined : code,
      stage: code === 'CHANGED_DURING_IMPORT' ? 'changed' : stage,
    });
    this.progress();
  }

  private report(): ImportReport {
    return {
      jobId: this.id,
      imported: this.imported,
      duplicates: this.duplicates,
      skipped: this.skipped,
      failed: [...this.failed],
      originalsNotDeleted: [...this.notDeleted],
      cancelled: this.cancelled,
    };
  }

  // ── Trabajo ───────────────────────────────────────────────────────────────────────────────────

  /** Nunca rechaza. null si un bloqueo lo abortó (no se envía import:done). */
  async run(): Promise<ImportReport | null> {
    const endBatch = this.deps.library.beginJob();
    this.handle.setPausesAutoLock(IMPORT_PAUSES_AUTOLOCK);
    try {
      this.store = new ObjectStore(this.deps.session.getVaultDir(this.epoch));
      this.progress(true);
      const candidates = await this.scan();
      if (!this.signal.aborted) {
        const accepted = await this.confirmConversions(candidates);
        if (accepted) await this.processAll(accepted);
      }
    } catch (err) {
      if (!(err instanceof Stop) && !this.signal.aborted) {
        log.error('import.job-failed', { jobId: this.id, errno: errnoOf(err) });
      }
    } finally {
      if (this.progressTimer) clearTimeout(this.progressTimer);
      this.progressTimer = null;
      const lb = await this.lbPromise?.catch(() => null);
      await lb?.close();
      if (this.recentUris.size > 0) {
        await removeRecentEntries(this.recentUris, { platform: this.platform });
      }
      endBatch();
    }
    let report: ImportReport | null = null;
    if (!this.aborted) {
      report = this.report();
      this.currentName = null;
      this.sendProgress();
      try {
        this.deps.events.done(report);
      } catch {
        // la ventana puede no existir
      }
    }
    log.info('import.finished', {
      jobId: this.id,
      count: this.imported,
      stage: this.aborted ? 'aborted' : this.cancelled ? 'cancelled' : 'done',
    });
    // Lo último: el desbloqueo siguiente espera a drained() [H3-6].
    this.handle.done();
    return report;
  }

  // ── Escaneo y validación (§12.3) ──────────────────────────────────────────────────────────────

  private async scan(): Promise<Candidate[]> {
    await this.fault('scan', null);
    const roots = await resolveProtectedRoots([
      ...(await this.deps.protectedRoots()),
      this.storeOf().vaultDir,
    ]);
    const unsafe = async (p: string): Promise<boolean> => {
      if (this.platform === 'win32' && hasWin32AmbiguousSegment(p)) return true;
      return (await isInsideProtectedRoot(p, roots)) !== 'outside';
    };
    const skipEntry = (): void => {
      this.total += 1;
      this.countSkipped();
    };

    const budget = newWalkBudget();
    const seen = new Set<string>();
    const found: { path: string; snapshot: Snapshot; explicit: boolean }[] = [];
    const add = (path: string, snapshot: Snapshot, explicit: boolean): void => {
      if (seen.has(path)) return;
      seen.add(path);
      this.total += 1;
      found.push({ path, snapshot, explicit });
    };

    for (const raw of this.paths) {
      if (this.signal.aborted) return [];
      // 2. Raíces protegidas y rutas de dispositivo, con la ruta tal cual llegó [H3-3].
      if (await unsafe(raw)) {
        skipEntry();
        continue;
      }
      // 1. lstat: enlaces y junctions fuera; carpetas recorridas; solo archivos regulares.
      let st;
      try {
        st = await lstat(raw, { bigint: true });
      } catch {
        skipEntry();
        continue;
      }
      if (st.isSymbolicLink()) {
        skipEntry();
      } else if (st.isDirectory()) {
        const res = await walk(raw, {
          budget,
          signal: this.signal,
          enterDir: async (dir) => !(await unsafe(dir)),
        });
        for (let i = 0; i < res.skipped; i += 1) skipEntry();
        for (const f of res.files) {
          if (this.signal.aborted) return [];
          if (await unsafe(f.path)) skipEntry();
          else add(f.path, f.snapshot, false);
        }
      } else if (st.isFile()) {
        add(raw, snapshotOf(st), true);
      } else {
        skipEntry();
      }
    }
    this.progress(true);

    const free = await (this.deps.freeBytes ?? defaultFreeBytes)(this.storeOf().vaultDir);
    const out: Candidate[] = [];
    for (const f of found) {
      if (this.signal.aborted) return [];
      const c = await this.classify(f, free);
      if (c) out.push(c);
    }
    this.currentName = null;
    return out;
  }

  /** Firma, límites, espacio y preescaneo de un vídeo (§12.3 puntos 3–6). null = ya contado. */
  private async classify(
    f: { path: string; snapshot: Snapshot; explicit: boolean },
    free: number | null,
  ): Promise<Candidate | null> {
    this.currentName = basename(f.path);
    let sniff: SniffResult;
    try {
      sniff = await sniffFile(f.path);
    } catch (err) {
      const code = failureCodeOf(err);
      if (code === 'CHANGED_DURING_IMPORT') this.countSkipped();
      else this.countFailed(f.path, code, 'sniff');
      return null;
    }
    const disposition = dispositionOf(sniff, { explicit: f.explicit });
    if (disposition.action === 'skip') {
      this.countSkipped();
      return null;
    }
    if (disposition.action === 'fail') {
      this.countFailed(f.path, disposition.code, 'sniff');
      return null;
    }
    const size = Number(f.snapshot.size);
    const limit = sniff.kind === 'photo' ? PHOTO_MAX_BYTES : VIDEO_MAX_BYTES;
    if (size > limit) {
      this.countFailed(f.path, 'TOO_LARGE', 'limits');
      return null;
    }
    if (free !== null && requiredFreeBytes(size) > free) {
      this.countFailed(f.path, 'DISK_FULL', 'space');
      return null;
    }
    const base = { path: f.path, snapshot: f.snapshot, size, explicit: f.explicit };
    if (sniff.kind === 'photo') return { ...base, kind: 'photo', sniff };
    if (sniff.kind !== 'video') return null; // dispositionOf ya lo descartó

    let prescan: VideoPrescan;
    try {
      prescan = await prescanVideo(
        this.deps.ffmpeg,
        { path: f.path, container: sniff.container, demuxer: sniff.demuxer },
        this.signal,
      );
    } catch (err) {
      if (this.signal.aborted) return null;
      this.countFailed(f.path, failureCodeOf(err), 'prescan');
      return null;
    }
    const decision = prescan.decision;
    if (decision.kind === 'no-video') {
      // "Cualquier otra" (§12.3): omitido en carpetas; UNSUPPORTED_FORMAT si se eligió.
      const d = dispositionOf(sniff, { explicit: f.explicit, probe: prescan.probe });
      if (d.action === 'skip') this.countSkipped();
      else this.countFailed(f.path, 'UNSUPPORTED_FORMAT', 'prescan');
      return null;
    }
    if (decision.kind === 'unsupported') {
      this.countFailed(f.path, 'UNSUPPORTED_FORMAT', decision.reason); // [H3-11], sin D8
      return null;
    }
    return { ...base, kind: 'video', sniff, prescan, decision };
  }

  // ── Confirmación de conversiones (D8, §12.5.1) ────────────────────────────────────────────────

  /** null si se canceló o se bloqueó mientras esperaba (no se ha tocado nada). */
  private async confirmConversions(candidates: Candidate[]): Promise<Candidate[] | null> {
    const videos = candidates.filter((c) => c.kind === 'video');
    const { toConvert, toConvertBytes } = confirmationSummary(
      videos.map((c) => ({ decision: c.decision, sizeBytes: c.size })),
    );
    if (toConvert === 0) return candidates;
    this.setPhase('awaiting-confirmation');
    // D18: en awaiting-confirmation el temporizador corre (y arranca desde cero).
    if (IMPORT_PAUSES_AUTOLOCK) this.handle.setPausesAutoLock(false);
    const answer = await new Promise<boolean | null>((resolve) => {
      if (this.signal.aborted) return resolve(null);
      this.confirmResolve = resolve;
      this.signal.addEventListener('abort', () => resolve(null), { once: true });
      try {
        this.deps.events.confirmNeeded({ jobId: this.id, toConvert, toConvertBytes });
      } catch {
        // la ventana puede no existir; el trabajo sigue esperando (sin timeout)
      }
    });
    this.confirmResolve = null;
    if (answer === null || this.signal.aborted) return null;
    if (IMPORT_PAUSES_AUTOLOCK) this.handle.setPausesAutoLock(true);
    if (answer) return candidates;
    // "Omitir esos vídeos": cuentan como skipped, con sus originales intactos.
    return candidates.filter((c) => {
      const reencode = c.kind === 'video' && c.decision.kind === 'process' && c.decision.reencode;
      if (reencode) this.countSkipped();
      return !reencode;
    });
  }

  // ── Pasos por archivo (§12.4) ─────────────────────────────────────────────────────────────────

  private async processAll(list: Candidate[]): Promise<void> {
    this.setPhase('encrypting');
    for (let i = 0; i < list.length; i += 1) {
      if (this.signal.aborted) return;
      const c = list[i] as Candidate;
      const next = await this.processFile(c);
      if (next === 'stop') return;
      if (next === 'disk-full') {
        // §12.3 punto 5: se detiene el trabajo, porque los siguientes tampoco cabrían.
        for (const rest of list.slice(i + 1)) this.countFailed(rest.path, 'DISK_FULL', 'space');
        return;
      }
    }
  }

  private async processFile(c: Candidate): Promise<'next' | 'stop' | 'disk-full'> {
    const w: FileWork = {
      id: null,
      thumbId: null,
      writers: new Set(),
      mediaPromoted: false,
      thumbPromoted: false,
      inserted: false,
      committed: false,
      replaceOld: null,
      hmac: null,
      release: null,
    };
    this.currentName = basename(c.path);
    this.progress();
    try {
      return await this.steps(c, w);
    } catch (err) {
      return await this.onFileError(c, w, err);
    } finally {
      w.release?.();
    }
  }

  /** Bloqueo → abort; "Cancelar" → solo si el archivo no ha llegado al paso 5. */
  private check(w: FileWork): void {
    if (this.aborted) throw new Stop('abort');
    if (this.cancelled && !w.inserted) throw new Stop('cancel');
  }

  private async steps(c: Candidate, w: FileWork): Promise<'next' | 'disk-full'> {
    const store = this.storeOf();

    // Inicio del archivo: espacio libre (§12.3 punto 5) y el mismo snapshot del escaneo (§12.4).
    await this.fault('begin', c.path);
    this.check(w);
    const free = await (this.deps.freeBytes ?? defaultFreeBytes)(store.vaultDir);
    if (free !== null && requiredFreeBytes(c.size) > free) throw new Outcome('DISK_FULL');
    this.check(w);
    const st = await lstat(c.path, { bigint: true }).catch(() => null);
    if (!st || st.isSymbolicLink() || !st.isFile() || !sameSnapshot(snapshotOf(st), c.snapshot)) {
      throw new Outcome('CHANGED_DURING_IMPORT');
    }

    // 0. Sondear. Foto: la única lectura del contenido, a un buffer. Vídeo: el preescaneo.
    await this.fault('step0', c.path);
    this.check(w);
    let buffer: Buffer | null = null;
    let photo: PhotoAnalysis | null = null;
    try {
      if (c.kind === 'photo') {
        const read = await readPhotoOriginal(c.path, c.snapshot);
        if (read === 'changed') throw new Outcome('CHANGED_DURING_IMPORT');
        buffer = read;
        photo = await analyzePhoto(buffer, c.snapshot.mtimeNs);
        this.check(w);
      }
      return await this.encryptAndCommit(c, w, buffer, photo);
    } finally {
      buffer?.fill(0);
    }
  }

  private async encryptAndCommit(
    c: Candidate,
    w: FileWork,
    buffer: Buffer | null,
    photo: PhotoAnalysis | null,
  ): Promise<'next'> {
    const store = this.storeOf();

    // 1. Duplicado: HMAC(K_dedup, original). Vídeos: una pasada de lectura previa, siempre.
    await this.fault('step1', c.path);
    this.check(w);
    const kDedup = this.keyRing().kDedup;
    let hmac: Buffer;
    if (buffer) {
      hmac = createHmac('sha256', kDedup).update(buffer).digest();
    } else {
      const mac = createHmac('sha256', kDedup);
      const read = await readOriginal(c.path, c.snapshot, this.signal, (chunk) => {
        mac.update(chunk);
      });
      if (read === 'changed') throw new Outcome('CHANGED_DURING_IMPORT');
      hmac = mac.digest();
    }
    this.check(w);
    w.hmac = hmac;
    const existing = findByHmac(this.db(), hmac);
    if (existing && existing.state === 'pending') throw new Outcome('skipped'); // §12.7
    if (existing) {
      if (await this.existingIsHealthy(existing.id, existing.converted, hmac)) {
        this.check(w);
        // Descifrar la copia puede tardar segundos y media:delete sigue permitido mientras tanto:
        // el lector ya abierto conserva su DEK y su descriptor aunque la fila y el objeto se
        // hayan borrado. Sin releer, el original se borraría sin que su contenido esté en la
        // bóveda (§12.7 punto 2, §22). La consulta y el borrado del original no tienen un
        // `await` entre ellos (un media:delete posterior equivale a borrar tras importar).
        const still = findByHmac(this.db(), hmac);
        if (still && still.id !== existing.id) throw new Outcome('skipped'); // otro trabajo: no se toca
        if (still && still.state !== 'ready') throw new Outcome('skipped');
        if (still) {
          // Su contenido ya está a salvo: duplicado y el original se borra (pasos 8–9, D7).
          this.duplicates += 1;
          this.doneCount += 1;
          this.progress();
          await this.deleteOriginal(c);
          return 'next';
        }
        // La copia se borró durante la comprobación: importación normal desde el paso 2.
      } else {
        this.check(w);
        w.replaceOld = existing.id; // dañado: se sustituye (§12.7 punto 3)
      }
    }

    // 2. Cifrar a temporal (finish() hace fsync).
    await this.fault('step2', c.path);
    this.check(w);
    const id = newId();
    w.id = id;
    const storeAsIs = c.kind === 'video' && c.decision.kind === 'store';
    const writer = this.openWriter(w, id, KIND_MEDIA, storeAsIs ? kDedup : undefined);
    if (buffer) {
      await writer.write(buffer);
    } else if (c.kind === 'video' && c.decision.kind === 'process') {
      this.setPhase('converting');
      await transcodeToSink({
        ffmpeg: this.deps.ffmpeg,
        input: { kind: 'file', path: c.path, demuxer: c.prescan.demuxer },
        decision: c.decision,
        sink: writer,
        durationMs: c.prescan.summary.durationMs,
        signal: this.signal,
      });
    } else {
      const read = await readOriginal(c.path, c.snapshot, this.signal, (chunk) =>
        writer.write(chunk),
      );
      if (read === 'changed') throw new Outcome('CHANGED_DURING_IMPORT');
    }
    const written = await this.finishWriter(w, writer);
    // Tal cual: lo cifrado tiene que ser lo que se deduplicó en el paso 1.
    if (written.hmac && !written.hmac.equals(hmac)) throw new Outcome('CHANGED_DURING_IMPORT');
    this.check(w);

    // 3. Verificar: descifrar entero (hashB == hashA); foto: hashA == SHA-256(buffer); procesado
    //    con ffmpeg: ffprobe del temporal por el loopback (pista de vídeo y duración).
    this.setPhase('verifying');
    await this.fault('step3', c.path);
    this.check(w);
    const reader = await this.openReader(id, KIND_MEDIA, true);
    let hashB: Buffer;
    try {
      hashB = (await digestObject(reader, this.signal)).sha256;
    } finally {
      await reader.close();
    }
    if (!hashB.equals(written.sha256)) throw new Outcome('INTEGRITY');
    if (buffer && !createHash('sha256').update(buffer).digest().equals(written.sha256)) {
      throw new Outcome('INTEGRITY');
    }
    this.check(w);
    const storedMime = c.kind === 'photo' ? c.sniff.mime : c.decision.mime;
    let partUrl: string | null = null;
    let processed: VideoSummary | null = null;
    if (c.kind === 'video') {
      const lb = await this.loopback();
      partUrl = lb.register('part', {
        path: store.partPath(id),
        fileId: fileIdOf(id),
        kind: KIND_MEDIA,
        mime: storedMime,
      });
      if (c.decision.kind === 'process') {
        processed = await verifyProcessedVideo({
          ffmpeg: this.deps.ffmpeg,
          url: partUrl,
          expectedDurationMs: c.prescan.summary.durationMs,
          signal: this.signal,
        });
      }
      this.check(w);
    }

    // 4. Miniatura y metadatos. Si la miniatura falla, se importa sin ella (thumb_id = NULL).
    this.setPhase('finalizing');
    await this.fault('step4', c.path);
    this.check(w);
    const durationMs =
      c.kind === 'video' ? (processed?.durationMs ?? c.prescan.summary.durationMs) : null;
    // Sustitución de una foto dañada (§12.7 punto 3): la transacción B le copia las ediciones de
    // la antigua, así que su miniatura se renderiza ya con ellas (§16.3), desde el buffer en
    // memoria (el mismo plaintext que daría el paso 2 de §16.5).
    const editState =
      w.replaceOld && c.kind === 'photo' ? foldEdits(listEdits(this.db(), w.replaceOld)) : null;
    const thumb = await this.thumbnail(buffer, partUrl, storedMime, durationMs, editState);
    if (partUrl) (await this.loopback()).unregister('part');
    this.check(w);
    if (thumb) {
      const thumbId = newId();
      w.thumbId = thumbId;
      const tw = this.openWriter(w, thumbId, KIND_THUMB);
      try {
        await tw.write(thumb);
      } finally {
        thumb.fill(0);
      }
      await this.finishWriter(w, tw);
      this.check(w);
    }
    const { media, exif } = this.record(c, w, photo, processed, written, hmac);

    // 5. Insertar `pending` (o la transacción A de una sustitución). inFlight antes del paso 6.
    await this.fault('step5', c.path);
    this.check(w);
    w.release = this.deps.inFlight.track(id, w.thumbId);
    const db = this.db();
    try {
      if (w.replaceOld) insertReplacing(db, media, exif, w.replaceOld);
      else insertPending(db, media, exif);
    } catch (err) {
      // Una fusión en paralelo insertó el mismo contenido (§12.11): skipped.
      if (isUniqueViolation(err)) throw new Outcome('skipped');
      throw err;
    }
    w.inserted = true;

    // 6. Renombrar: primero el objeto y después la miniatura. Tras un bloqueo, nada más [H3-6].
    await this.fault('step6', c.path);
    this.check(w);
    await store.promote(id, KIND_MEDIA);
    w.mediaPromoted = true;
    await this.fault('step6b', c.path);
    this.check(w);
    if (w.thumbId) {
      await store.promote(w.thumbId, KIND_THUMB);
      w.thumbPromoted = true;
    }

    // 7. Confirmar (`ready`, o la transacción B de una sustitución), salida de inFlight y evento.
    await this.fault('step7', c.path);
    this.check(w);
    let erase: { id: Id; kind: ObjectKind }[] = [];
    let rerender = false;
    if (w.replaceOld) {
      const r = completeReplacement(this.db(), id, w.replaceOld);
      if (!r.ok) throw new Outcome('IO');
      if (r.oldExisted) {
        erase = [{ id: w.replaceOld, kind: KIND_MEDIA }];
        if (r.oldThumbId) erase.push({ id: r.oldThumbId, kind: KIND_THUMB });
      }
      // Si las ediciones copiadas no son las del paso 4 (se guardaron otras mientras tanto), la
      // miniatura se rehace con los pasos 2–6 de §16.5 después del original (PLAN.md nota 141).
      if (c.kind === 'photo' && r.copiedEdits > 0) {
        const copied = foldEdits(listEdits(this.db(), id));
        rerender = editState === null || !sameEditState(copied, editState);
      }
    } else if (!markReady(this.db(), id)) {
      throw new Outcome('IO');
    }
    w.committed = true;
    w.release();
    this.imported += 1;
    this.doneCount += 1;
    this.deps.library.changed('import');
    this.progress();
    // Tras el COMMIT de B: borrado criptográfico del objeto y la miniatura antiguos (nunca lanza).
    for (const e of erase) await store.eraseObject(e.id, e.kind);

    // 8–9. Comprobar y borrar el original (no tras un bloqueo; tras "Cancelar", se conserva).
    await this.deleteOriginal(c);
    if (rerender) await this.rerenderEditedThumb(id, w.thumbId);
    return 'next';
  }

  /**
   * §12.7 punto 3 con ediciones: pasos 2–6 de §16.5 sobre la fila nueva (ya `ready`), con las
   * ediciones guardadas. Solo sustituye la miniatura si sigue siendo `expected` (una edición
   * guardada mientras tanto gana). Nunca lanza: la importación ya está confirmada; tras un
   * bloqueo no hace nada más [H3-6].
   */
  private async rerenderEditedThumb(id: Id, expected: Id | null): Promise<void> {
    if (this.aborted) return;
    try {
      const done = await replaceThumb(
        { session: this.deps.session, inFlight: this.deps.inFlight },
        {
          epoch: this.epoch,
          mediaId: id,
          signal: this.handle.signal,
          state: foldEdits(listEdits(this.db(), id)),
          commit: (db, thumbId) =>
            setRegeneratedThumb(db, id, thumbId, expected)
              ? { oldThumbId: expected, value: true }
              : null,
        },
      );
      if (done) this.deps.library.changed('import');
    } catch (err) {
      if (this.aborted) return;
      const code = err instanceof AppErrorException ? err.error.code : undefined;
      log.warn('import.thumb-failed', { jobId: this.id, code });
    }
  }

  /** NewMedia y su EXIF para el paso 5 (§12.4.1, §12.8). */
  private record(
    c: Candidate,
    w: FileWork,
    photo: PhotoAnalysis | null,
    processed: VideoSummary | null,
    written: ObjectWriterResult,
    hmac: Buffer,
  ): { media: NewMedia; exif: MediaExifInput | null } {
    const { name, originalExt } = deriveName(basename(c.path), detectedExtOf(c.sniff) as string);
    const common = {
      id: w.id as Id,
      source: 'import' as const,
      name,
      originalExt,
      sizeBytes: written.plaintextSize,
      originalSizeBytes: c.size,
      importedAt: Date.now(),
      contentHmac: hmac,
      thumbId: w.thumbId,
    };
    if (c.kind === 'photo') {
      const p = photo as PhotoAnalysis;
      return {
        media: {
          ...common,
          kind: 'photo',
          mime: p.mime,
          width: p.width,
          height: p.height,
          durationMs: null,
          fps: null,
          hasAudio: null,
          videoCodec: null,
          audioCodec: null,
          converted: false,
          capturedAt: p.captured.capturedAt,
          capturedAtSource: p.captured.source,
        },
        exif: p.exif,
      };
    }
    const src = c.prescan.summary;
    const out = processed ?? src;
    const captured = videoCapturedAt(src.creationTime, c.snapshot.mtimeNs);
    return {
      media: {
        ...common,
        kind: 'video',
        mime: c.decision.mime,
        width: src.width,
        height: src.height,
        durationMs: out.durationMs,
        fps: out.fps ?? src.fps,
        hasAudio: out.hasAudio,
        videoCodec: out.videoCodec,
        audioCodec: out.audioCodec,
        // §9.2: 1 = lo almacenado NO es byte a byte el original (remultiplexado o recodificado).
        converted: c.decision.kind === 'process',
        capturedAt: captured.capturedAt,
        capturedAtSource: captured.source,
      },
      exif: null,
    };
  }

  // ── Duplicados (§12.7) ────────────────────────────────────────────────────────────────────────

  /**
   * Punto 1: el objeto existente descifra entero con todos sus tags; con converted = 0, además
   * HMAC(K_dedup, descifrado) == content_hmac. false = dañado (se sustituye).
   */
  private async existingIsHealthy(id: Id, converted: boolean, hmac: Buffer): Promise<boolean> {
    let reader: ObjectReader;
    try {
      reader = await this.openReader(id, KIND_MEDIA, false);
    } catch (err) {
      if (this.signal.aborted) throw err;
      return false;
    }
    try {
      const d = await digestObject(
        reader,
        this.signal,
        converted ? undefined : this.keyRing().kDedup,
      );
      return converted || (d.hmac !== null && d.hmac.equals(hmac));
    } catch (err) {
      if (this.signal.aborted) throw err;
      return false;
    } finally {
      await reader.close();
    }
  }

  // ── Objetos cifrados ──────────────────────────────────────────────────────────────────────────

  /** Writer sobre tmp/<id>.part registrado en la sesión (paso 4 del bloqueo: destroyKeys). */
  private openWriter(w: FileWork, id: Id, kind: ObjectKind, hmacKey?: Buffer): ObjectWriter {
    const store = this.storeOf();
    const writer = store.createWriter({
      id,
      kind,
      kWrap: this.keyRing().kWrap,
      hmacKey,
      signal: this.signal,
    });
    const entry = { writer, unregister: () => undefined as void };
    w.writers.add(entry); // la rama de fallo lo aborta (borra el .part) aunque falle el registro
    entry.unregister = this.deps.session.registerWriter(writer, store.partPath(id), this.epoch);
    return writer;
  }

  /** finish() (fsync) y baja del SessionManager: desde aquí el .part es del trabajo. */
  private async finishWriter(w: FileWork, writer: ObjectWriter): Promise<ObjectWriterResult> {
    const result = await writer.finish();
    for (const entry of w.writers) {
      if (entry.writer !== writer) continue;
      entry.unregister();
      w.writers.delete(entry);
    }
    return result;
  }

  /** Lector registrado en la sesión; close() lo da de baja. */
  private async openReader(id: Id, kind: ObjectKind, part: boolean): Promise<ObjectReader> {
    const keys = this.keyRing();
    const reader = await this.storeOf().open(id, kind, keys.kWrap, keys.dekCache, { part });
    return this.registered(reader);
  }

  private registered(reader: ObjectReader): ObjectReader {
    let unregister: () => void;
    try {
      unregister = this.deps.session.registerReader(reader, this.epoch);
    } catch (err) {
      void reader.close();
      throw err;
    }
    return {
      get plaintextSize() {
        return reader.plaintextSize;
      },
      createReadStream: (start, end) => reader.createReadStream(start, end),
      readAll: () => reader.readAll(),
      destroyKeys: () => reader.destroyKeys(),
      close: async () => {
        unregister();
        await reader.close();
      },
    };
  }

  /** Servidor loopback del trabajo (§18.5): ffmpeg lee el .part cifrado, nunca un descifrado. */
  private loopback(): Promise<LoopbackServer> {
    this.lbPromise ??= LoopbackServer.start({
      open: async (t: LoopbackTarget) => {
        const keys = this.keyRing();
        const reader = await openObject(
          t.path,
          { fileId: t.fileId, kind: t.kind },
          keys.kWrap,
          keys.dekCache,
        );
        return this.registered(reader);
      },
      signal: this.signal,
    });
    return this.lbPromise;
  }

  private async thumbnail(
    buffer: Buffer | null,
    partUrl: string | null,
    mime: string,
    durationMs: number | null,
    editState: EditState | null = null,
  ): Promise<Buffer | null> {
    try {
      if (buffer) {
        return editState ? await renderEdits(buffer, editState) : await photoThumbnail(buffer);
      }
      return await videoThumbnail({
        ffmpeg: this.deps.ffmpeg,
        url: partUrl as string,
        mime,
        durationMs,
        signal: this.signal,
      });
    } catch (err) {
      if (this.signal.aborted) throw err;
      const code = err instanceof AppErrorException ? err.error.code : undefined;
      log.warn('import.thumb-failed', { jobId: this.id, code });
      return null;
    }
  }

  // ── Original (§12.4 pasos 8–9) ────────────────────────────────────────────────────────────────

  /** Nunca lanza. Tras un bloqueo no hace nada; tras "Cancelar", lo conserva y lo notifica. */
  private async deleteOriginal(c: Candidate): Promise<void> {
    if (this.aborted) return;
    if (this.cancelled) {
      this.notDeleted.push({ path: c.path, reason: 'CANCELLED' });
      return;
    }
    try {
      await this.fault('step8', c.path);
    } catch {
      this.notDeleted.push({ path: c.path, reason: 'IO' });
      return;
    }
    if (this.aborted) return;
    const base = this.deps.secureDeleteIo ?? defaultSecureDeleteIo;
    const io: SecureDeleteIo = this.deps.faults
      ? {
          ...base,
          unlink: async (p) => {
            await this.fault('step9', c.path);
            await base.unlink(p);
          },
        }
      : base;
    let result: SecureDeleteResult;
    try {
      result = await secureDeleteOriginal(c.path, c.snapshot, io);
    } catch {
      result = { outcome: 'failed' };
    }
    if (result.outcome === 'changed') {
      this.notDeleted.push({ path: c.path, reason: 'CHANGED_DURING_IMPORT' });
    } else if (result.outcome === 'failed') {
      this.notDeleted.push({ path: c.path, reason: 'IO' });
    } else if (this.platform === 'linux') {
      await cleanupThumbnails(c.path, { platform: this.platform });
      this.recentUris.add(fileUri(c.path));
    }
    this.progress();
  }

  // ── Rama de fallo ─────────────────────────────────────────────────────────────────────────────

  private async onFileError(
    c: Candidate,
    w: FileWork,
    err: unknown,
  ): Promise<'next' | 'stop' | 'disk-full'> {
    if (this.aborted || (err instanceof Stop && err.kind === 'abort')) {
      await this.cleanupAborted(w);
      return 'stop';
    }
    if (this.cancelled && !w.inserted) {
      // "Cancelar" antes del paso 5: el archivo en curso se abandona sin contar.
      await this.cleanupFailed(w);
      return 'stop';
    }
    if (w.committed) {
      // Después del paso 7 nada lanza (deleteOriginal y el borrado criptográfico no lanzan).
      log.error('import.job-failed', { jobId: this.id, stage: 'after-commit' });
      return 'next';
    }
    const result: 'skipped' | ImportFailureCode =
      err instanceof Outcome ? err.result : failureCodeOf(err);
    const step7 =
      w.inserted && w.mediaPromoted && (w.thumbId === null || w.thumbPromoted) && !w.committed;
    if (step7) {
      // Fallo del paso 7: la fila `pending` y sus objetos los resuelve la reconciliación (§12.6).
      w.release?.();
    } else {
      await this.cleanupFailed(w);
    }
    if (result === 'skipped') this.countSkipped();
    else this.countFailed(c.path, result, step7 ? 'step7' : 'step');
    return result === 'DISK_FULL' ? 'disk-full' : 'next';
  }

  private async abortWriters(w: FileWork): Promise<void> {
    for (const entry of [...w.writers]) {
      await entry.writer.abort(); // nunca lanza: DEK a cero, close y unlink del .part sin terminar
      entry.unregister();
      w.writers.delete(entry);
    }
  }

  /** .part del archivo en curso que no se han renombrado. */
  private pendingParts(w: FileWork): Id[] {
    const ids: Id[] = [];
    if (w.id && !w.mediaPromoted) ids.push(w.id);
    if (w.thumbId && !w.thumbPromoted) ids.push(w.thumbId);
    return ids;
  }

  /**
   * Rama de fallo de los pasos 0–6 con la sesión viva: borrado criptográfico de lo que llegó a
   * `objects|thumbs/`, borrado de los .part, DELETE de la fila `pending` (o deshacer la transacción
   * A) y salida de inFlight. Si un bloqueo llega a mitad, sigue como cleanupAborted.
   */
  private async cleanupFailed(w: FileWork): Promise<void> {
    await this.abortWriters(w);
    const store = this.storeOf();
    if (!this.aborted && w.id && w.mediaPromoted) await store.eraseObject(w.id, KIND_MEDIA);
    if (!this.aborted && w.thumbId && w.thumbPromoted) {
      await store.eraseObject(w.thumbId, KIND_THUMB);
    }
    if (this.aborted) return this.cleanupAborted(w);
    for (const id of this.pendingParts(w)) await store.erasePart(id);
    if (w.inserted && w.id && !this.aborted) {
      try {
        const db = this.db();
        if (w.replaceOld && w.hmac) undoReplacement(db, w.id, w.replaceOld, w.hmac);
        else deletePending(db, w.id);
      } catch {
        // LOCKED: la reconciliación borra la fila (sin objeto ni .part, §12.6 punto 1)
        log.warn('import.cleanup-failed', { jobId: this.id, stage: 'db' });
      }
    }
    w.release?.();
  }

  /**
   * [H3-6] Tras un abort: ninguna sentencia de DB, nada en `objects/` ni `thumbs/`; los .part del
   * archivo en curso se borran a través de KeylessCleanup (sin claves) y el trabajo espera a que
   * terminen antes de done(), así el desbloqueo siguiente (drained) no los pisa.
   */
  private async cleanupAborted(w: FileWork): Promise<void> {
    await this.abortWriters(w);
    const store = this.store;
    if (store) {
      const keyless = this.deps.session.cleanup;
      await Promise.all(
        this.pendingParts(w).map((id) =>
          keyless.run(store.partPath(id), async () => {
            await store.erasePart(id);
          }),
        ),
      );
    }
    w.release?.();
  }
}

/**
 * Importaciones de la sesión. Como mucho una activa (JobRegistry, §12.11): reserve() lanza BUSY
 * antes de abrir ningún diálogo.
 */
export class ImportService {
  private readonly jobs = new Map<Id, ImportJob>();

  constructor(private readonly deps: ImportServiceDeps) {}

  /** BUSY si ya hay una importación; LOCKED si la sesión no está desbloqueada. */
  reserve(): JobHandle {
    return this.deps.session.startJob('import');
  }

  /** El diálogo se canceló: libera la reserva sin empezar nada. */
  release(handle: JobHandle): void {
    handle.done();
  }

  /**
   * Empieza el trabajo con las rutas recibidas (tal cual, [H3-3]). `done` se resuelve con el
   * informe (null si un bloqueo lo abortó); nunca rechaza.
   */
  launch(
    handle: JobHandle,
    paths: readonly string[],
  ): { jobId: Id; done: Promise<ImportReport | null> } {
    if (handle.signal.aborted) {
      handle.done();
      throw new AppErrorException({ code: 'LOCKED' });
    }
    const job = new ImportJob(this.deps, handle, paths);
    this.jobs.set(job.id, job);
    const done = job.run().finally(() => {
      this.jobs.delete(job.id);
    });
    return { jobId: job.id, done };
  }

  /** import:confirm. NOT_FOUND si el trabajo no está en awaiting-confirmation. */
  confirm(jobId: Id, convert: boolean): void {
    const job = this.jobs.get(jobId);
    if (!job || !job.awaitingConfirmation) throw new AppErrorException({ code: 'NOT_FOUND' });
    job.answer(convert);
  }

  /** import:cancel. Un id desconocido (ya terminado) se ignora. */
  cancel(jobId: Id): void {
    this.jobs.get(jobId)?.cancel();
  }

  /** Trabajos en curso (también los abortados que aún limpian). */
  get activeJobIds(): Id[] {
    return [...this.jobs.keys()];
  }
}
