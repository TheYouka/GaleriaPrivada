// [H3-3] import:paths usa la ruta EXACTA recibida (rawPath(): sin NFC ni trim) y path-guard
// (docs/DESIGN.md §12.2–§12.3; PLAN.md 2.9). Protección contra pérdida de datos: se importa y se
// borra solo el archivo soltado, nunca su variante normalizada, y nada dentro de GaleriaData.
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { listMedia } from '../../../src/main/db/repos/media-repo';
import { importHandlers } from '../../../src/main/ipc/handlers/import';
import { SCHEMAS } from '../../../src/main/ipc/schemas';
import { getSharp } from '../../../src/main/media/sharp-loader';
import { ensureFixtures, fixturePath, type FixtureManifest } from '../helpers/fixtures';
import { importHarness, sha256File, vaultFiles, type ImportHarness } from '../helpers/import';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }));
vi.mock('../../../src/main/window', () => ({
  getMainWindow: () => null,
  getRendererOrigin: () => 'app://bundle',
}));

// Cifrado y E/S reales: margen de sobra con la CPU cargada (PLAN.md, nota 112).
vi.setConfig({ testTimeout: 30_000 });

const win32 = process.platform === 'win32';
const tmp = makeTmpDir('import-paths');
let manifest: FixtureManifest;
const open: ImportHarness[] = [];

beforeAll(() => {
  manifest = ensureFixtures();
}, 900_000);
afterEach(async () => {
  for (const h of open.splice(0)) await h.dispose();
});
afterAll(() => removeTmpDir(tmp));

async function harness(): Promise<ImportHarness> {
  const h = await importHarness(tmp);
  open.push(h);
  return h;
}

/** El camino de un arrastre en main: esquema de import:paths (rawPath) → handler → informe. */
async function drop(h: ImportHarness, paths: string[]) {
  const req = SCHEMAS['import:paths'].parse({ paths });
  expect(req.paths).toEqual(paths); // tal cual: ni NFC ni trim
  const handlers = importHandlers({
    service: h.service,
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  });
  const { jobId } = handlers.paths(req);
  // El informe llega por import:done.
  await vi.waitFor(() => expect(h.events.done.some((r) => r.jobId === jobId)).toBe(true), {
    timeout: 30_000,
  });
  return h.events.done.find((r) => r.jobId === jobId);
}

function copy(key: string, to: string): string {
  copyFileSync(fixturePath(manifest, key) as string, to);
  return to;
}

describe('[H3-3] NFD y NFC conviven: solo se toca el soltado', () => {
  it.each(['NFD', 'NFC'] as const)(
    'soltar solo el %s',
    async (which) => {
      const h = await harness();
      const dir = join(h.src, 'mezcla');
      mkdirSync(dir);
      const nfd = copy('jpeg', join(dir, 'a\u0301.jpg'));
      const nfc = copy('png', join(dir, '\u00e1.jpg'));
      // NTFS y ext4 no normalizan: son dos archivos distintos.
      expect(readdirSync(dir)).toHaveLength(2);
      const dropped = which === 'NFD' ? nfd : nfc;
      const kept = which === 'NFD' ? nfc : nfd;
      const keptSha = sha256File(kept);
      const report = await drop(h, [dropped]);
      expect(report).toMatchObject({ imported: 1, failed: [], skipped: 0 });
      expect(existsSync(dropped)).toBe(false);
      expect(existsSync(kept)).toBe(true);
      expect(sha256File(kept)).toBe(keptSha);
      // El nombre visible sí se normaliza a NFC (§12.4.1); la ruta, nunca.
      const [item] = listMedia(h.db(), { kind: 'all', sort: { field: 'name', dir: 'asc' } });
      expect(item?.name).toBe('\u00e1');
    },
    30_000,
  );
});

describe('[H3-3] espacio final', () => {
  it.skipIf(win32)(
    '"foto.jpg " junto a "foto.jpg": solo se toca el soltado',
    async () => {
      const h = await harness();
      const spaced = copy('jpeg', join(h.src, 'foto.jpg '));
      const plain = copy('png', join(h.src, 'foto.jpg'));
      const plainSha = sha256File(plain);
      const report = await drop(h, [spaced]);
      expect(report).toMatchObject({ imported: 1, failed: [] });
      expect(existsSync(spaced)).toBe(false);
      expect(sha256File(plain)).toBe(plainSha);
    },
    30_000,
  );

  it.runIf(win32)(
    'Windows: "foto.jpg " (Win32 abriría "foto.jpg") se omite y "foto.jpg" no se toca',
    async () => {
      const h = await harness();
      const plain = copy('jpeg', join(h.src, 'foto.jpg'));
      const sha = sha256File(plain);
      const report = await drop(h, [`${plain} `]);
      expect(report).toMatchObject({ imported: 0, skipped: 1, failed: [] });
      expect(sha256File(plain)).toBe(sha);
      expect(vaultFiles(h.vaultDir).objects).toEqual([]);
    },
    30_000,
  );
});

describe('[H3-3] GaleriaData y bóvedas protegidas', () => {
  async function avatar(h: ImportHarness): Promise<string> {
    const sharp = await getSharp();
    const webp = await sharp({
      create: { width: 256, height: 256, channels: 3, background: '#336699' },
    })
      .webp()
      .toBuffer();
    const dir = join(h.root, 'avatars');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${h.profileId}.webp`);
    writeFileSync(path, webp);
    return path;
  }

  it('el avatar dentro de GaleriaData → skipped y no se borra; la misma foto fuera sí se importa', async () => {
    const h = await harness();
    const path = await avatar(h);
    const sha = sha256File(path);
    expect(await drop(h, [path])).toMatchObject({ imported: 0, skipped: 1, failed: [] });
    expect(sha256File(path)).toBe(sha);
    // Control: fuera de GaleriaData, el mismo contenido se importa (y se borra).
    const outside = join(h.src, 'avatar.webp');
    copyFileSync(path, outside);
    expect(await drop(h, [outside])).toMatchObject({ imported: 1 });
    expect(existsSync(outside)).toBe(false);
    expect(sha256File(path)).toBe(sha);
  }, 30_000);

  it.runIf(win32)(
    'Windows: GaleriaData\\avatars\\<id>.webp con otras mayúsculas → skipped y el avatar no se borra',
    async () => {
      const h = await harness();
      const path = await avatar(h);
      const sha = sha256File(path);
      const other = path
        .replace(/GaleriaData/, 'gALERIAdATA')
        .replace(/avatars/, 'AVATARS')
        .replace(h.profileId, h.profileId.toUpperCase())
        .replace(/\.webp$/, '.WEBP');
      expect(other).not.toBe(path);
      expect(existsSync(other)).toBe(true); // NTFS no distingue mayúsculas: es el mismo archivo
      expect(await drop(h, [other])).toMatchObject({ imported: 0, skipped: 1, failed: [] });
      expect(sha256File(path)).toBe(sha);
    },
    30_000,
  );

  it('soltar la carpeta de la bóveda o GaleriaData entera → todo skipped, nada se toca', async () => {
    const h = await harness();
    const path = await avatar(h);
    const sha = sha256File(path);
    const before = vaultFiles(h.vaultDir);
    expect(await drop(h, [h.root, h.vaultDir])).toMatchObject({ imported: 0, skipped: 2 });
    expect(sha256File(path)).toBe(sha);
    expect(vaultFiles(h.vaultDir)).toEqual(before);
  }, 30_000);
});
