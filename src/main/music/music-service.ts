// Importar música (docs/DESIGN.md §8.6.1). La pista se COPIA a <vaultDir>/music/ en claro (decisión
// del usuario: no revela nada de la bóveda) y el original nunca se borra ni se modifica: solo se
// abre en modo lectura. La carpeta music/ no dice nada de lo que hay dentro de la bóveda: cada
// archivo se llama `<trackId>.<ext>` (id aleatorio y la extensión canónica del formato detectado
// por firma), y el título (que sale del nombre del original) vive solo en la DB cifrada.
//
// Por archivo, en orden:
//   1. `lstat` (como §12.3 punto 1): solo archivos regulares, sin enlaces; > 1 GiB → TOO_LARGE;
//   2. se abre en modo lectura y se comprueba con `fstat` que es el mismo archivo (dev, ino y
//      tamaño): la firma y la copia salen del MISMO descriptor (sin TOCTOU entre comprobar y copiar);
//   3. firma de los primeros 64 bytes (music-sniff.ts); otra → UNSUPPORTED_FORMAT;
//   4. copia a music/<trackId>.<ext>.part (creado con 'wx'), fsync y cierre (el id entra antes en
//      inFlight para que la reconciliación de otra sesión no lo toque);
//   5. ffprobe de la copia (nuestro archivo) con el demuxer forzado: duración, y para un `ftyp` con
//      otro brand exige audio y ningún vídeo (sin ffmpeg → UNSUPPORTED_FORMAT); sin ffmpeg o si
//      falla, duration_ms = NULL (no es un error);
//   6. rename a music/<trackId>.<ext> (+ fsync del directorio en Linux);
//   7. INSERT en music_tracks (una transacción por pista); si falla, se borra el archivo copiado.
// Fallos: cada archivo por separado (UNSUPPORTED_FORMAT, TOO_LARGE, IO); DISK_FULL detiene la
// importación y el resto cuenta como DISK_FULL. Un bloqueo aborta entre archivos y también a mitad
// de la copia: se borra el `.part` en curso y la reconciliación (§12.6 punto 5) limpia lo demás.
// Nunca se registra ni el nombre ni la ruta del original (§21.2).
import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { AppErrorException, type ErrorCode } from '@shared/errors';
import { MUSIC_MAX_BYTES, MUSIC_SNIFF_BYTES, MUSIC_TITLE_MAX } from '@shared/constants';
import type { Id, MusicImportResult, MusicTrack } from '@shared/types';
import { insertTrack } from '../db/repos/music-repo';
import { log } from '../log';
import { probeCommand, type Ffmpeg } from '../media/ffmpeg';
import type { JobHandle } from '../session/jobs';
import type { SessionManager } from '../session/session-manager';
import { renameWithRetry } from '../settings/settings-store';
import type { InFlight } from '../vault/in-flight';
import { vaultPaths } from '../vault/vault-layout';
import { sniffMusic } from './music-sniff';

export const UNTITLED_TRACK = 'Pista sin título';
/** Bloque de copia. */
export const MUSIC_COPY_CHUNK = 1024 * 1024;
/** Salida máxima de ffprobe que se acepta. */
const PROBE_MAX_STDOUT = 1024 * 1024;

export type MusicFailureCode = MusicImportResult['failed'][number]['code'];

/** Puntos de fallo inyectables (solo tests). */
export type MusicFaultPoint = 'copy' | 'rename' | 'insert';

export interface MusicServiceDeps {
  session: Pick<SessionManager, 'startJob' | 'getDb' | 'getVaultDir'>;
  /** ffprobe para la duración y los `ftyp` con otro brand; null/no disponible = sin duración. */
  ffmpeg: Pick<Ffmpeg, 'available' | 'run'> | null;
  /** Un único conjunto por proceso: la reconciliación no toca los ids en curso. */
  inFlight: InFlight;
  now?: () => number;
  newId?: () => Id;
  /** Solo tests: lanza en el punto dado de cada archivo. */
  faults?: (point: MusicFaultPoint) => void | Promise<void>;
  /** Solo tests: tamaño máximo por archivo (por defecto 1 GiB, §8.6.1). */
  maxBytes?: number;
}

/** Título visible (§8.6.1): nombre sin extensión, NFC, sin \p{Cc}, trim y ≤ 200 code points. */
export function trackTitle(fileName: string): string {
  const stem = basename(fileName, extname(fileName));
  const cleaned = stem
    .normalize('NFC')
    .replace(/\p{Cc}/gu, '')
    .trim();
  const cut = [...cleaned].slice(0, MUSIC_TITLE_MAX).join('').trim();
  return cut.length > 0 ? cut : UNTITLED_TRACK;
}

