// Fusión de dos vídeos lado a lado (docs/DESIGN.md §18.2–§18.7; PLAN.md 5.1 y 5.3). Un trabajo
// `merge` del JobRegistry de la sesión (como mucho uno, §12.11; puede coexistir con una importación).
//
//   §18.2  H, FPS, D y Δ con los datos de la DB (dimensiones de visualización: la rotación ya está
//          aplicada) → mergeParams(), puro.
//   §18.3  línea de comandos exacta (mergeCommand de media/ffmpeg.ts, constructor congelado): las
//          dos entradas son objetos cifrados servidos por el loopback (§18.5) y la salida es pipe:1.
//   §18.6  1. pipe:1 → ObjectWriter (kind 1, tmp/<id>.part) con backpressure; SHA-256 y HMAC de
//             duplicados sobre la salida;
//          2. merge:progress como mucho cada 250 ms (out_time_us / D);
//          3. verificación: descifrar el .part entero (hashB == hashA) y ffprobe -f mov por el
//             loopback: pista de vídeo, duración D ± 0,5 s y tamaño = suma de los anchos × H;
//          4. fusión idéntica (mismo HMAC) → se borra el .part y `existed: true`;
//          5. miniatura (fotograma del .part cifrado por el loopback);
//          6. INSERT `pending` con source = 'merge', converted = 1, captured_at_source = 'generated'
//             e inFlight;
//          7. renombrar, `ready`, library:changed { reason: 'merge' } y merge:done.
//
// NADA DESCIFRADO TOCA EL DISCO: ffmpeg lee las entradas solo por el loopback (127.0.0.1, puerto
// aleatorio, token de 256 bits; se cierra al terminar, cancelar o bloquear) y escribe solo en
// pipe:1, que va directo al cifrador. Nunca hay `-y <archivo>`, temporales ni archivos de log.
//
// D18 (confirmado por el usuario): mientras dura la fusión el bloqueo por inactividad está en pausa
// (motivo 'job'). Suspender, bloquear el SO y bloquear a mano la cancelan al momento: el manejador
// de `abort` del trabajo mata ffmpeg, cierra el loopback, encarga a KeylessCleanup el borrado de
// los .part y llama a done() en el mismo instante, así el bloqueo pone las claves a cero sin
// esperar (ni siquiera los 2 s de un bloqueo manual). Tras un bloqueo no se ejecuta ninguna
// sentencia, no se toca objects/ ni thumbs/ y no se envía merge:done (la ventana se sustituye).
import { createHash, randomBytes } from 'node:crypto';
import { AppErrorException, type AppError } from '@shared/errors';
import type { Id, MergeDone, MergeProgress, MergeRequest } from '@shared/types';
import { KIND_MEDIA, KIND_THUMB, type ObjectKind } from '../crypto/file-format';
import { openObject, type ObjectReader } from '../crypto/object-reader';
import type { ObjectWriter, ObjectWriterResult } from '../crypto/object-writer';
import type { Db } from '../db/database';
import {
  deletePending,
  findByHmac,
  insertPending,
  markReady,
  mergeSource,
  type MergeSourceRow,
  type NewMedia,
} from '../db/repos/media-repo';
import { generatedCapturedAt } from '../import/capture-date';
import { probeVideo, type VideoSummary } from '../import/video-pipeline';
import type { LibraryEvents } from '../ipc/library-events';
import { log } from '../log';
import type { JobHandle } from '../session/jobs';
import type { SessionManager } from '../session/session-manager';
import type { InFlight } from '../vault/in-flight';
import { fileIdOf, ObjectStore } from '../vault/object-store';
import {
  mergeCommand,
  type Demuxer,
  type Ffmpeg,
  type FfmpegCommand,
  type FfmpegProgress,
  type MergeAudioGraph,
  type RunningFfmpeg,
} from './ffmpeg';
import { LoopbackServer, type LoopbackOptions, type LoopbackTarget } from './loopback-server';
import { demuxerForMime, videoThumbnail } from './thumbnails';

