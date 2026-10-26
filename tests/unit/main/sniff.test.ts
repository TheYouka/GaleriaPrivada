// sniff.ts completo (docs/DESIGN.md §12.3, PLAN.md 2.4): filas de vídeo, RAW y [H3-11] CR3.
// Las firmas de foto las cubre además sniff-photo.test.ts (F1). Cabeceras escritas a mano; si
// existen los fixtures generados (2.8), también se comprueban sus primeros bytes.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detectedExtOf,
  dispositionOf,
  isMainVideoStream,
  sniffBuffer,
  type SniffResult,
} from '../../../src/main/import/sniff';

function ftyp(major: string, compatible: string[] = [major]): Buffer {
  const head = Buffer.alloc(16);
  head.writeUInt32BE(16 + 4 * compatible.length, 0);
  head.write('ftyp', 4, 'latin1');
  head.write(major, 8, 'latin1');
  return Buffer.concat([head, ...compatible.map((c) => Buffer.from(c, 'latin1')), Buffer.alloc(8)]);
}

/** Cabecera EBML con varios hijos y el DocType dado. */
function ebml(docType: string): Buffer {
  const child = (id: number[], value: Buffer): Buffer =>
    Buffer.concat([Buffer.from(id), Buffer.from([0x80 | value.length]), value]);
  const body = Buffer.concat([
    child([0x42, 0x86], Buffer.from([1])), // EBMLVersion
    child([0x42, 0xf7], Buffer.from([1])), // EBMLReadVersion
    child([0x42, 0xf2], Buffer.from([4])),
    child([0x42, 0xf3], Buffer.from([8])),
    child([0x42, 0x82], Buffer.from(docType, 'latin1')), // DocType
    child([0x42, 0x87], Buffer.from([4])),
  ]);
  return Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80 | body.length]),
    body,
    Buffer.from([0x18, 0x53, 0x80, 0x67]), // Segment
  ]);
}

function riff(form: string): Buffer {
  return Buffer.concat([
    Buffer.from('RIFF', 'latin1'),
    Buffer.from([0x10, 0, 0, 0]),
    Buffer.from(form, 'latin1'),
    Buffer.alloc(16),
  ]);
}

const tiff = (le: boolean, extra = ''): Buffer =>
  Buffer.concat([
    Buffer.from(le ? [0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0] : [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]),
    Buffer.from(extra, 'latin1'),
    Buffer.alloc(32),
  ]);

const rejectedRaw: SniffResult = { kind: 'rejected', format: 'raw', code: 'UNSUPPORTED_FORMAT' };

describe('vídeo por firma', () => {
  it('MP4: ftyp con cualquier otro brand (isom, mp41, mp42, avc1, dash, iso5…)', () => {
    for (const brand of ['isom', 'mp41', 'mp42', 'avc1', 'dash', 'iso5', 'M4V ']) {
      expect(sniffBuffer(ftyp(brand))).toEqual({ kind: 'video', container: 'mp4', demuxer: 'mov' });
    }
  });

  it('MOV: ftyp con brand "qt  "', () => {
    expect(sniffBuffer(ftyp('qt  '))).toEqual({ kind: 'video', container: 'mov', demuxer: 'mov' });
  });

  it('WebM y MKV por DocType de la cabecera EBML', () => {
    expect(sniffBuffer(ebml('webm'))).toEqual({
      kind: 'video',
      container: 'webm',
      demuxer: 'matroska',
    });
    expect(sniffBuffer(ebml('matroska'))).toEqual({
      kind: 'video',
      container: 'mkv',
      demuxer: 'matroska',
    });
    expect(sniffBuffer(ebml('otro'))).toEqual({ kind: 'unknown' });
    expect(sniffBuffer(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))).toEqual({ kind: 'unknown' });
  });

  it('AVI: RIFF....AVI ', () => {
    expect(sniffBuffer(riff('AVI '))).toEqual({ kind: 'video', container: 'avi', demuxer: 'avi' });
    expect(sniffBuffer(riff('WAVE'))).toEqual({ kind: 'unknown' });
  });
});

describe('rechazos HEIC / RAW / BMP', () => {
  it('[H3-11] CR3: ftyp con brand "crx " → RAW rechazado (no MP4)', () => {
    expect(sniffBuffer(ftyp('crx ', ['crx ', 'isom']))).toEqual(rejectedRaw);
  });

  it('CR2, NEF, ARW y DNG (estructura TIFF) → RAW rechazado', () => {
    expect(sniffBuffer(tiff(true, 'CR\x02\x00'))).toEqual(rejectedRaw); // CR2
    expect(sniffBuffer(tiff(false))).toEqual(rejectedRaw); // NEF (big endian)
    expect(sniffBuffer(tiff(true))).toEqual(rejectedRaw); // ARW / DNG
  });

  it('ORF, RW2 y RAF → RAW rechazado', () => {
    for (const head of ['IIRO', 'IIRS', 'MMOR']) {
      expect(sniffBuffer(Buffer.from(`${head}\x08\x00\x00\x00`, 'latin1'))).toEqual(rejectedRaw);
    }
    expect(sniffBuffer(Buffer.from([0x49, 0x49, 0x55, 0x00, 0x18, 0, 0, 0]))).toEqual(rejectedRaw);
    expect(sniffBuffer(Buffer.from('FUJIFILMCCD-RAW 0201FF383501', 'latin1'))).toEqual(rejectedRaw);
  });

  it('HEIC sigue antes que MP4 y AVIF', () => {
    expect(sniffBuffer(ftyp('heic', ['mif1', 'heic']))).toMatchObject({ format: 'heic' });
    expect(sniffBuffer(ftyp('avif', ['avif', 'mif1']))).toMatchObject({ format: 'avif' });
  });
});

