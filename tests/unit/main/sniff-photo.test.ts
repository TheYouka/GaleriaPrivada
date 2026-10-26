// Firmas de foto (docs/DESIGN.md §12.3, punto 3; P7). Las imágenes las genera sharp en memoria y
// las firmas de BMP y HEIC se escriben a mano: nunca se usan fotos reales.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appErrorOf } from '../helpers/crypto';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';
import { getSharp } from '../../../src/main/media/sharp-loader';
import { sniffBuffer, sniffFile } from '../../../src/main/import/sniff';

const tmp = makeTmpDir('sniff');
afterAll(() => removeTmpDir(tmp));

/** Caja ftyp: tamaño ‖ "ftyp" ‖ brand mayor ‖ minor_version ‖ compatible brands. */
function ftyp(major: string, compatible: string[], boxSize?: number): Buffer {
  const size = boxSize ?? 16 + 4 * compatible.length;
  const head = Buffer.alloc(16);
  head.writeUInt32BE(size, 0);
  head.write('ftyp', 4, 'latin1');
  head.write(major, 8, 'latin1');
  return Buffer.concat([
    head,
    ...compatible.map((c) => Buffer.from(c, 'latin1')),
    Buffer.alloc(32),
  ]);
}

/** BMP de 2×2 a 24 bits con BITMAPINFOHEADER (DIB de 40 bytes), escrito a mano. */
function bmp24(dibSize = 40): Buffer {
  const rowBytes = 8; // 2 píxeles × 3 B = 6, rellenado a múltiplo de 4
  const pixels = Buffer.alloc(rowBytes * 2, 0x7f);
  const fileHeader = Buffer.alloc(14);
  fileHeader.write('BM', 0, 'latin1');
  fileHeader.writeUInt32LE(14 + 40 + pixels.length, 2);
  fileHeader.writeUInt32LE(14 + 40, 10);
  const dib = Buffer.alloc(40);
  dib.writeUInt32LE(dibSize, 0);
  dib.writeInt32LE(2, 4); // ancho
  dib.writeInt32LE(2, 8); // alto
  dib.writeUInt16LE(1, 12); // planos
  dib.writeUInt16LE(24, 14); // bits por píxel
  dib.writeUInt32LE(0, 16); // BI_RGB
  dib.writeUInt32LE(pixels.length, 20);
  return Buffer.concat([fileHeader, dib, pixels]);
}

const generated: Record<string, Buffer> = {};

beforeAll(async () => {
  const sharp = await getSharp();
  const base = (): ReturnType<typeof sharp> =>
    sharp({ create: { width: 16, height: 16, channels: 3, background: '#336699' } });
  generated.jpeg = await base().jpeg().toBuffer();
  generated.png = await base().png().toBuffer();
  generated.webp = await base().webp().toBuffer();
  generated.gif = await base().gif().toBuffer();
  generated.avif = await base().avif().toBuffer();
});

describe('fotos admitidas (JPEG, PNG, WebP, GIF, AVIF)', () => {
  it.each([
    ['jpeg', 'image/jpeg'],
    ['png', 'image/png'],
    ['webp', 'image/webp'],
    ['gif', 'image/gif'],
    ['avif', 'image/avif'],
  ])('%s generado por sharp', (format, mime) => {
    expect(sniffBuffer(generated[format] as Buffer)).toEqual({ kind: 'photo', format, mime });
  });

  it('firmas mínimas escritas a mano', () => {
    expect(sniffBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).kind).toBe('photo');
    expect(sniffBuffer(Buffer.from('GIF87a\x01\x00', 'latin1'))).toMatchObject({ format: 'gif' });
    expect(sniffBuffer(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1'))).toMatchObject({
      format: 'webp',
    });
    expect(sniffBuffer(ftyp('avis', ['avis', 'msf1']))).toMatchObject({ format: 'avif' });
  });

  it('mif1/msf1/miaf + compatible avif o avis → AVIF', () => {
    expect(sniffBuffer(ftyp('mif1', ['mif1', 'avif']))).toMatchObject({
      kind: 'photo',
      format: 'avif',
    });
    expect(sniffBuffer(ftyp('msf1', ['msf1', 'avis']))).toMatchObject({
      kind: 'photo',
      format: 'avif',
    });
    expect(sniffBuffer(ftyp('miaf', ['miaf', 'avif', 'mif1']))).toMatchObject({ format: 'avif' });
  });
});