/** §18.2: la altura común nunca pasa de 1080. */
export const MERGE_MAX_HEIGHT = 1080;
/** §18.2: FPS = min(60, max(fpsL ?? 30, fpsR ?? 30)). */
export const MERGE_MAX_FPS = 60;
export const MERGE_DEFAULT_FPS = 30;
/** §18.6 paso 2. */
export const MERGE_PROGRESS_INTERVAL_MS = 250;
/** §18.6 paso 3: duración de la salida = D ± 0,5 s. */
export const MERGE_DURATION_TOLERANCE_MS = 500;

const MERGE_MIMES: ReadonlySet<string> = new Set(['video/mp4', 'video/webm']);

const newId = (): Id => randomBytes(16).toString('hex');
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function invalid(reason: string): AppErrorException {
  return new AppErrorException({ code: 'VALIDATION', details: { reason } });
}

function integrity(reason: string): AppErrorException {
  return new AppErrorException({ code: 'INTEGRITY', details: { reason } });
}

function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : undefined;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/** Cualquier fallo como AppError: los propios tal cual; ENOSPC/SQLITE_FULL → DISK_FULL; E/S → IO. */
function appErrorOf(err: unknown): AppError {
  if (err instanceof AppErrorException) return err.error;
  const errno = errnoOf(err);
  if (errno === 'ENOSPC' || errno === 'SQLITE_FULL') return { code: 'DISK_FULL' };
  return { code: errno ? 'IO' : 'INTERNAL' };
}

// ── Parámetros (§18.2) ─────────────────────────────────────────────────────────────────────────

/** `H = 2 · floor(min(hL, hR, 1080) / 2)` con las alturas de visualización. */
export function mergeHeight(leftHeight: number, rightHeight: number): number {
  return 2 * Math.floor(Math.min(leftHeight, rightHeight, MERGE_MAX_HEIGHT) / 2);
}

/**
 * Ancho que da `scale=-2:H`: `av_rescale(H, w, 2·h) · 2` (redondeo al más cercano, las mitades
 * hacia arriba), siempre par. Comprobado con el ffmpeg empaquetado (PLAN.md, nota 197 e).
 */
export function scaledWidth(width: number, height: number, target: number): number {
  return Math.floor((target * width + height) / (2 * height)) * 2;
}

export interface MergeParams {
  /** `H`, par y ≤ 1080. */
  height: number;
  /** `FPS` con 3 decimales. */
  fps: number;
  /** `D` en segundos con 3 decimales. */
  durationS: number;
  /** `D` en ms (verificación, §18.6 paso 3). */
  durationMs: number;
  /** `Δ = |dL − dR|` en segundos con 3 decimales. */
  deltaS: number;
  /** Lado que se alarga con `tpad` (duration = longest y es el más corto), o null. */
  pad: 'left' | 'right' | null;
  /** Audio ya resuelto: `mix` con un solo lado con audio pasa a ser ese lado (§18.3). */
  audio: MergeAudioGraph;
  /** Demuxer de cada entrada según su MIME almacenado (mov | matroska). */
  demuxers: readonly [Demuxer, Demuxer];
  /** Anchos tras `scale=-2:H`. */
  widths: readonly [number, number];
  /** Ancho de la salida (hstack): la suma. */
  width: number;
}

/**
 * Valida las dos entradas y calcula los parámetros de §18.2–§18.3. VALIDATION con
 * `details.reason`: `same-video` (leftId === rightId), `not-ready` (no existe o no está `ready`),
 * `not-video` (una foto), `mime`, `metadata` (sin dimensiones o sin duración) o `audio` (se pidió
 * el audio de un lado que no lo tiene mientras el otro sí). Con ningún lado con audio, el audio es
 * `none` sea cual sea la opción.
 */
