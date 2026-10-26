// Pipeline de fotos (docs/DESIGN.md §12.4 pasos 0 y 4, §12.8). Nada se escribe en disco: el original
// se lee una sola vez a un buffer, exifr y sharp trabajan sobre ese buffer (sharp con
// VIPS_DISC_THRESHOLD = 4g y sin caché, sharp-loader.ts) y la miniatura sale como buffer WebP
// (thumbnails.ts) hacia el writer cifrado.
//
// - readPhotoOriginal: lectura por el mismo descriptor cuyo fstat se compara con el snapshot del
//   escaneo (sin TOCTOU entre la comprobación y la lectura); ≤ 256 MiB.
// - exifr.parse con { tiff, exif, gps, ifd0, translateValues: false, reviveValues: false }: las
//   fechas llegan como texto y las convierte capture-date.ts.
// - EXIF saneado (§12.8, §9.2): textos sin \p{Cc} y ≤ 256 code points; números solo si son finitos
//   (ISO y orientación, enteros); GPS solo dentro de [−90, 90] y [−180, 180]; raw_json con una
//   lista cerrada de etiquetas técnicas (nunca descripciones ni comentarios) y ≤ 16 KiB.
import exifr from 'exifr';
import { open } from 'node:fs/promises';
import { AppErrorException } from '@shared/errors';
import { MAX_INPUT_PIXELS, PHOTO_MAX_BYTES, type PhotoFormat } from '@shared/constants';
import type { MediaExifInput } from '../db/repos/media-repo';
import { getSharp } from '../media/sharp-loader';
import { parseTzOffset, photoCapturedAt, type CapturedAt } from './capture-date';
import { sniffBuffer } from './sniff';
import { sameSnapshot, snapshotOf, type Snapshot } from './walk';

/** Opciones de §12.4, paso 0. */
export const EXIFR_OPTIONS = Object.freeze({
  tiff: true,
  exif: true,
  gps: true,
  ifd0: true,
  translateValues: false,
  reviveValues: false,
});

export const EXIF_STRING_MAX = 256;
export const EXIF_RAW_JSON_MAX = 16 * 1024;

/** Etiquetas que se copian a raw_json (técnicas; nunca texto libre del usuario). */
const RAW_KEYS = [
  'Make',
  'Model',
  'LensMake',
  'LensModel',
  'DateTimeOriginal',
  'CreateDate',
  'OffsetTimeOriginal',
  'FNumber',
  'ExposureTime',
  'ISO',
  'FocalLength',
  'FocalLengthIn35mmFormat',
  'ExposureProgram',
  'ExposureCompensation',
  'MeteringMode',
  'Flash',
  'WhiteBalance',
  'Orientation',
  'latitude',
  'longitude',
] as const;

const CONTROL = /\p{Cc}/gu;