class Failure extends Error {
  constructor(readonly code: MusicFailureCode) {
    super(code);
  }
}

function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : undefined;
}

function isDiskFull(err: unknown): boolean {
  const code = errnoOf(err);
  return (
    code === 'ENOSPC' ||
    code === 'SQLITE_FULL' ||
    (err instanceof AppErrorException && err.error.code === 'DISK_FULL')
  );
}

function locked(): AppErrorException {
  return new AppErrorException({ code: 'LOCKED' });
}

async function fsyncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Lee `length` bytes desde `position` (o menos si el archivo acaba). */
async function readAt(fh: FileHandle, length: number, position: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, position + got);
    if (bytesRead <= 0) break;
    got += bytesRead;
  }
  return buf.subarray(0, got);
}

interface ProbeInfo {
  hasAudio: boolean;
  hasVideo: boolean;
  durationMs: number | null;
}

/** Lo que importa de la salida JSON de ffprobe. Una salida que no se entiende → null. */
export function parseMusicProbe(stdout: string): ProbeInfo | null {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object') return null;
  const { streams, format } = json as { streams?: unknown; format?: unknown };
  const list = Array.isArray(streams) ? streams : [];
  let hasAudio = false;
  let hasVideo = false;
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const { codec_type: type, disposition } = s as {
      codec_type?: unknown;
      disposition?: { attached_pic?: unknown } | null;
    };
    if (type === 'audio') hasAudio = true;
    // Una portada (attached_pic) no es una pista de vídeo (PLAN.md, nota 104).
    if (type === 'video' && disposition?.attached_pic !== 1) hasVideo = true;
  }
  const raw = (format as { duration?: unknown } | null | undefined)?.duration;
  const seconds = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
  const durationMs = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
  return { hasAudio, hasVideo, durationMs };
}

export class MusicService {
  private readonly now: () => number;
  private readonly newId: () => Id;

  constructor(private readonly deps: MusicServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.newId = deps.newId ?? (() => randomBytes(16).toString('hex'));
  }

  /** Reserva el trabajo `music-import` antes de abrir el diálogo: BUSY o LOCKED (§12.11). */
  reserve(): JobHandle {
    return this.deps.session.startJob('music-import');
  }

  release(job: JobHandle): void {
    job.done();
  }

  /**
   * Copia cada archivo a music/ (en serie). Siempre libera el trabajo al terminar. LOCKED si un
   * bloqueo la interrumpe (después de borrar el `.part` en curso).
   */
  async importFiles(job: JobHandle, paths: readonly string[]): Promise<MusicImportResult> {
    const result: MusicImportResult = { imported: [], failed: [] };
    try {
      const musicDir = vaultPaths(this.deps.session.getVaultDir(job.epoch)).music;
      await mkdir(musicDir, { recursive: true });
      let diskFull = false;
      for (const path of paths) {
        const name = basename(path);
        if (job.signal.aborted) throw locked();
        if (diskFull) {
          result.failed.push({ name, code: 'DISK_FULL' });
          continue;
        }
        try {
          result.imported.push(await this.importOne(job, path, musicDir));
        } catch (err) {
          if (job.signal.aborted) throw locked();
          if (err instanceof Failure) {
            result.failed.push({ name, code: err.code });
            if (err.code === 'DISK_FULL') diskFull = true;
          } else {
            const code: MusicFailureCode = isDiskFull(err) ? 'DISK_FULL' : 'IO';
            log.warn('music.failed', { code, errno: errnoOf(err) });
            result.failed.push({ name, code });
            if (code === 'DISK_FULL') diskFull = true;
          }
        }
      }
      log.info('music.imported', { count: result.imported.length });
      return result;
    } finally {
      job.done();
    }
  }

