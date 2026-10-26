// Formato por firma de bytes (docs/DESIGN.md §12.3, punto 3): lee como mucho 512 bytes y la
// extensión no cuenta. P7: nació en F1 con las filas de foto (lo usa profiles/avatars.ts); F2 añade
// vídeo (MP4, MOV, WebM/MKV, AVI), RAW y CR3.
//
// En las firmas `ftyp`, el brand mayor está en los bytes 8–11 y las compatible brands van de 4 en 4
// desde el byte 16 hasta el final de la caja (uint32_be de los bytes 0–3, limitado a 512). Orden de
// las filas `ftyp`: HEIC y CR3 (rechazo, [H3-11]: brand `crx ` antes que la fila MP4), AVIF,
// `mif1`/`msf1`/`miaf`, MOV y, por último, MP4.
//
// RAW (PLAN.md, nota 93): ORF (`IIRO`/`IIRS`/`MMOR`), RW2 (`IIU\0`), RAF (`FUJIFILMCCD-RAW`) y los
// RAW con estructura TIFF (CR2, NEF, ARW, DNG). Estos últimos no se distinguen de un TIFF en 512
// bytes, así que todo archivo con cabecera TIFF (`II*\0` / `MM\0*`) se rechaza como RAW. TIFF no es
// un formato admitido, así que lo único que cambia es que dentro de una carpeta cuenta en `failed`.
import { open } from 'node:fs/promises';
import { AppErrorException } from '@shared/errors';
import {
  PHOTO_FORMATS,
  SNIFF_MAX_BYTES,
  VIDEO_CONTAINERS,
  type PhotoFormat,
  type VideoContainer,
} from '@shared/constants';

export type RejectedFormat = 'heic' | 'heif' | 'bmp' | 'raw';

export type SniffResult =
  | { kind: 'photo'; format: PhotoFormat; mime: string }
  /** El demuxer que se fuerza en ffprobe/ffmpeg sale de la firma (§12.4, paso 0). */
  | { kind: 'video'; container: VideoContainer; demuxer: 'mov' | 'matroska' | 'avi' }
  /** HEIC/HEIF, RAW (incluido CR3) y BMP: UNSUPPORTED_FORMAT, también dentro de carpetas. */
  | { kind: 'rejected'; format: RejectedFormat; code: 'UNSUPPORTED_FORMAT' }
  /** Cualquier otra firma: en carpetas se omite; elegido explícitamente, UNSUPPORTED_FORMAT. */
  | { kind: 'unknown' };

const HEIC_BRANDS: ReadonlySet<string> = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx']);
const AVIF_BRANDS: ReadonlySet<string> = new Set(['avif', 'avis']);
const HEIF_GENERIC_BRANDS: ReadonlySet<string> = new Set(['mif1', 'msf1', 'miaf']);
/** [H3-11] Canon CR3 (ISO BMFF con brand mayor `crx `). */
const CR3_BRAND = 'crx ';
const MOV_BRAND = 'qt  ';
/** Tamaños válidos de la cabecera DIB de un BMP (uint32_le del byte 14). */
const BMP_DIB_SIZES: ReadonlySet<number> = new Set([12, 40, 52, 56, 64, 108, 124]);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];
const EBML_DOCTYPE_ID = 0x4282;

function photo(format: PhotoFormat): SniffResult {
  return { kind: 'photo', format, mime: PHOTO_FORMATS[format].mime };
}

function video(container: VideoContainer): SniffResult {
  return { kind: 'video', container, demuxer: VIDEO_CONTAINERS[container].demuxer };
}

function rejected(format: RejectedFormat): SniffResult {
  return { kind: 'rejected', format, code: 'UNSUPPORTED_FORMAT' };
}

function ascii(b: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...b.subarray(start, end));
}

function startsWith(b: Uint8Array, bytes: readonly number[], at = 0): boolean {
  return b.length >= at + bytes.length && bytes.every((x, i) => b[at + i] === x);
}

