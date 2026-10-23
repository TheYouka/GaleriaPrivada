// Foto de avatar (docs/DESIGN.md §14.4 y §10.3): formatos, límites, enlaces y sin metadatos.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AVATAR_MAX_BYTES } from '../../../src/shared/constants';
import {
  AvatarTokens,
  avatarFilePath,
  pickAvatarPhoto,
  processAvatarPhoto,
  removeAvatar,
  writeAvatar,
  type ShowOpenDialog,
} from '../../../src/main/profiles/avatars';
import { getSharp, type Sharp } from '../../../src/main/media/sharp-loader';
import { appErrorOf } from '../helpers/crypto';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const tmp = makeTmpDir('avatars');
afterAll(() => removeTmpDir(tmp));

let sharp: Sharp;
const MARKER = `MARCADOR-EXIF-${randomBytes(8).toString('hex')}`;

beforeAll(async () => {
  sharp = await getSharp();
});

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function save(name: string, bytes: Buffer): string {
  const path = join(mkdtempSync(join(tmp, 'f-')), name);
  writeFileSync(path, bytes);
  return path;
}

function base(width = 320, height = 200): ReturnType<Sharp> {
  return sharp({ create: { width, height, channels: 3, background: '#3366cc' } });
}

async function expectWebp256(path: string): Promise<void> {
  const before = sha256(path);
  const out = await processAvatarPhoto(path);
  const meta = await sharp(out).metadata();
  expect(meta.format).toBe('webp');
  expect([meta.width, meta.height]).toEqual([256, 256]);
  expect(meta.exif).toBeUndefined();
  expect(meta.icc).toBeUndefined();
  expect(meta.xmp).toBeUndefined();
  expect(out.includes(Buffer.from(MARKER))).toBe(false);
  expect(sha256(path)).toBe(before); // el archivo elegido no cambia
}

/** PNG con una cabecera IHDR de `w`×`h` y un IDAT mínimo (sharp lo rechaza al leer la cabecera). */
function hugePng(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // profundidad
  ihdr[9] = 0; // escala de grises
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(16))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** BMP de 24 bits de 2×2 escrito a mano (cabecera DIB de 40 bytes). */
function bmp24(): Buffer {
  const pixels = Buffer.alloc(16, 0x80); // 2 filas × (6 bytes + 2 de relleno)
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'latin1');
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(2, 18);
  header.writeInt32LE(2, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixels.length, 34);
  return Buffer.concat([header, pixels]);
}

function heic(): Buffer {
  const box = Buffer.alloc(24);
  box.writeUInt32BE(24, 0);
  box.write('ftypheic', 4, 'latin1');
  box.write('mif1heic', 16, 'latin1');
  return Buffer.concat([box, randomBytes(200)]);
}

