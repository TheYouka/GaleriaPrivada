// Fecha de captura (docs/DESIGN.md §12.8). Puro.
//
// - Foto: DateTimeOriginal → CreateDate → mtime del archivo (`exif` o `file_mtime`).
// - Vídeo: format.tags.creation_time (UTC) en hora local naive (`container`) → mtime.
// - Fusión: la fecha actual (`generated`).
//
// Hora "naive": los componentes de la fecha de pared codificados con Date.UTC(...). Las fechas EXIF
// llegan como texto (exifr con reviveValues: false) y NUNCA pasan por un Date local, así una hora
// de pared que no existe en la zona de la máquina (el hueco del cambio de hora) no se desplaza. Los
// instantes reales (creation_time, mtime) se pasan a pared local con los getters locales.

export type CapturedAtSource = 'exif' | 'container' | 'file_mtime' | 'generated';

export interface CapturedAt {
  capturedAt: number;
  source: CapturedAtSource;
}

const EXIF_DATE = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;
const OFFSET = /^([+-])(\d{2}):(\d{2})$/;
/** ISO 8601 de ffprobe ("2026-10-25T00:30:00.000000Z"); sin zona se toma como UTC. */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/;

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysIn(y: number, m: number): number {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] as number;
}

function validParts(y: number, mo: number, d: number, h: number, mi: number, s: number): boolean {
  return (
    y >= 1900 &&
    y <= 2999 &&
    mo >= 1 &&
    mo <= 12 &&
    d >= 1 &&
    d <= daysIn(y, mo) &&
    h <= 23 &&
    mi <= 59 &&
    s <= 59
  );
}

/** "YYYY:MM:DD HH:MM:SS" → Date.UTC de los componentes; cualquier otro valor → null. */
export function parseExifDate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = EXIF_DATE.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (!validParts(y, mo, d, h, mi, s)) return null;
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

/** OffsetTimeOriginal ("+02:00") → minutos; no cambia captured_at. */
export function parseTzOffset(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = OFFSET.exec(value);
  if (!m) return null;
  const h = Number(m[2]);
  const mi = Number(m[3]);
  if (h > 14 || mi > 59) return null;
  return (m[1] === '-' ? -1 : 1) * (h * 60 + mi);
}

/** Instante real (ms desde la época) → componentes de pared locales codificados con Date.UTC. */
export function wallClockOf(instantMs: number): number {
  const d = new Date(instantMs);
  return Date.UTC(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds(),
  );
}

/** mtime en nanosegundos (bigint del snapshot) → pared local. */
export function wallClockOfMtime(mtimeNs: bigint): number {
  return wallClockOf(Number(mtimeNs / 1_000_000n));
}

/** creation_time ISO válido → instante en ms; si no, null. */
export function parseIsoInstant(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = ISO_INSTANT.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (!validParts(y, mo, d, h, mi, s)) return null;
  const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0;
  let offsetMin = 0;
  const zone = m[8];
  if (zone && zone !== 'Z') {
    const z = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
    if (!z) return null;
    offsetMin = (z[1] === '-' ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3]));
  }
  return Date.UTC(y, mo - 1, d, h, mi, s, ms) - offsetMin * 60_000;
}

/** Foto: DateTimeOriginal → CreateDate → mtime. */
export function photoCapturedAt(
  exif: { DateTimeOriginal?: unknown; CreateDate?: unknown } | null | undefined,
  mtimeNs: bigint,
): CapturedAt {
  const fromExif = parseExifDate(exif?.DateTimeOriginal) ?? parseExifDate(exif?.CreateDate);
  if (fromExif !== null) return { capturedAt: fromExif, source: 'exif' };
  return { capturedAt: wallClockOfMtime(mtimeNs), source: 'file_mtime' };
}

/** Vídeo: creation_time del contenedor (instante UTC) en pared local → mtime. */
export function videoCapturedAt(creationTime: unknown, mtimeNs: bigint): CapturedAt {
  const instant = parseIsoInstant(creationTime);
  if (instant !== null) return { capturedAt: wallClockOf(instant), source: 'container' };
  return { capturedAt: wallClockOfMtime(mtimeNs), source: 'file_mtime' };
}

/** Fusión (§18.6): la fecha actual. */
export function generatedCapturedAt(nowMs: number = Date.now()): CapturedAt {
  return { capturedAt: wallClockOf(nowMs), source: 'generated' };
}