function parseFtyp(b: Uint8Array): { major: string; compatible: string[] } | null {
  if (b.length < 12 || ascii(b, 4, 8) !== 'ftyp') return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const end = Math.min(view.getUint32(0), SNIFF_MAX_BYTES, b.length);
  const compatible: string[] = [];
  for (let off = 16; off + 4 <= end; off += 4) compatible.push(ascii(b, off, off + 4));
  return { major: ascii(b, 8, 12), compatible };
}

/** Entero de longitud variable de EBML (1–8 bytes). `keepMarker` para los IDs. */
function readVint(
  b: Uint8Array,
  off: number,
  keepMarker: boolean,
): { value: number; len: number } | null {
  const first = b[off];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (len <= 8 && (first & (0x80 >> (len - 1))) === 0) len += 1;
  if (len > 8 || off + len > b.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  for (let i = 1; i < len; i += 1) value = value * 256 + (b[off + i] as number);
  return { value, len };
}

/** DocType de la cabecera EBML (`webm`, `matroska`…), o null si no se encuentra en los 512 bytes. */
function ebmlDocType(b: Uint8Array): string | null {
  if (!startsWith(b, EBML_MAGIC)) return null;
  const size = readVint(b, 4, false);
  if (!size) return null;
  let off = 4 + size.len;
  const end = Math.min(b.length, off + size.value);
  while (off < end) {
    const id = readVint(b, off, true);
    if (!id) return null;
    const len = readVint(b, off + id.len, false);
    if (!len) return null;
    const start = off + id.len + len.len;
    if (id.value === EBML_DOCTYPE_ID) {
      if (start + len.value > b.length || len.value > 64) return null;
      return ascii(b, start, start + len.value).replace(/\0+$/, '');
    }
    off = start + len.value;
  }
  return null;
}

/** Cabeceras de RAW: TIFF (CR2/NEF/ARW/DNG), ORF, RW2 y RAF. */
function isRaw(b: Uint8Array): boolean {
  if (startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a])) {
    return true; // TIFF: CR2 ('CR' en el byte 8), NEF, ARW, DNG
  }
  if (b.length >= 4) {
    const head = ascii(b, 0, 4);
    if (head === 'IIRO' || head === 'IIRS' || head === 'MMOR') return true; // ORF
  }
  if (startsWith(b, [0x49, 0x49, 0x55, 0x00])) return true; // RW2
  return b.length >= 15 && ascii(b, 0, 15) === 'FUJIFILMCCD-RAW'; // RAF
}

/** Clasifica los primeros bytes de un archivo (solo se miran los 512 primeros). */
export function sniffBuffer(input: Uint8Array): SniffResult {
  const b = input.subarray(0, SNIFF_MAX_BYTES);
  if (startsWith(b, [0xff, 0xd8, 0xff])) return photo('jpeg');
  if (startsWith(b, PNG_SIGNATURE)) return photo('png');
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF') {
    const form = ascii(b, 8, 12);
    if (form === 'WEBP') return photo('webp');
    if (form === 'AVI ') return video('avi');
  }
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) {
    return photo('gif');
  }

  const ftyp = parseFtyp(b);
  if (ftyp) {
    if (HEIC_BRANDS.has(ftyp.major)) return rejected('heic');
    if (ftyp.major === CR3_BRAND) return rejected('raw'); // [H3-11], antes que la fila MP4
    if (AVIF_BRANDS.has(ftyp.major)) return photo('avif');
    if (HEIF_GENERIC_BRANDS.has(ftyp.major)) {
      if (ftyp.compatible.some((c) => AVIF_BRANDS.has(c))) return photo('avif');
      if (ftyp.compatible.some((c) => HEIC_BRANDS.has(c))) return rejected('heic');
      return rejected('heif');
    }
    if (ftyp.major === MOV_BRAND) return video('mov');
    return video('mp4');
  }

  const docType = ebmlDocType(b);
  if (docType === 'webm') return video('webm');
  if (docType === 'matroska') return video('mkv');
  if (startsWith(b, EBML_MAGIC)) return { kind: 'unknown' };

  if (isRaw(b)) return rejected('raw');

  if (b.length >= 18 && b[0] === 0x42 && b[1] === 0x4d) {
    const dib = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(14, true);
    if (BMP_DIB_SIZES.has(dib)) return rejected('bmp');
  }
  return { kind: 'unknown' };
}