export function mergeParams(
  req: Pick<MergeRequest, 'leftId' | 'rightId' | 'audio' | 'duration'>,
  left: MergeSourceRow | null,
  right: MergeSourceRow | null,
): MergeParams {
  if (req.leftId === req.rightId) throw invalid('same-video');
  if (!left || !right || left.id !== req.leftId || right.id !== req.rightId) {
    throw invalid('not-ready');
  }
  if (left.kind !== 'video' || right.kind !== 'video') throw invalid('not-video');
  if (!MERGE_MIMES.has(left.mime) || !MERGE_MIMES.has(right.mime)) throw invalid('mime');
  const positive = (n: number | null): n is number => n !== null && Number.isFinite(n) && n > 0;
  if (
    !positive(left.width) ||
    !positive(left.height) ||
    !positive(right.width) ||
    !positive(right.height) ||
    !positive(left.durationMs) ||
    !positive(right.durationMs)
  ) {
    throw invalid('metadata');
  }
  const height = mergeHeight(left.height, right.height);
  if (height < 2) throw invalid('metadata');

  let audio: MergeAudioGraph;
  if (!left.hasAudio && !right.hasAudio) audio = 'none';
  else if (req.audio === 'none') audio = 'none';
  else if (req.audio === 'mix')
    audio = left.hasAudio && right.hasAudio ? 'mix' : left.hasAudio ? 'left' : 'right';
  else if (req.audio === 'left') {
    if (!left.hasAudio) throw invalid('audio');
    audio = 'left';
  } else {
    if (!right.hasAudio) throw invalid('audio');
    audio = 'right';
  }

  const dL = left.durationMs / 1000;
  const dR = right.durationMs / 1000;
  const durationS = round3(req.duration === 'shortest' ? Math.min(dL, dR) : Math.max(dL, dR));
  const deltaS = round3(Math.abs(dL - dR));
  const pad = req.duration === 'longest' && deltaS > 0 ? (dL < dR ? 'left' : 'right') : null;
  const fpsOf = (fps: number | null): number => (positive(fps) ? fps : MERGE_DEFAULT_FPS);
  const fps = round3(Math.min(MERGE_MAX_FPS, Math.max(fpsOf(left.fps), fpsOf(right.fps))));
  const widths = [
    scaledWidth(left.width, left.height, height),
    scaledWidth(right.width, right.height, height),
  ] as const;
  return {
    height,
    fps,
    durationS,
    durationMs: Math.round(durationS * 1000),
    deltaS,
    pad,
    audio,
    demuxers: [demuxerForMime(left.mime), demuxerForMime(right.mime)],
    widths,
    width: widths[0] + widths[1],
  };
}

/** El comando de §18.3 para estos parámetros y las URLs del loopback de cada entrada. */
export function mergeCommandFor(
  params: MergeParams,
  urls: { left: string; right: string },
): FfmpegCommand {
  return mergeCommand({
    left: { kind: 'loopback', url: urls.left, demuxer: params.demuxers[0] },
    right: { kind: 'loopback', url: urls.right, demuxer: params.demuxers[1] },
    height: params.height,
    fps: params.fps,
    durationS: params.durationS,
    deltaS: params.deltaS,
    pad: params.pad,
    audio: params.audio,
  });
}

// ── Servicio ───────────────────────────────────────────────────────────────────────────────────

export interface MergeEvents {
  progress(progress: MergeProgress): void;
  done(done: MergeDone): void;
}

export type MergeSession = Pick<
  SessionManager,
  | 'epoch'
  | 'startJob'
  | 'getDb'
  | 'getKeyRing'
  | 'getVaultDir'
  | 'registerWriter'
  | 'registerReader'
  | 'cleanup'
>;

export type MergeFfmpeg = Pick<Ffmpeg, 'available' | 'run' | 'start'>;

export interface MergeServiceDeps {
  session: MergeSession;
  ffmpeg: MergeFfmpeg;
  events: MergeEvents;
  library: Pick<LibraryEvents, 'beginJob' | 'changed'>;
  /** Un único conjunto por proceso (index.ts), compartido con la reconciliación (§12.6). */
  inFlight: InFlight;
  /** Solo tests: arranque del servidor loopback (por defecto LoopbackServer.start). */
  startLoopback?: (opts: LoopbackOptions) => Promise<LoopbackServer>;
  /** Solo tests: reloj de pared (captured_at e imported_at). */
  now?: () => number;
}

