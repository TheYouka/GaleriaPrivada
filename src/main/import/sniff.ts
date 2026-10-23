// Formato por firma de bytes (docs/DESIGN.md §12.3, punto 3): lee como mucho 512 bytes y la
// extensión no cuenta. P7: nace en F1 con las filas de foto (lo usa profiles/avatars.ts); F2 añade
// vídeo (MP4, MOV, WebM/MKV, AVI), RAW y CR3.
//
// En las firmas `ftyp`, el brand mayor está en los bytes 8–11 y las compatible brands van de 4 en 4
// desde el byte 16 hasta el final de la caja (uint32_be de los bytes 0–3, limitado a 512). Orden de
// las filas `ftyp`: HEIC (rechazo), AVIF y `mif1`/`msf1`/`miaf`.
import { open } from 'node:fs/promises';
import { AppErrorException } from '@shared/errors';
import { PHOTO_FORMATS, SNIFF_MAX_BYTES, type PhotoFormat } from '@shared/constants';

export type SniffResult =
  | { kind: 'photo'; format: PhotoFormat; mime: string }
  /** HEIC/HEIF y BMP: UNSUPPORTED_FORMAT, también dentro de carpetas; el original no se toca. */
  | { kind: 'rejected'; format: 'heic' | 'heif' | 'bmp'; code: 'UNSUPPORTED_FORMAT' }
  /** Cualquier otra firma: en carpetas se omite; elegido explícitamente, UNSUPPORTED_FORMAT. */
  | { kind: 'unknown' };

const HEIC_BRANDS: ReadonlySet<string> = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx']);
const AVIF_BRANDS: ReadonlySet<string> = new Set(['avif', 'avis']);
const HEIF_GENERIC_BRANDS: ReadonlySet<string> = new Set(['mif1', 'msf1', 'miaf']);
/** Tamaños válidos de la cabecera DIB de un BMP (uint32_le del byte 14). */
const BMP_DIB_SIZES: ReadonlySet<number> = new Set([12, 40, 52, 56, 64, 108, 124]);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function photo(format: PhotoFormat): SniffResult {
  return { kind: 'photo', format, mime: PHOTO_FORMATS[format].mime };
}

function rejected(format: 'heic' | 'heif' | 'bmp'): SniffResult {
  return { kind: 'rejected', format, code: 'UNSUPPORTED_FORMAT' };
}

function ascii(b: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...b.subarray(start, end));
}

function startsWith(b: Uint8Array, bytes: readonly number[]): boolean {
  return b.length >= bytes.length && bytes.every((x, i) => b[i] === x);
}

function parseFtyp(b: Uint8Array): { major: string; compatible: string[] } | null {
  if (b.length < 12 || ascii(b, 4, 8) !== 'ftyp') return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const end = Math.min(view.getUint32(0), SNIFF_MAX_BYTES, b.length);
  const compatible: string[] = [];
  for (let off = 16; off + 4 <= end; off += 4) compatible.push(ascii(b, off, off + 4));
  return { major: ascii(b, 8, 12), compatible };
}

/** Clasifica los primeros bytes de un archivo (solo se miran los 512 primeros). */
export function sniffBuffer(input: Uint8Array): SniffResult {
  const b = input.subarray(0, SNIFF_MAX_BYTES);
  if (startsWith(b, [0xff, 0xd8, 0xff])) return photo('jpeg');
  if (startsWith(b, PNG_SIGNATURE)) return photo('png');
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP')
    return photo('webp');
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) {
    return photo('gif');
  }

  const ftyp = parseFtyp(b);
  if (ftyp) {
    if (HEIC_BRANDS.has(ftyp.major)) return rejected('heic');
    if (AVIF_BRANDS.has(ftyp.major)) return photo('avif');
    if (HEIF_GENERIC_BRANDS.has(ftyp.major)) {
      if (ftyp.compatible.some((c) => AVIF_BRANDS.has(c))) return photo('avif');
      if (ftyp.compatible.some((c) => HEIC_BRANDS.has(c))) return rejected('heic');
      return rejected('heif');
    }
    return { kind: 'unknown' }; // MOV/MP4 y el resto: F2
  }

  if (b.length >= 18 && b[0] === 0x42 && b[1] === 0x4d) {
    const dib = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(14, true);
    if (BMP_DIB_SIZES.has(dib)) return rejected('bmp');
  }
  return { kind: 'unknown' };
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