describe('rechazos', () => {
  it('BMP de 24 bits con cabecera DIB válida → UNSUPPORTED_FORMAT', () => {
    const rejected = { kind: 'rejected', format: 'bmp', code: 'UNSUPPORTED_FORMAT' };
    expect(sniffBuffer(bmp24())).toEqual(rejected);
    for (const size of [12, 52, 56, 64, 108, 124])
      expect(sniffBuffer(bmp24(size))).toEqual(rejected);
  });

  it('"BM" sin cabecera DIB válida no es un BMP', () => {
    expect(sniffBuffer(bmp24(41))).toEqual({ kind: 'unknown' });
    expect(sniffBuffer(Buffer.from('BMW es una marca de coches', 'latin1'))).toEqual({
      kind: 'unknown',
    });
  });

  it('HEIC: ftyp heic (y heix, heim, heis, hevc, hevx) → UNSUPPORTED_FORMAT', () => {
    for (const major of ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx']) {
      expect(sniffBuffer(ftyp(major, ['mif1', major]))).toEqual({
        kind: 'rejected',
        format: 'heic',
        code: 'UNSUPPORTED_FORMAT',
      });
    }
  });

  it('HEIC vía mif1 + heic → UNSUPPORTED_FORMAT', () => {
    expect(sniffBuffer(ftyp('mif1', ['mif1', 'heic']))).toMatchObject({
      kind: 'rejected',
      format: 'heic',
    });
    expect(sniffBuffer(ftyp('msf1', ['msf1', 'hevc']))).toMatchObject({
      kind: 'rejected',
      format: 'heic',
    });
  });

  it('mif1/msf1/miaf sin avif ni heic → UNSUPPORTED_FORMAT', () => {
    expect(sniffBuffer(ftyp('mif1', ['mif1', 'miaf']))).toEqual({
      kind: 'rejected',
      format: 'heif',
      code: 'UNSUPPORTED_FORMAT',
    });
  });
});

describe('límites de la lectura', () => {
  it('las compatible brands terminan donde termina la caja ftyp', () => {
    // La caja dice 16 bytes (sin compatible brands): el "avif" que sigue no cuenta.
    expect(sniffBuffer(ftyp('mif1', ['avif'], 16))).toMatchObject({
      kind: 'rejected',
      format: 'heif',
    });
  });

  it('solo se miran los 512 primeros bytes', () => {
    const big = Buffer.alloc(2000);
    big.writeUInt32BE(2000, 0);
    big.write('ftyp', 4, 'latin1');
    big.write('mif1', 8, 'latin1');
    big.write('avif', 600, 'latin1'); // más allá de 512
    expect(sniffBuffer(big)).toMatchObject({ kind: 'rejected', format: 'heif' });
    big.write('avif', 508, 'latin1'); // dentro
    expect(sniffBuffer(big)).toMatchObject({ kind: 'photo', format: 'avif' });
  });

  it('el resto (vacío, texto) es unknown; los vídeos los cubre sniff.test.ts (F2)', () => {
    expect(sniffBuffer(ftyp('isom', ['isom', 'mp41'])).kind).toBe('video');
    expect(sniffBuffer(ftyp('qt  ', ['qt  '])).kind).toBe('video');
    expect(sniffBuffer(Buffer.alloc(0))).toEqual({ kind: 'unknown' });
    expect(sniffBuffer(Buffer.from([0xff, 0xd8]))).toEqual({ kind: 'unknown' });
    expect(sniffBuffer(Buffer.from('hola, esto es texto', 'utf8'))).toEqual({ kind: 'unknown' });
    expect(sniffBuffer(Buffer.alloc(512))).toEqual({ kind: 'unknown' });
  });
});

describe('sniffFile', () => {
  it('decide la firma, no la extensión', async () => {
    const path = join(tmp, 'en-realidad-png.jpg');
    writeFileSync(path, Buffer.concat([generated.png as Buffer, Buffer.alloc(1024 * 1024)]));
    expect(await sniffFile(path)).toMatchObject({ kind: 'photo', format: 'png' });
    const bmpPath = join(tmp, 'foto.png');
    writeFileSync(bmpPath, bmp24());
    expect(await sniffFile(bmpPath)).toMatchObject({ kind: 'rejected', format: 'bmp' });
  });

  it('archivo inexistente → NOT_FOUND; archivo vacío → unknown', async () => {
    expect((await appErrorOf(() => sniffFile(join(tmp, 'no-existe.jpg')))).code).toBe('NOT_FOUND');
    const empty = join(tmp, 'vacio.jpg');
    writeFileSync(empty, Buffer.alloc(0));
    expect(await sniffFile(empty)).toEqual({ kind: 'unknown' });
  });
});