function linkDir(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

function canSymlinkFiles(): boolean {
  const dir = mkdtempSync(join(tmp, 'probe-'));
  writeFileSync(join(dir, 'a'), 'a');
  try {
    symlinkSync(join(dir, 'a'), join(dir, 'b'), 'file');
    return true;
  } catch {
    return false;
  }
}

describe('processAvatarPhoto: formatos admitidos → WebP 256×256 sin metadatos', () => {
  it('JPEG con EXIF (y orientación)', async () => {
    const jpeg = await base()
      .withExif({ IFD0: { Copyright: MARKER, ImageDescription: MARKER } })
      .jpeg()
      .toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    expect(jpeg.includes(Buffer.from(MARKER))).toBe(true);
    await expectWebp256(save('foto.jpg', jpeg));
  });

  it('PNG', async () => {
    await expectWebp256(save('foto.png', await base().png().toBuffer()));
  });

  it('WebP', async () => {
    await expectWebp256(save('foto.webp', await base().webp().toBuffer()));
  });

  it('GIF animado: el primer fotograma', async () => {
    const frame = (color: string): Promise<Buffer> =>
      sharp({ create: { width: 64, height: 64, channels: 3, background: color } })
        .png()
        .toBuffer();
    const gif = await sharp([await frame('#ff0000'), await frame('#00ff00')], {
      join: { animated: true },
    })
      .gif()
      .toBuffer();
    expect((await sharp(gif).metadata()).pages).toBe(2);
    const path = save('anim.gif', gif);
    await expectWebp256(path);
    const out = await processAvatarPhoto(path);
    const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(200); // rojo: el primer fotograma
    expect(data[1]).toBeLessThan(60);
  });

  it('AVIF', async () => {
    await expectWebp256(save('foto.avif', await base().avif().toBuffer()));
  });
});

describe('processAvatarPhoto: rechazos', () => {
  it('BMP de 24 bits (a mano) y HEIC → UNSUPPORTED_FORMAT', async () => {
    for (const [name, bytes] of [
      ['foto.bmp', bmp24()],
      ['foto.heic', heic()],
      ['foto.jpg', randomBytes(512)], // la extensión no cuenta
    ] as const) {
      const path = save(name, bytes);
      const before = sha256(path);
      expect((await appErrorOf(() => processAvatarPhoto(path))).code).toBe('UNSUPPORTED_FORMAT');
      expect(sha256(path)).toBe(before);
    }
  });

  it('> 50 MiB → TOO_LARGE sin leer el contenido', async () => {
    const path = save('grande.jpg', Buffer.alloc(0));
    truncateSync(path, AVATAR_MAX_BYTES + 1); // ceros: si se leyera, la firma daría UNSUPPORTED_FORMAT
    expect((await appErrorOf(() => processAvatarPhoto(path))).code).toBe('TOO_LARGE');
  });

  it('> 268 MP → TOO_LARGE', async () => {
    const path = save('enorme.png', hugePng(20_000, 20_000));
    expect((await appErrorOf(() => processAvatarPhoto(path))).code).toBe('TOO_LARGE');
  });

  it('una imagen dañada con firma válida → UNSUPPORTED_FORMAT', async () => {
    const png = await base().png().toBuffer();
    const path = save('rota.png', Buffer.concat([png.subarray(0, 40), randomBytes(40)]));
    expect((await appErrorOf(() => processAvatarPhoto(path))).code).toBe('UNSUPPORTED_FORMAT');
  });

  it.skipIf(!canSymlinkFiles())('enlace simbólico a una foto → UNSUPPORTED_FORMAT', async () => {
    const target = save('real.png', await base().png().toBuffer());
    const link = join(mkdtempSync(join(tmp, 'l-')), 'enlace.png');
    symlinkSync(target, link, 'file');
    expect((await appErrorOf(() => processAvatarPhoto(link))).code).toBe('UNSUPPORTED_FORMAT');
  });

  it('junction/enlace de carpeta → UNSUPPORTED_FORMAT', async () => {
    const dir = mkdtempSync(join(tmp, 'j-'));
    linkDir(mkdtempSync(join(tmp, 't-')), join(dir, 'carpeta'));
    expect((await appErrorOf(() => processAvatarPhoto(join(dir, 'carpeta')))).code).toBe(
      'UNSUPPORTED_FORMAT',
    );
  });

  it('una carpeta o un archivo inexistente', async () => {
    expect((await appErrorOf(() => processAvatarPhoto(mkdtempSync(join(tmp, 'd-'))))).code).toBe(
      'UNSUPPORTED_FORMAT',
    );
    expect((await appErrorOf(() => processAvatarPhoto(join(tmp, 'no-existe.jpg')))).code).toBe(
      'IO',
    );
  });
});

describe('AvatarTokens', () => {
  it('token de 43 caracteres base64url, válido 10 min; take lo consume', () => {
    let now = 1_000_000;
    const tokens = new AvatarTokens(() => now);
    const webp = Buffer.from('webp');
    const token = tokens.issue(webp);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokens.peek(token)).toBe(webp);
    now += 10 * 60 * 1000 - 1;
    expect(tokens.peek(token)).toBe(webp);
    expect(tokens.take(token)).toBe(webp);
    expect(tokens.peek(token)).toBeNull();
    const second = tokens.issue(webp);
    now += 10 * 60 * 1000;
    expect(tokens.peek(second)).toBeNull();
    expect(tokens.peek('no es un token')).toBeNull();
  });
});

describe('pickAvatarPhoto y almacenamiento', () => {
  it('diálogo sin BMP ni HEIC y con dontAddToRecent; cancelar → null', async () => {
    const dialog = vi.fn<ShowOpenDialog>(async () => ({ canceled: true, filePaths: [] }));
    expect(await pickAvatarPhoto(dialog, new AvatarTokens())).toBeNull();
    const options = dialog.mock.calls[0]?.[0] as unknown as {
      properties: string[];
      filters: { extensions: string[] }[];
    };
    expect(options.properties).toEqual(['openFile', 'dontAddToRecent']);
    expect(options.filters[0]?.extensions.sort()).toEqual(
      ['avif', 'gif', 'jfif', 'jpeg', 'jpg', 'png', 'webp'].sort(),
    );
  });

  it('una foto elegida queda en memoria con su token; el archivo no cambia', async () => {
    const path = save('yo.png', await base().png().toBuffer());
    const before = sha256(path);
    const tokens = new AvatarTokens();
    const result = await pickAvatarPhoto(
      async () => ({ canceled: false, filePaths: [path] }),
      tokens,
    );
    expect(result?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const webp = tokens.peek(result?.token as string) as Buffer;
    expect((await sharp(webp).metadata()).width).toBe(256);
    expect(sha256(path)).toBe(before);
  });

  it('writeAvatar escribe avatars/<id>.webp de forma atómica y removeAvatar lo borra', async () => {
    const root = mkdtempSync(join(tmp, 'root-'));
    const id = randomBytes(16).toString('hex');
    await writeAvatar(root, id, Buffer.from('webp'));
    expect(readFileSync(avatarFilePath(root, id), 'utf8')).toBe('webp');
    await removeAvatar(root, id);
    await removeAvatar(root, id); // idempotente
    expect(() => readFileSync(avatarFilePath(root, id))).toThrow();
    expect(() => avatarFilePath(root, '../x')).toThrow(RangeError);
  });
});