/** El trabajo se detiene: bloqueo (`abort`) o "Cancelar" antes del INSERT (`cancel`). */
class Stop extends Error {
  constructor(readonly kind: 'abort' | 'cancel') {
    super(kind);
  }
}

/** Un `.part` que ha creado el trabajo (salida de ffmpeg o miniatura). */
interface Part {
  id: Id;
  kind: ObjectKind;
  /** null tras finish() (el descriptor ya está cerrado). */
  writer: ObjectWriter | null;
  unregister: () => void;
  promoted: boolean;
}

type MergeResult = MergeDone['result'];

class MergeJob {
  readonly id: Id;
  private readonly epoch: number;
  private readonly cancelCtl = new AbortController();
  /** Bloqueo (JobHandle) o "Cancelar". */
  private readonly signal: AbortSignal;
  private store: ObjectStore | null = null;
  private lb: LoopbackServer | null = null;
  private lbPromise: Promise<LoopbackServer> | null = null;
  private proc: RunningFfmpeg | null = null;
  private readonly parts = new Map<Id, Part>();
  private mediaId: Id | null = null;
  private inserted = false;
  private release: (() => void) | null = null;
  private lastProgress = 0;
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  private fraction = 0;

  constructor(
    private readonly deps: MergeServiceDeps,
    private readonly handle: JobHandle,
    private readonly req: MergeRequest,
    private readonly params: MergeParams,
    private readonly left: MergeSourceRow,
    private readonly right: MergeSourceRow,
  ) {
    this.id = handle.id;
    this.epoch = handle.epoch;
    this.signal = AbortSignal.any([handle.signal, this.cancelCtl.signal]);
    if (handle.signal.aborted) this.onLock();
    else handle.signal.addEventListener('abort', () => this.onLock(), { once: true });
  }

  /** Bloqueo de la sesión (no "Cancelar"). */
  private get aborted(): boolean {
    return this.handle.signal.aborted;
  }

  private get cancelled(): boolean {
    return this.cancelCtl.signal.aborted;
  }

  /** "Cancelar": solo antes del INSERT (después, la fusión ya está prácticamente hecha). */
  cancel(): void {
    if (this.inserted || this.cancelled) return;
    this.cancelCtl.abort('cancel');
  }

  private check(): void {
    if (this.aborted) throw new Stop('abort');
    if (this.cancelled && !this.inserted) throw new Stop('cancel');
  }

  // ── Sesión con la época del trabajo [H3-6] ──────────────────────────────────────────────────

  private db(): Db {
    return this.deps.session.getDb(this.epoch);
  }

  private keyRing(): ReturnType<MergeSession['getKeyRing']> {
    return this.deps.session.getKeyRing(this.epoch);
  }

  private storeOf(): ObjectStore {
    if (!this.store) throw new AppErrorException({ code: 'LOCKED' });
    return this.store;
  }

  /**
   * Bloqueo (suspender, bloqueo del SO, bloqueo manual…): síncrono, dentro de abortAll (paso 2 de
   * §13.3). ffmpeg muerto, loopback cerrándose, borrado de los .part por KeylessCleanup (sin
   * claves) y done() ya, para que el bloqueo ponga las claves a cero sin esperar. Si la fila
   * `pending` ya está insertada, sus .part se quedan para la reconciliación (§12.6 punto 1).
   */
  private onLock(): void {
    this.proc?.kill();
    void this.lb?.close();
    const store = this.store;
    if (store) {
      const keyless = this.deps.session.cleanup;
      for (const part of this.parts.values()) {
        if (part.promoted) continue;
        const writer = part.writer;
        if (this.inserted) {
          if (writer) void keyless.run(store.partPath(part.id), () => writer.abort());
          continue;
        }
        void keyless.run(store.partPath(part.id), async () => {
          await writer?.abort(); // cierra el descriptor (y borra un .part sin terminar)
          await store.erasePart(part.id);
        });
      }
    }
    this.release?.();
    this.handle.done();
  }

