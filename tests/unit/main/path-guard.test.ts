// path-guard.ts (P8, [H3-3], docs/DESIGN.md §12.3 punto 2): protección contra pérdida de datos.
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  comparable,
  isDevicePath,
  isInsideProtectedRoot,
  isWithin,
  resolveProtectedRoots,
} from '../../../src/main/import/path-guard';
import { rawPath } from '../../../src/main/ipc/schemas';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const tmp = makeTmpDir('path-guard');
afterAll(() => removeTmpDir(tmp));

const data = join(tmp, 'GaleriaData');
const vault = join(tmp, 'Bovedas', 'mi-boveda');
const sibling = join(tmp, 'GaleriaData2');
const outside = join(tmp, 'Descargas');
for (const d of [join(data, 'avatars'), vault, sibling, outside]) mkdirSync(d, { recursive: true });
writeFileSync(join(data, 'avatars', 'perfil.webp'), 'avatar');
writeFileSync(join(vault, 'vault.json'), '{}');
writeFileSync(join(sibling, 'foto.jpg'), 'x');
writeFileSync(join(outside, 'foto.jpg'), 'x');

const rootsPromise = resolveProtectedRoots([data, vault]);

describe('isInsideProtectedRoot (sistema de archivos real)', () => {
  it('dentro de GaleriaData y de la bóveda → inside; fuera → outside', async () => {
    const roots = await rootsPromise;
    expect(await isInsideProtectedRoot(join(data, 'avatars', 'perfil.webp'), roots)).toBe('inside');
    expect(await isInsideProtectedRoot(data, roots)).toBe('inside');
    expect(await isInsideProtectedRoot(join(vault, 'vault.json'), roots)).toBe('inside');
    expect(await isInsideProtectedRoot(join(outside, 'foto.jpg'), roots)).toBe('outside');
  });

  it('GaleriaData2 junto a GaleriaData no queda dentro (segmentos, no prefijos)', async () => {
    const roots = await rootsPromise;
    expect(await isInsideProtectedRoot(join(sibling, 'foto.jpg'), roots)).toBe('outside');
  });

  it.skipIf(process.platform !== 'win32')(
    'win32: una ruta dentro de GaleriaData con otras mayúsculas queda dentro',
    async () => {
      const roots = await rootsPromise;
      const upper = join(tmp, 'GALERIADATA', 'AVATARS', 'PERFIL.WEBP');
      expect(await isInsideProtectedRoot(upper, roots)).toBe('inside');
      expect(await isInsideProtectedRoot(join(tmp, 'galeriadata'), roots)).toBe('inside');
    },
  );

  it('un enlace (junction) hacia la bóveda se resuelve con realpath y queda dentro', async () => {
    const roots = await rootsPromise;
    const link = join(outside, 'acceso-directo');
    symlinkSync(vault, link, 'junction');
    expect(await isInsideProtectedRoot(join(link, 'vault.json'), roots)).toBe('inside');
  });

  it('realpath que falla → unresolved (el candidato es skipped)', async () => {
    const roots = await rootsPromise;
    expect(await isInsideProtectedRoot(join(outside, 'no-existe.jpg'), roots)).toBe('unresolved');
  });

  it('una raíz cuyo disco no está se protege igualmente por su ruta', async () => {
    const missing = join(tmp, 'disco-desconectado', 'boveda');
    const roots = await resolveProtectedRoots([missing]);
    expect(roots).toContain(comparable(missing));
  });
});

describe('reglas puras', () => {
  it('win32: minúsculas tras path.win32.normalize, sin el prefijo \\\\?\\', async () => {
    const roots = await resolveProtectedRoots(['C:\\Users\\Ana\\GaleriaData'], {
      platform: 'win32',
      realpath: async (p) => p,
    });
    const verdict = (p: string, real = p): Promise<string> =>
      isInsideProtectedRoot(p, roots, { platform: 'win32', realpath: async () => real });
    expect(await verdict('C:\\USERS\\ana\\galeriadata\\avatars\\x.webp')).toBe('inside');
    expect(await verdict('c:/users/ana/GaleriaData/vaults/../avatars/x.webp')).toBe('inside');
    expect(await verdict('x', '\\\\?\\C:\\Users\\Ana\\GaleriaData\\x')).toBe('inside');
    expect(await verdict('C:\\Users\\Ana\\GaleriaData2\\x.jpg')).toBe('outside');
    expect(await verdict('D:\\Users\\Ana\\GaleriaData\\x.jpg')).toBe('outside');
  });

  it('posix: distingue mayúsculas', async () => {
    const roots = await resolveProtectedRoots(['/home/ana/GaleriaData'], {
      platform: 'linux',
      realpath: async (p) => p,
    });
    const verdict = (p: string): Promise<string> =>
      isInsideProtectedRoot(p, roots, { platform: 'linux', realpath: async (x) => x });
    expect(await verdict('/home/ana/GaleriaData/a.jpg')).toBe('inside');
    expect(await verdict('/home/ana/galeriadata/a.jpg')).toBe('outside');
    expect(await verdict('/home/ana/GaleriaData2/a.jpg')).toBe('outside');
  });

  it('un hijo llamado "..algo" está dentro; ".." sale fuera', () => {
    expect(isWithin('/r', '/r/..oculto/x', 'linux')).toBe(true);
    expect(isWithin('/r', '/r', 'linux')).toBe(true);
    expect(isWithin('/r', '/r/../x', 'linux')).toBe(false);
    expect(isWithin('/r', '/', 'linux')).toBe(false);
    expect(isWithin('c:\\r', 'c:\\r\\..x\\y', 'win32')).toBe(true);
  });

  it('rutas de dispositivo rechazadas (\\\\.\\ y \\\\?\\GLOBALROOT)', async () => {
    expect(isDevicePath('\\\\.\\PhysicalDrive0')).toBe(true);
    expect(isDevicePath('//./C:')).toBe(true);
    expect(isDevicePath('\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\x')).toBe(true);
    expect(isDevicePath('\\\\?\\globalroot')).toBe(true);
    expect(isDevicePath('\\\\?\\C:\\largo\\x.jpg')).toBe(false);
    expect(isDevicePath('C:\\x.jpg')).toBe(false);
    const opts = { platform: 'win32' as const, realpath: async (p: string) => p };
    expect(await isInsideProtectedRoot('\\\\.\\C:\\x.jpg', [], opts)).toBe('device');
    expect(
      await isInsideProtectedRoot('C:\\x.jpg', [], {
        platform: 'win32',
        realpath: async () => '\\\\?\\GLOBALROOT\\Device\\X\\x.jpg',
      }),
    ).toBe('device');
  });
});

describe('rawPath() conserva la ruta tal cual [H3-3]', () => {
  const base = process.platform === 'win32' ? 'C:\\Fotos\\' : '/home/ana/Fotos/';
  it('NFD y espacios finales sin normalizar ni recortar', () => {
    const schema = rawPath();
    for (const p of [`${base}a\u0301.jpg`, `${base}foto.jpg `, `${base} espacio inicial.jpg`]) {
      expect(schema.parse(p)).toBe(p);
    }
    expect(schema.parse(`${base}a\u0301.jpg`)).not.toBe(`${base}á.jpg`);
  });
});