  private async importOne(job: JobHandle, path: string, musicDir: string): Promise<MusicTrack> {
    // 1. lstat: solo archivos regulares (sin enlaces ni junctions) y ≤ 1 GiB.
    let st: Stats;
    try {
      st = await lstat(path);
    } catch (err) {
      log.warn('music.failed', { code: 'IO', errno: errnoOf(err), stage: 'lstat' });
      throw new Failure('IO');
    }
    if (st.isSymbolicLink() || !st.isFile()) throw new Failure('UNSUPPORTED_FORMAT');
    if (st.size > (this.deps.maxBytes ?? MUSIC_MAX_BYTES)) throw new Failure('TOO_LARGE');

    // 2. Solo lectura: el original nunca se escribe, se mueve ni se borra.
    let src: FileHandle;
    try {
      src = await open(path, 'r');
    } catch (err) {
      log.warn('music.failed', { code: 'IO', errno: errnoOf(err), stage: 'open' });
      throw new Failure('IO');
    }
    try {
      const fst = await src.stat();
      if (fst.dev !== st.dev || fst.ino !== st.ino || fst.size !== st.size || !fst.isFile()) {
        throw new Failure('IO');
      }
      // 3. Firma.
      const sniff = sniffMusic(await readAt(src, MUSIC_SNIFF_BYTES, 0));
      if (sniff.kind !== 'audio') throw new Failure('UNSUPPORTED_FORMAT');
      if (sniff.needsProbe && !this.deps.ffmpeg?.available) throw new Failure('UNSUPPORTED_FORMAT');

      const id = this.newId();
      const fileName = `${id}.${sniff.ext}`;
      const finalPath = join(musicDir, fileName);
      const partPath = `${finalPath}.part`;
      const releaseInFlight = this.deps.inFlight.track(id);
      let partExists = false;
      let finalExists = false;
      try {
        // 4. Copia desde el mismo descriptor.
        await this.deps.faults?.('copy');
        const out = await open(partPath, 'wx', 0o600);
        partExists = true;
        let copied = 0;
        try {
          while (copied < st.size) {
            if (job.signal.aborted) throw locked();
            const chunk = await readAt(src, Math.min(MUSIC_COPY_CHUNK, st.size - copied), copied);
            if (chunk.length === 0) break;
            await out.write(chunk, 0, chunk.length);
            copied += chunk.length;
          }
          await out.sync();
        } finally {
          await out.close();
        }
        if (copied !== st.size) throw new Failure('IO'); // cambió mientras se copiaba
        if (job.signal.aborted) throw locked();

        // 5. ffprobe de nuestra copia.
        const probe = await this.probe(partPath, sniff.demuxer, job.signal);
        if (job.signal.aborted) throw locked();
        if (sniff.needsProbe && !(probe?.hasAudio && !probe.hasVideo)) {
          throw new Failure('UNSUPPORTED_FORMAT');
        }

        // 6. Nombre final.
        await this.deps.faults?.('rename');
        await renameWithRetry(partPath, finalPath);
        partExists = false;
        finalExists = true;
        await fsyncDir(musicDir).catch(() => undefined);

        // 7. Fila (la DB con la época del trabajo: tras un bloqueo, LOCKED sin tocar nada).
        await this.deps.faults?.('insert');
        const track = insertTrack(this.deps.session.getDb(job.epoch), {
          id,
          fileName,
          title: trackTitle(basename(path)),
          ext: sniff.ext,
          mime: sniff.mime,
          sizeBytes: copied,
          durationMs: probe?.durationMs ?? null,
          importedAt: this.now(),
        });
        finalExists = false;
        return track;
      } catch (err) {
        // El archivo copiado está en claro y es nuestro: basta con unlink (§8.6.1).
        if (partExists) await unlink(partPath).catch(() => undefined);
        if (finalExists) await unlink(finalPath).catch(() => undefined);
        if (err instanceof Failure || job.signal.aborted) throw err;
        if (isDiskFull(err)) throw new Failure('DISK_FULL');
        const code: ErrorCode | undefined =
          err instanceof AppErrorException ? err.error.code : undefined;
        log.warn('music.failed', { code: code ?? 'IO', errno: errnoOf(err), stage: 'copy' });
        throw new Failure('IO');
      } finally {
        releaseInFlight();
      }
    } finally {
      await src.close().catch(() => undefined);
    }
  }

  /** ffprobe de la copia (timeout 30 s). null sin ffmpeg o si falla (salvo un abort). */
  private async probe(
    path: string,
    demuxer: Parameters<typeof probeCommand>[0]['demuxer'],
    signal: AbortSignal,
  ): Promise<ProbeInfo | null> {
    const ffmpeg = this.deps.ffmpeg;
    if (!ffmpeg?.available) return null;
    try {
      const out = await ffmpeg.run(probeCommand({ kind: 'file', path, demuxer }), {
        signal,
        maxStdoutBytes: PROBE_MAX_STDOUT,
      });
      return parseMusicProbe(out.toString('utf8'));
    } catch (err) {
      if (signal.aborted) throw locked();
      log.debug('music.probe-failed', {
        code: err instanceof AppErrorException ? err.error.code : undefined,
      });
      return null;
    }
  }
}