  // ── Progreso ──────────────────────────────────────────────────────────────────────────────

  private onProgress(p: FfmpegProgress): void {
    let fraction: number | null = null;
    if (p.done) fraction = 1;
    else if (p.outTimeUs !== null) fraction = p.outTimeUs / (this.params.durationS * 1_000_000);
    if (fraction === null) return;
    this.fraction = Math.min(1, Math.max(0, fraction));
    const wait = this.lastProgress + MERGE_PROGRESS_INTERVAL_MS - Date.now();
    if (wait <= 0) return this.sendProgress();
    if (this.progressTimer) return;
    this.progressTimer = setTimeout(() => this.sendProgress(), wait);
    this.progressTimer.unref?.();
  }

  private sendProgress(): void {
    this.lastProgress = Date.now();
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = null;
    if (this.aborted) return; // nunca a la ventana nueva tras un bloqueo
    try {
      this.deps.events.progress({ jobId: this.id, fraction: this.fraction });
    } catch {
      // la ventana puede no existir
    }
  }

  // ── Trabajo ───────────────────────────────────────────────────────────────────────────────

  /** Nunca rechaza. null si un bloqueo lo abortó (no se envía merge:done). */
  async run(): Promise<MergeResult | null> {
    const endBatch = this.deps.library.beginJob();
    this.handle.setPausesAutoLock(true); // D18
    log.info('merge.started', { jobId: this.id });
    let result: MergeResult | null;
    try {
      result = { ok: true, data: await this.steps() };
    } catch (err) {
      result = await this.onError(err);
    } finally {
      if (this.progressTimer) clearTimeout(this.progressTimer);
      this.progressTimer = null;
      const lb = await this.lbPromise?.catch(() => null);
      await lb?.close();
      endBatch();
    }
    if (this.aborted) result = null;
    if (result) {
      try {
        this.deps.events.done({ jobId: this.id, result });
      } catch {
        // la ventana puede no existir
      }
    }
    if (!result) log.info('merge.interrupted', { jobId: this.id });
    else if (result.ok) {
      log.info(result.data.existed ? 'merge.existed' : 'merge.done', {
        jobId: this.id,
        mediaId: result.data.mediaId,
      });
    } else if (result.error.code === 'CANCELLED') {
      log.info('merge.cancelled', { jobId: this.id });
    } else {
      log.warn('merge.failed', { jobId: this.id, code: result.error.code });
    }
    // Lo último: el desbloqueo siguiente espera a drained() [H3-6] (tras un bloqueo, ya se llamó).
    this.handle.done();
    return result;
  }

