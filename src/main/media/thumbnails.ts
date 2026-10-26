// Miniaturas (docs/DESIGN.md §12.4, paso 4). Todo en memoria: la miniatura sale como buffer WebP y
// quien llama la cifra con createObjectWriter({ kind: 2 }) a tmp/<thumbId>.part.
//
// - Foto: sharp(buffer, { sequentialRead, limitInputPixels }) → autoOrient → 512×512 inside sin
//   ampliar → WebP q78 (de un GIF o WebP animado, el primer fotograma). Sin metadatos.
// - Vídeo: fotograma PNG en t = min(1 s, 10 % de la duración) leído DEL OBJETO TEMPORAL CIFRADO por
//   el loopback (ffmpeg nunca lee un descifrado del disco) → sharp → WebP; si falla, se reintenta
//   en t = 0. Demuxer según el MIME almacenado: video/mp4 → mov, video/webm → matroska.
import { AppErrorException } from '@shared/errors';
import { MAX_INPUT_PIXELS, PHOTO_MAX_BYTES } from '@shared/constants';
import { FfmpegError, frameCommand, type Demuxer, type Ffmpeg } from './ffmpeg';
import { getSharp } from './sharp-loader';

export const THUMB_SIZE_PX = 512;
export const THUMB_WEBP_QUALITY = 78;
/** Fotograma PNG por pipe:1: como mucho el límite de las fotos. */
export const FRAME_MAX_BYTES = PHOTO_MAX_BYTES;

/** Miniatura WebP de una foto (o de un fotograma PNG). UNSUPPORTED_FORMAT/TOO_LARGE si sharp falla. */
export async function photoThumbnail(buffer: Buffer): Promise<Buffer> {
  const sharp = await getSharp();
  try {
    return await sharp(buffer, { sequentialRead: true, limitInputPixels: MAX_INPUT_PIXELS })
      .autoOrient()
      .resize(THUMB_SIZE_PX, THUMB_SIZE_PX, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: THUMB_WEBP_QUALITY })
      .toBuffer();
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    throw new AppErrorException({
      code: /pixel limit/i.test(message) ? 'TOO_LARGE' : 'UNSUPPORTED_FORMAT',
    });
  }
}

/** Demuxer del objeto almacenado según su MIME (§12.4, paso 4). */
export function demuxerForMime(mime: string): Demuxer {
  if (mime === 'video/mp4') return 'mov';
  if (mime === 'video/webm') return 'matroska';
  throw new RangeError('MIME de vídeo no admitido');
}

/** Instante del fotograma: min(1 s, 10 % de la duración); sin duración, 0. */
export function frameTimeSeconds(durationMs: number | null): number {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.min(1, (durationMs / 1000) * 0.1);
}

export interface VideoThumbnailOptions {
  ffmpeg: Pick<Ffmpeg, 'run'>;
  /** URL del loopback que sirve el objeto temporal cifrado (tmp/<id>.part). */
  url: string;
  /** MIME almacenado (video/mp4 o video/webm). */
  mime: string;
  durationMs: number | null;
  signal?: AbortSignal;
}

async function frameAt(opts: VideoThumbnailOptions, atSeconds: number): Promise<Buffer> {
  const png = await opts.ffmpeg.run(
    frameCommand({
      input: { kind: 'loopback', url: opts.url, demuxer: demuxerForMime(opts.mime) },
      atSeconds,
    }),
    { signal: opts.signal, maxStdoutBytes: FRAME_MAX_BYTES },
  );
  try {
    if (png.length === 0) throw new FfmpegError('FFMPEG_FAILED', 'empty-frame');
    return await photoThumbnail(png);
  } finally {
    png.fill(0); // píxeles descifrados: fuera de la memoria en cuanto hay miniatura
  }
}

/** Miniatura WebP de un vídeo desde su objeto temporal por loopback; reintento en t = 0. */
export async function videoThumbnail(opts: VideoThumbnailOptions): Promise<Buffer> {
  const t = frameTimeSeconds(opts.durationMs);
  try {
    return await frameAt(opts, t);
  } catch (err) {
    const code = err instanceof AppErrorException ? err.error.code : null;
    if (t === 0 || code === 'CANCELLED' || code === 'FFMPEG_MISSING' || opts.signal?.aborted) {
      throw err;
    }
    return frameAt(opts, 0);
  }
}
