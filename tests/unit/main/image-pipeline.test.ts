// image-pipeline.ts (docs/DESIGN.md §12.4 pasos 0 y 4, §12.8). Las imágenes se sintetizan con
// sharp en memoria; nunca fotos reales.
import { randomBytes } from 'node:crypto';
import { appendFileSync, lstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  analyzePhoto,
  cleanExifString,
  parsePhotoExif,
  readPhotoOriginal,
  sanitizeExif,
} from '../../../src/main/import/image-pipeline';
import { snapshotOf } from '../../../src/main/import/walk';
import { getSharp } from '../../../src/main/media/sharp-loader';
import { PHOTO_MAX_BYTES } from '../../../src/shared/constants';
import { appErrorOf } from '../helpers/crypto';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const tmp = makeTmpDir('image-pipeline');
afterAll(() => removeTmpDir(tmp));

const MARKER = randomBytes(16).toString('hex').toUpperCase();
const MTIME_NS = BigInt(Date.UTC(2025, 5, 1, 10)) * 1_000_000n;
const photos: Record<string, Buffer> = {};

beforeAll(async () => {
  const sharp = await getSharp();
  const base = (w = 64, h = 48): ReturnType<typeof sharp> =>
    sharp({ create: { width: w, height: h, channels: 3, background: '#336699' } });
  photos.jpeg = await base(640, 480)
    .jpeg({ quality: 80 })
    .withMetadata({ orientation: 6 })
    .withExif({
      IFD0: { ImageDescription: MARKER, Make: 'Galeria\u0000', Model: 'Fixture' },
      IFD2: {
        DateTimeOriginal: '2024:05:17 10:30:00',
        OffsetTimeOriginal: '+02:00',
        UserComment: MARKER,
      },
    })
    .toBuffer();
  photos.png = await base().png().toBuffer();
  photos.webp = await base().webp().toBuffer();
  photos.gif = await base().gif().toBuffer();
  photos.avif = await base(40, 30).avif().toBuffer();
});

describe('analyzePhoto', () => {
  it('JPEG con orientación 6: ancho y alto intercambiados, fecha EXIF y EXIF saneado sin texto libre', async () => {
    const a = await analyzePhoto(photos.jpeg as Buffer, MTIME_NS);
    expect(a).toMatchObject({ format: 'jpeg', mime: 'image/jpeg', width: 480, height: 640 });
    expect(a.captured).toEqual({ capturedAt: Date.UTC(2024, 4, 17, 10, 30, 0), source: 'exif' });
    expect(a.exif).toMatchObject({
      cameraMake: 'Galeria',
      cameraModel: 'Fixture',
      orientation: 6,
      tzOffsetMin: 120,
    });
    // ImageDescription y UserComment (texto del usuario) no se copian.
    expect(a.exif?.rawJson).not.toContain(MARKER);
    expect(JSON.parse(a.exif?.rawJson ?? '{}')).toMatchObject({
      DateTimeOriginal: '2024:05:17 10:30:00',
      Make: 'Galeria',
    });
  });

  it.each(['png', 'webp', 'gif', 'avif'])('%s sin EXIF: fecha del mtime', async (format) => {
    const a = await analyzePhoto(photos[format] as Buffer, MTIME_NS);
    expect(a.format).toBe(format);
    expect(a.captured.source).toBe('file_mtime');
    expect(a.width).toBeGreaterThan(0);
  });

  it('no es una foto admitida → UNSUPPORTED_FORMAT; JPEG truncado → UNSUPPORTED_FORMAT', async () => {
    expect((await appErrorOf(() => analyzePhoto(Buffer.from('hola'), MTIME_NS))).code).toBe(
      'UNSUPPORTED_FORMAT',
    );
    const truncated = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
    expect((await appErrorOf(() => analyzePhoto(truncated, MTIME_NS))).code).toBe(
      'UNSUPPORTED_FORMAT',
    );
  });

  it('por encima de 268 MP (cabecera) → TOO_LARGE sin decodificar', async () => {
    // PNG escrito a mano cuyo IHDR declara 20000 × 20000 (400 MP) con una sola fila de píxeles.
    const chunk = (type: string, data: Buffer): Buffer => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(body));
      return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(20000, 0);
    ihdr.writeUInt32BE(20000, 4);
    ihdr[8] = 8; // profundidad
    ihdr[9] = 0; // gris
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.alloc(20001))), // una fila; el resto no existe
      chunk('IEND', Buffer.alloc(0)),
    ]);
    expect((await appErrorOf(() => analyzePhoto(png, MTIME_NS))).code).toBe('TOO_LARGE');
  });
});

describe('exifr con reviveValues: false', () => {
  it('las fechas llegan como texto', async () => {
    const raw = await parsePhotoExif(photos.jpeg as Buffer);
    expect(raw?.DateTimeOriginal).toBe('2024:05:17 10:30:00');
    expect(await parsePhotoExif(Buffer.from('no es una imagen'))).toBeNull();
  });
});

describe('sanitizeExif', () => {
  it('textos, números, GPS y límites', () => {
    const out = sanitizeExif({
      Make: '  Ma\u0000rca\n ',
      Model: 'x'.repeat(400),
      LensModel: 42,
      FNumber: Number.NaN,
      ExposureTime: 0.004,
      ISO: [200, 400],
      FocalLength: Infinity,
      Orientation: 9,
      latitude: 91,
      longitude: 10,
      OffsetTimeOriginal: '-03:00',
      ImageDescription: 'secreto',
    });
    expect(out).toMatchObject({
      cameraMake: 'Marca',
      lensModel: null,
      fNumber: null,
      exposureS: 0.004,
      iso: 200,
      focalMm: null,
      orientation: null,
      gpsLat: null,
      gpsLon: null,
      tzOffsetMin: -180,
    });
    expect([...(out?.cameraModel ?? '')]).toHaveLength(256);
    expect(out?.rawJson).not.toContain('secreto');
    expect(Buffer.byteLength(out?.rawJson ?? '')).toBeLessThanOrEqual(16 * 1024);
    expect(sanitizeExif({ latitude: 40.4, longitude: -3.7 })).toMatchObject({
      gpsLat: 40.4,
      gpsLon: -3.7,
    });
    expect(sanitizeExif(null)).toBeNull();
    expect(sanitizeExif({ ImageDescription: 'solo texto libre' })).toBeNull();
    expect(cleanExifString('😀'.repeat(300))).toHaveLength(512);
  });
});

describe('readPhotoOriginal', () => {
  it('lee por el descriptor comprobado; un original cambiado da "changed"', async () => {
    const p = join(tmp, 'foto.jpg');
    writeFileSync(p, photos.jpeg as Buffer);
    const snapshot = snapshotOf(lstatSync(p, { bigint: true }));
    const buf = await readPhotoOriginal(p, snapshot);
    expect(Buffer.isBuffer(buf) && buf.equals(photos.jpeg as Buffer)).toBe(true);
    appendFileSync(p, 'x');
    expect(await readPhotoOriginal(p, snapshot)).toBe('changed');
    expect(await readPhotoOriginal(join(tmp, 'no-existe.jpg'), snapshot)).toBe('changed');
  });

  it('más de 256 MiB según el snapshot → TOO_LARGE sin leer', async () => {
    const p = join(tmp, 'grande.jpg');
    writeFileSync(p, 'x');
    const snapshot = { ...snapshotOf(lstatSync(p, { bigint: true })) };
    snapshot.size = BigInt(PHOTO_MAX_BYTES) + 1n;
    expect((await appErrorOf(() => readPhotoOriginal(p, snapshot))).code).toBe('TOO_LARGE');
  });
});