  private async steps(): Promise<{ mediaId: Id; existed: boolean }> {
    const { session, ffmpeg } = this.deps;
    this.check();
    this.store = new ObjectStore(session.getVaultDir(this.epoch));
    const store = this.store;

    // Entradas: los dos objetos cifrados, descifrados al vuelo por el loopback (§18.5).
    const lb = await this.loopback();
    this.check();
    const target = (row: MergeSourceRow): LoopbackTarget => ({
      path: store.objectPath(row.id),
      fileId: fileIdOf(row.id),
      kind: KIND_MEDIA,
      mime: row.mime,
    });
    const urls = {
      left: lb.register('l', target(this.left)),
      right: lb.register('r', target(this.right)),
    };

    // 1. ffmpeg → pipe:1 → writer (SHA-256 y HMAC de la salida).
    const id = newId();
    this.mediaId = id;
    const writer = this.openWriter(id, KIND_MEDIA, this.keyRing().kDedup);
    const proc = ffmpeg.start(mergeCommandFor(this.params, urls), {
      signal: this.signal,
      onProgress: (p) => this.onProgress(p),
    });
    this.proc = proc;
    try {
      for await (const chunk of proc.stdout) await writer.write(chunk as Buffer);
    } catch (err) {
      proc.kill();
      await proc.done.catch(() => undefined);
      throw err;
    }
    await proc.done;
    this.proc = null;
    this.check();
    const written = await this.finishWriter(id);
    this.check();
    this.fraction = 1;
    this.sendProgress();

    // 3. Verificar: descifrar entero y ffprobe del .part por el loopback.
    const hashB = await this.digestPart(id);
    if (!hashB.equals(written.sha256)) throw integrity('hash');
    this.check();
    const partUrl = lb.register('part', {
      path: store.partPath(id),
      fileId: fileIdOf(id),
      kind: KIND_MEDIA,
      mime: 'video/mp4',
    });
    const summary = await this.verify(partUrl);
    this.check();

    // 4. Fusión idéntica: misma salida (VP9 con -map_metadata -1 es determinista, §18.6).
    const hmac = written.hmac as Buffer;
    const existing = findByHmac(this.db(), hmac);
    if (existing) return this.existed(existing.id);

    // 5. Miniatura desde el .part cifrado. Si falla, el vídeo entra sin ella (thumb_id = NULL).
    const thumb = await this.thumbnail(partUrl, summary.durationMs);
    lb.unregister('part');
    this.check();
    let thumbId: Id | null = null;
    if (thumb) {
      try {
        thumbId = newId();
        const tw = this.openWriter(thumbId, KIND_THUMB);
        await tw.write(thumb);
      } finally {
        thumb.fill(0);
      }
      await this.finishWriter(thumbId);
      this.check();
    }

    // 6. INSERT `pending` (inFlight antes del renombrado).
    this.release = this.deps.inFlight.track(id, thumbId);
    try {
      insertPending(this.db(), this.record(id, thumbId, written, summary, hmac));
    } catch (err) {
      // Otra escritura en paralelo con el mismo contenido (§18.6 paso 4): igual que idéntica.
      if (isUniqueViolation(err)) {
        const again = findByHmac(this.db(), hmac);
        if (again) return this.existed(again.id);
      }
      throw err;
    }
    this.inserted = true;

    // 7. Renombrar (objeto y miniatura), `ready` y evento. Tras un bloqueo, nada más [H3-6].
    this.check();
    await store.promote(id, KIND_MEDIA);
    (this.parts.get(id) as Part).promoted = true;
    this.check();
    if (thumbId) {
      await store.promote(thumbId, KIND_THUMB);
      (this.parts.get(thumbId) as Part).promoted = true;
      this.check();
    }
    if (!markReady(this.db(), id)) throw new AppErrorException({ code: 'IO' });
    this.release();
    this.release = null;
    this.deps.library.changed('merge', [id]);
    return { mediaId: id, existed: false };
  }

  /** §18.6 paso 4: borrado criptográfico de los .part y `existed: true` con el id existente. */
  private async existed(existingId: Id): Promise<{ mediaId: Id; existed: true }> {
    await this.discardParts();
    this.release?.();
    this.release = null;
    return { mediaId: existingId, existed: true };
  }

  /** NewMedia del resultado (§18.6 paso 6). */
  private record(
    id: Id,
    thumbId: Id | null,
    written: ObjectWriterResult,
    summary: VideoSummary,
    hmac: Buffer,
  ): NewMedia {
    const now = (this.deps.now ?? Date.now)();
    const captured = generatedCapturedAt(now);
    return {
      id,
      kind: 'video',
      source: 'merge',
      name: this.req.name,
      originalExt: 'mp4',
      mime: 'video/mp4',
      sizeBytes: written.plaintextSize,
      originalSizeBytes: written.plaintextSize,
      width: summary.width,
      height: summary.height,
      durationMs: summary.durationMs,
      fps: summary.fps ?? this.params.fps,
      hasAudio: summary.hasAudio,
      videoCodec: summary.videoCodec,
      audioCodec: summary.audioCodec,
      // §9.2: la salida de ffmpeg nunca es byte a byte un original.
      converted: true,
      capturedAt: captured.capturedAt,
      capturedAtSource: captured.source,
      importedAt: now,
      contentHmac: hmac,
      thumbId,
    };
  }