/** Extensión canónica del formato detectado por firma (§12.4.1, punto 2). */
export function detectedExtOf(result: SniffResult): string | null {
  if (result.kind === 'photo') return result.format === 'jpeg' ? 'jpg' : result.format;
  if (result.kind === 'video') return result.container;
  return null;
}

/** Lo que hace la importación con un candidato (§12.3, punto 3 y el párrafo tras la tabla). */
export type Disposition =
  | { action: 'import' }
  /** Dentro de una carpeta, sin aviso. */
  | { action: 'skip' }
  | { action: 'fail'; code: 'UNSUPPORTED_FORMAT' };

/** Lo que importa aquí de cada pista de ffprobe. */
export interface ProbeStream {
  codec_type?: string | null | undefined;
  disposition?: { attached_pic?: number | null | undefined } | null | undefined;
}

/** Salida mínima de ffprobe que importa aquí: si hay alguna pista de vídeo. */
export interface ProbeStreams {
  streams: readonly ProbeStream[];
}

/**
 * Pista de vídeo de verdad: `codec_type = video` y no es una portada (`disposition.attached_pic
 * = 1`, p. ej. la carátula de un `.m4a`). Es lo que selecciona el especificador `V` de ffmpeg
 * (`-map 0:V:0`). PLAN.md, nota 104.
 */
export function isMainVideoStream(s: ProbeStream): boolean {
  return s.codec_type === 'video' && s.disposition?.attached_pic !== 1;
}

/**
 * §12.3: rechazados → `failed` (también dentro de carpetas); cualquier otra firma → `skipped`
 * dentro de carpetas y UNSUPPORTED_FORMAT si se eligió explícitamente. Un vídeo por firma cuyo
 * ffprobe no tiene ninguna pista de vídeo (un `.m4a`, aunque tenga portada) se trata como
 * "cualquier otra". Para un vídeo hay que pasar `probe` (el de `prescanVideo`); sin él no se puede
 * saber y devuelve `import`.
 */
export function dispositionOf(
  result: SniffResult,
  opts: { explicit: boolean; probe?: ProbeStreams },
): Disposition {
  const other = (): Disposition =>
    opts.explicit ? { action: 'fail', code: 'UNSUPPORTED_FORMAT' } : { action: 'skip' };
  switch (result.kind) {
    case 'photo':
      return { action: 'import' };
    case 'rejected':
      return { action: 'fail', code: 'UNSUPPORTED_FORMAT' };
    case 'unknown':
      return other();
    case 'video':
      if (opts.probe && !opts.probe.streams.some(isMainVideoStream)) return other();
      return { action: 'import' };
  }
}

/** Lee como mucho 512 bytes del archivo y lo clasifica. ENOENT → NOT_FOUND; otros → IO. */
export async function sniffFile(path: string): Promise<SniffResult> {
  let fh;
  try {
    fh = await open(path, 'r');
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    throw new AppErrorException({ code: code === 'ENOENT' ? 'NOT_FOUND' : 'IO' });
  }
  try {
    const head = Buffer.alloc(SNIFF_MAX_BYTES);
    let got = 0;
    while (got < head.length) {
      const { bytesRead } = await fh.read(head, got, head.length - got, got);
      if (bytesRead <= 0) break;
      got += bytesRead;
    }
    return sniffBuffer(head.subarray(0, got));
  } catch {
    throw new AppErrorException({ code: 'IO' });
  } finally {
    await fh.close().catch(() => undefined);
  }
}