describe('detectedExtOf', () => {
  it('extensión canónica por formato', () => {
    expect(detectedExtOf(sniffBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0])))).toBe('jpg');
    expect(detectedExtOf(sniffBuffer(ftyp('isom')))).toBe('mp4');
    expect(detectedExtOf(sniffBuffer(ftyp('qt  ')))).toBe('mov');
    expect(detectedExtOf(sniffBuffer(ebml('webm')))).toBe('webm');
    expect(detectedExtOf(sniffBuffer(ebml('matroska')))).toBe('mkv');
    expect(detectedExtOf(sniffBuffer(riff('AVI ')))).toBe('avi');
    expect(detectedExtOf(rejectedRaw)).toBeNull();
  });
});

describe('dispositionOf (§12.3)', () => {
  const mp4 = sniffBuffer(ftyp('M4A ', ['M4A ', 'mp42', 'isom']));
  /** Salida simulada de ffprobe de un .m4a: solo audio. */
  const audioOnly = { streams: [{ codec_type: 'audio' }, { codec_type: 'data' }] };
  const withVideo = { streams: [{ codec_type: 'audio' }, { codec_type: 'video' }] };

  it('contenedor sin pista de vídeo = "cualquier otra": skipped en carpetas, fallo si explícito', () => {
    expect(mp4.kind).toBe('video');
    expect(dispositionOf(mp4, { explicit: false, probe: audioOnly })).toEqual({ action: 'skip' });
    expect(dispositionOf(mp4, { explicit: true, probe: audioOnly })).toEqual({
      action: 'fail',
      code: 'UNSUPPORTED_FORMAT',
    });
    expect(dispositionOf(mp4, { explicit: false, probe: { streams: [] } })).toEqual({
      action: 'skip',
    });
    expect(dispositionOf(mp4, { explicit: false, probe: withVideo })).toEqual({ action: 'import' });
  });

  it('una portada (attached_pic = 1) no es una pista de vídeo: .m4a con carátula = "cualquier otra"', () => {
    const cover = { codec_type: 'video', disposition: { attached_pic: 1 } };
    const audioWithCover = { streams: [{ codec_type: 'audio' }, cover] };
    expect(dispositionOf(mp4, { explicit: false, probe: audioWithCover })).toEqual({
      action: 'skip',
    });
    expect(dispositionOf(mp4, { explicit: true, probe: audioWithCover })).toEqual({
      action: 'fail',
      code: 'UNSUPPORTED_FORMAT',
    });
    const videoWithCover = {
      streams: [cover, { codec_type: 'video', disposition: { attached_pic: 0 } }],
    };
    expect(dispositionOf(mp4, { explicit: false, probe: videoWithCover })).toEqual({
      action: 'import',
    });
    expect(isMainVideoStream(cover)).toBe(false);
    expect(isMainVideoStream({ codec_type: 'video' })).toBe(true);
    expect(isMainVideoStream({ codec_type: 'audio' })).toBe(false);
  });

  it('rechazados cuentan como fallo también dentro de carpetas; desconocidos se omiten', () => {
    expect(dispositionOf(rejectedRaw, { explicit: false })).toEqual({
      action: 'fail',
      code: 'UNSUPPORTED_FORMAT',
    });
    const unknown = sniffBuffer(Buffer.from('texto', 'utf8'));
    expect(dispositionOf(unknown, { explicit: false })).toEqual({ action: 'skip' });
    expect(dispositionOf(unknown, { explicit: true })).toMatchObject({ action: 'fail' });
    expect(dispositionOf(sniffBuffer(ftyp('avif')), { explicit: false })).toEqual({
      action: 'import',
    });
  });
});

// ── Fixtures generados (2.8), si existen ────────────────────────────────────────────────────────

const MANIFEST = join(__dirname, '..', '..', '.tmp', 'fixtures', 'fixtures.json');
interface Manifest {
  files: Record<string, { first64Hex: string }>;
}
const manifest: Manifest | null = existsSync(MANIFEST)
  ? (JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest)
  : null;

describe.skipIf(!manifest)('primeros bytes de los fixtures generados', () => {
  const expected: Record<string, Partial<SniffResult>> = {
    jpeg: { kind: 'photo', format: 'jpeg' },
    png: { kind: 'photo', format: 'png' },
    webp: { kind: 'photo', format: 'webp' },
    gif: { kind: 'photo', format: 'gif' },
    avif: { kind: 'photo', format: 'avif' },
    bmp: { kind: 'rejected', format: 'bmp' },
    cr3: { kind: 'rejected', format: 'raw' },
    heic: { kind: 'rejected', format: 'heic' },
    mp4Vp9Opus: { kind: 'video', container: 'mp4' },
    webmVp9Opus: { kind: 'video', container: 'webm' },
    mkvVp9Opus: { kind: 'video', container: 'mkv' },
    mkvVp9Flac: { kind: 'video', container: 'mkv' },
    movMpeg4: { kind: 'video', container: 'mov' },
    aviMpeg4: { kind: 'video', container: 'avi' },
    mp4H264Aac: { kind: 'video', container: 'mp4' },
    mkvH264Aac: { kind: 'video', container: 'mkv' },
  };
  it.each(Object.entries(expected))('%s', (key, want) => {
    const file = manifest?.files[key];
    if (!file) return; // H.264 solo si había codificador
    expect(sniffBuffer(Buffer.from(file.first64Hex, 'hex'))).toMatchObject(want);
  });
});