  /** §18.6 paso 3: pista de vídeo, duración D ± 0,5 s y tamaño (suma de anchos) × H. */
  private async verify(url: string): Promise<VideoSummary> {
    let summary: VideoSummary;
    try {
      ({ summary } = await probeVideo(
        this.deps.ffmpeg,
        { kind: 'loopback', url, demuxer: 'mov' },
        this.signal,
      ));
    } catch (err) {
      const code = err instanceof AppErrorException ? err.error.code : null;
      if (this.signal.aborted || code === 'CANCELLED' || code === 'FFMPEG_MISSING') throw err;
      throw integrity('probe');
    }
    if (!summary.hasVideo || summary.durationMs === null) throw integrity('no-video');
    if (Math.abs(summary.durationMs - this.params.durationMs) > MERGE_DURATION_TOLERANCE_MS) {
      throw integrity('duration');
    }
    if (summary.width !== this.params.width || summary.height !== this.params.height) {
      throw integrity('size');
    }
    return summary;
  }

  private async thumbnail(url: string, durationMs: number | null): Promise<Buffer | null> {
    try {
      return await videoThumbnail({
        ffmpeg: this.deps.ffmpeg,
        url,
        mime: 'video/mp4',
        durationMs,
        signal: this.signal,
      });
    } catch (err) {
      if (this.signal.aborted) throw err;
      const code = err instanceof AppErrorException ? err.error.code : undefined;
      log.warn('merge.thumb-failed', { jobId: this.id, code });
      return null;
    }
  }

  // ── Objetos cifrados ──────────────────────────────────────────────────────────────────────

  /**
   * Writer sobre tmp/<id>.part registrado en la sesión (paso 4 del bloqueo: destroyKeys). La
   * comprobación y la creación van en el mismo tick: tras un bloqueo nunca se crea un .part.
   */
  private openWriter(id: Id, kind: ObjectKind, hmacKey?: Buffer): ObjectWriter {
    this.check();
    const store = this.storeOf();
    const writer = store.createWriter({
      id,
      kind,
      kWrap: this.keyRing().kWrap,
      hmacKey,
      signal: this.signal,
    });
    const part: Part = { id, kind, writer, unregister: () => undefined, promoted: false };
    this.parts.set(id, part); // la rama de fallo lo aborta aunque falle el registro
    part.unregister = this.deps.session.registerWriter(writer, store.partPath(id), this.epoch);
    return writer;
  }

  /** finish() (fsync) y baja del SessionManager: desde aquí el .part es del trabajo. */
  private async finishWriter(id: Id): Promise<ObjectWriterResult> {
    const part = this.parts.get(id) as Part;
    const result = await (part.writer as ObjectWriter).finish();
    part.unregister();
    part.writer = null;
    return result;
  }