/** Lee el original por el descriptor comprobado. 'changed' si ya no es el archivo del escaneo. */
export async function readPhotoOriginal(
  path: string,
  snapshot: Snapshot,
): Promise<Buffer | 'changed'> {
  if (snapshot.size > BigInt(PHOTO_MAX_BYTES)) throw new AppErrorException({ code: 'TOO_LARGE' });
  let fh;
  try {
    fh = await open(path, 'r');
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'ENOENT') return 'changed';
    throw new AppErrorException({ code: 'IO' });
  }
  try {
    const st = await fh.stat({ bigint: true });
    if (!st.isFile() || !sameSnapshot(snapshotOf(st), snapshot)) return 'changed';
    const buffer = await fh.readFile();
    if (BigInt(buffer.length) !== snapshot.size) {
      buffer.fill(0);
      return 'changed';
    }
    return buffer;
  } catch (err) {
    if (err instanceof AppErrorException) throw err;
    throw new AppErrorException({ code: 'IO' });
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** exifr sobre el buffer; null si no hay EXIF o no se puede leer (no impide importar). */
export async function parsePhotoExif(buffer: Buffer): Promise<Record<string, unknown> | null> {
  try {
    // Los tipos de exifr no admiten `ifd0: true` (el IFD0 no se puede desactivar); en ejecución sí.
    const options = { ...EXIFR_OPTIONS } as unknown as Parameters<typeof exifr.parse>[1];
    const out: unknown = await exifr.parse(buffer, options);
    return out && typeof out === 'object' ? (out as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function cleanExifString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = [...value.replace(CONTROL, '').trim()].slice(0, EXIF_STRING_MAX).join('').trim();
  return s.length > 0 ? s : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function integer(value: unknown): number | null {
  const n = finite(Array.isArray(value) ? value[0] : value);
  return n !== null && Number.isInteger(n) ? n : null;
}

function inRange(value: unknown, limit: number): number | null {
  const n = finite(value);
  return n !== null && n >= -limit && n <= limit ? n : null;
}

/** media_exif saneado (§9.2, §12.8); null si no hay ninguna etiqueta útil. */
export function sanitizeExif(raw: Record<string, unknown> | null): MediaExifInput | null {
  if (!raw) return null;
  const orientation = integer(raw.Orientation);
  const gpsLat = inRange(raw.latitude, 90);
  const gpsLon = inRange(raw.longitude, 180);
  const latLon = gpsLat !== null && gpsLon !== null;
  const rawSubset: Record<string, string | number> = {};
  for (const key of RAW_KEYS) {
    const v = raw[key];
    if (key === 'latitude' || key === 'longitude') {
      if (latLon) rawSubset[key] = (key === 'latitude' ? gpsLat : gpsLon) as number;
      continue;
    }
    const s = cleanExifString(v);
    if (s !== null) rawSubset[key] = s;
    else if (finite(v) !== null) rawSubset[key] = v as number;
  }
  let rawJson = JSON.stringify(rawSubset);
  // Con la lista cerrada nunca se acerca a 16 KiB; aun así se acota.
  while (Buffer.byteLength(rawJson) > EXIF_RAW_JSON_MAX) {
    const keys = Object.keys(rawSubset);
    delete rawSubset[keys[keys.length - 1] as string];
    rawJson = JSON.stringify(rawSubset);
  }
  const out: MediaExifInput = {
    cameraMake: cleanExifString(raw.Make),
    cameraModel: cleanExifString(raw.Model),
    lensModel: cleanExifString(raw.LensModel),
    fNumber: finite(raw.FNumber),
    exposureS: finite(raw.ExposureTime),
    iso: integer(raw.ISO),
    focalMm: finite(raw.FocalLength),
    orientation: orientation !== null && orientation >= 1 && orientation <= 8 ? orientation : null,
    gpsLat: latLon ? gpsLat : null,
    gpsLon: latLon ? gpsLon : null,
    tzOffsetMin: parseTzOffset(raw.OffsetTimeOriginal),
    rawJson,
  };
  const useful = Object.entries(out).some(([k, v]) => k !== 'rawJson' && v !== null);
  return useful || Object.keys(rawSubset).length > 0 ? out : null;
}

export interface PhotoAnalysis {
  format: PhotoFormat;
  mime: string;
  /** Dimensiones de visualización (orientación EXIF aplicada; de un GIF, un fotograma). */
  width: number;
  height: number;
  exif: MediaExifInput | null;
  captured: CapturedAt;
}

/**
 * Paso 0 (y los metadatos del 4) de una foto: firma, dimensiones con sharp (sin decodificar),
 * límite de 268 MP, EXIF saneado y fecha de captura. UNSUPPORTED_FORMAT si no es una foto
 * admitida o sharp no la reconoce; TOO_LARGE por encima del límite de píxeles.
 */
export async function analyzePhoto(buffer: Buffer, mtimeNs: bigint): Promise<PhotoAnalysis> {
  if (buffer.length > PHOTO_MAX_BYTES) throw new AppErrorException({ code: 'TOO_LARGE' });
  const sniffed = sniffBuffer(buffer);
  if (sniffed.kind !== 'photo') throw new AppErrorException({ code: 'UNSUPPORTED_FORMAT' });
  const sharp = await getSharp();
  let meta;
  try {
    meta = await sharp(buffer, {
      sequentialRead: true,
      limitInputPixels: MAX_INPUT_PIXELS,
    }).metadata();
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    throw new AppErrorException({
      code: /pixel limit/i.test(message) ? 'TOO_LARGE' : 'UNSUPPORTED_FORMAT',
    });
  }
  const w = meta.width;
  const h = meta.pageHeight ?? meta.height;
  if (!w || !h) throw new AppErrorException({ code: 'UNSUPPORTED_FORMAT' });
  if (w * h > MAX_INPUT_PIXELS) throw new AppErrorException({ code: 'TOO_LARGE' });
  const rawExif = await parsePhotoExif(buffer);
  const exif = sanitizeExif(rawExif);
  const orientation = meta.orientation ?? exif?.orientation ?? 1;
  const swap = orientation >= 5 && orientation <= 8;
  return {
    format: sniffed.format,
    mime: sniffed.mime,
    width: swap ? h : w,
    height: swap ? w : h,
    exif,
    captured: photoCapturedAt(
      rawExif as { DateTimeOriginal?: unknown; CreateDate?: unknown } | null,
      mtimeNs,
    ),
  };
}