  /** SHA-256 del plaintext del .part, descifrándolo entero y verificando cada tag. */
  private async digestPart(id: Id): Promise<Buffer> {
    const keys = this.keyRing();
    const reader = this.registered(
      await this.storeOf().open(id, KIND_MEDIA, keys.kWrap, keys.dekCache, { part: true }),
    );
    const sha = createHash('sha256');
    try {
      if (reader.plaintextSize > 0) {
        for await (const chunk of reader.createReadStream(0, reader.plaintextSize - 1)) {
          this.check();
          sha.update(chunk as Buffer);
          (chunk as Buffer).fill(0); // plaintext descifrado: fuera de la memoria en cuanto se cuenta
        }
      }
    } finally {
      await reader.close();
    }
    return sha.digest();
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

  /** Servidor loopback del trabajo (§18.5): se cierra con la señal (cancelar o bloquear) y al final. */
  private async loopback(): Promise<LoopbackServer> {
    const start = this.deps.startLoopback ?? ((o: LoopbackOptions) => LoopbackServer.start(o));
    this.lbPromise ??= start({
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
    this.lb = await this.lbPromise;
    return this.lb;
  }

  // ── Rama de fallo ─────────────────────────────────────────────────────────────────────────

  /** null tras un bloqueo (onLock ya lo limpió todo sin claves). */
  private async onError(err: unknown): Promise<MergeResult | null> {
    if (this.aborted || (err instanceof Stop && err.kind === 'abort')) return null;
    const error: AppError =
      (this.cancelled && !this.inserted) || (err instanceof Stop && err.kind === 'cancel')
        ? { code: 'CANCELLED' }
        : appErrorOf(err);
    if (error.code === 'INTERNAL' || error.code === 'IO') {
      log.error('merge.failed', { jobId: this.id, code: error.code, errno: errnoOf(err) });
    }
    this.proc?.kill();
    await this.cleanupFailed();
    if (this.aborted) return null;
    return { ok: false, error };
  }

  /** Aborta los writers abiertos y borra (criptográficamente) los .part sin renombrar. */
  private async discardParts(): Promise<void> {
    const store = this.storeOf();
    for (const part of [...this.parts.values()]) {
      if (this.aborted) return; // onLock ya lo encargó a KeylessCleanup
      if (part.promoted) continue;
      await part.writer?.abort();
      part.unregister();
      part.writer = null;
      await store.erasePart(part.id);
      this.parts.delete(part.id);
    }
  }

  /**
   * Con la sesión viva: .part fuera, objetos ya renombrados con borrado criptográfico y la fila
   * `pending` borrada. Si solo falló el `ready` (todo renombrado), la fila y sus objetos los
   * resuelve la reconciliación (§12.6 punto 1), como en la importación.
   */
  private async cleanupFailed(): Promise<void> {
    if (!this.store) return;
    const parts = [...this.parts.values()];
    if (this.inserted && parts.every((p) => p.promoted)) {
      this.release?.();
      return;
    }
    await this.discardParts();
    for (const part of parts) {
      if (this.aborted) return;
      if (part.promoted) await this.store.eraseObject(part.id, part.kind);
    }
    if (this.inserted && this.mediaId && !this.aborted) {
      try {
        deletePending(this.db(), this.mediaId);
      } catch {
        // LOCKED: la reconciliación borra la fila (sin objeto ni .part, §12.6 punto 1)
        log.warn('merge.cleanup-failed', { jobId: this.id, stage: 'db' });
      }
    }
    this.release?.();
  }
}

/**
 * Fusiones de la sesión. Como mucho una activa (JobRegistry, §12.11: BUSY); puede coexistir con una
 * importación, una edición o una importación de música.
 */
export class MergeService {
  private readonly jobs = new Map<Id, MergeJob>();

  constructor(private readonly deps: MergeServiceDeps) {}

  /**
   * merge:start. Valida (VALIDATION, LOCKED, FFMPEG_MISSING), reserva el trabajo (BUSY) y lanza la
   * fusión en segundo plano. `done` se resuelve con el resultado que se envía en merge:done (null
   * si un bloqueo la interrumpió); nunca rechaza.
   */
  start(req: MergeRequest): { jobId: Id; done: Promise<MergeResult | null> } {
    const { session } = this.deps;
    if (req.leftId === req.rightId) throw invalid('same-video');
    const epoch = session.epoch;
    const db = session.getDb(epoch);
    const left = mergeSource(db, req.leftId);
    const right = mergeSource(db, req.rightId);
    const params = mergeParams(req, left, right);
    if (!this.deps.ffmpeg.available) throw new AppErrorException({ code: 'FFMPEG_MISSING' });
    const handle = session.startJob('merge');
    const job = new MergeJob(
      this.deps,
      handle,
      req,
      params,
      left as MergeSourceRow,
      right as MergeSourceRow,
    );
    this.jobs.set(handle.id, job);
    const done = job.run().finally(() => this.jobs.delete(handle.id));
    return { jobId: handle.id, done };
  }

  /** merge:cancel. Un id desconocido (ya terminada) se ignora. */
  cancel(jobId: Id): void {
    this.jobs.get(jobId)?.cancel();
  }
}
