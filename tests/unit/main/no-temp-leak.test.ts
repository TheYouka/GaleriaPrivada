// no-temp-leak (docs/DESIGN.md §12.4 y §22, R16; PLAN.md 2.9): ninguna operación de sharp de la
// importación ni del avatar crea temporales. En un PROCESO HIJO con TMP, TEMP y TMPDIR apuntando a
// una carpeta vacía propia vigilada con fs.watch (con control positivo: un archivo de 1 MiB creado
// y borrado se ve): miniatura de un JPEG de 8000×6000 con orientación 6, de un PNG entrelazado de
// 16 bits de 6000×6000, de un GIF animado de 40 fotogramas de 2000×2000 y de un AVIF de 6000×4000,
// la misma imagen con ediciones (edits-render, F3: giro + volteo + recorte con el PNG intermedio en
// memoria, y sin ediciones), y una foto de avatar. La carpeta sigue vacía y el vigilante no ve
// ninguna entrada.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSharp } from '../../../src/main/media/sharp-loader';
import { makeTmpDir, removeTmpDir, TMP_ROOT } from '../helpers/tmp';
import type { ChildReport } from './no-temp-leak.child';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
/** Imágenes grandes generadas una vez (si ya existen, no se regeneran). */
const BIG_DIR = join(TMP_ROOT, 'no-temp-leak-fixtures', 'v2');
const run = promisify(execFile);

const BIG = {
  jpeg: join(BIG_DIR, 'jpeg-8000x6000-o6.jpg'),
  png: join(BIG_DIR, 'png16-entrelazado-6000x6000.png'),
  gif: join(BIG_DIR, 'gif-40x2000x2000.gif'),
  avif: join(BIG_DIR, 'avif-6000x4000.avif'),
};

async function generateBig(): Promise<void> {
  mkdirSync(BIG_DIR, { recursive: true });
  const sharp = await getSharp();
  const base = (width: number, height: number) =>
    sharp({
      create: { width, height, channels: 3, background: '#4a7a9c' },
      limitInputPixels: false,
    });
  if (!existsSync(BIG.jpeg)) {
    await base(8000, 6000).jpeg({ quality: 80 }).withMetadata({ orientation: 6 }).toFile(BIG.jpeg);
  }
  if (!existsSync(BIG.png)) {
    await base(6000, 6000)
      .toColourspace('rgb16')
      .png({ progressive: true, compressionLevel: 1 })
      .toFile(BIG.png);
  }
  if (!existsSync(BIG.gif)) {
    // 40 fotogramas distintos unidos como animación.
    const frames = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        sharp({
          create: {
            width: 2000,
            height: 2000,
            channels: 3,
            background: { r: (i * 6) % 256, g: 120, b: 255 - ((i * 6) % 256) },
          },
        })
          .png({ compressionLevel: 1 })
          .toBuffer(),
      ),
    );
    await sharp(frames, { join: { animated: true }, limitInputPixels: false })
      .gif({ effort: 1 })
      .toFile(BIG.gif);
  }
  if (!existsSync(BIG.avif)) {
    await base(6000, 4000).avif({ effort: 0, quality: 30 }).toFile(BIG.avif);
  }
}

describe('no-temp-leak (proceso hijo con TMP/TEMP/TMPDIR vigilados)', () => {
  const work = makeTmpDir('no-temp-leak');
  const outDir = join(work, 'bundle');
  const watchDir = join(work, 'temp-vigilado');

  beforeAll(async () => {
    await generateBig();
    await build({
      configFile: false,
      root: ROOT,
      logLevel: 'silent',
      resolve: { alias: { '@shared': join(ROOT, 'src', 'shared') } },
      build: {
        ssr: join(ROOT, 'tests', 'unit', 'main', 'no-temp-leak.child.ts'),
        outDir,
        emptyOutDir: true,
        minify: false,
        target: 'node22',
        rollupOptions: { output: { format: 'es', entryFileNames: 'child.mjs' } },
      },
    });
    mkdirSync(watchDir, { recursive: true });
  }, 600_000);
  afterAll(() => removeTmpDir(work));

  it('las imágenes grandes tienen las propiedades pedidas', async () => {
    const sharp = await getSharp();
    const meta = async (p: string) => sharp(p, { limitInputPixels: false }).metadata();
    expect(await meta(BIG.jpeg)).toMatchObject({ width: 8000, height: 6000, orientation: 6 });
    expect(await meta(BIG.png)).toMatchObject({
      width: 6000,
      height: 6000,
      depth: 'ushort',
      isProgressive: true,
    });
    expect(await meta(BIG.gif)).toMatchObject({ width: 2000, height: 2000, pages: 40 });
    expect(await meta(BIG.avif)).toMatchObject({ width: 6000, height: 4000, format: 'heif' });
  });

  it('miniaturas, edits-render y avatar: la carpeta temporal sigue vacía y el vigilante no ve nada', async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TMP: watchDir,
      TEMP: watchDir,
      TMPDIR: watchDir,
    };
    for (const k of Object.keys(env)) if (k.startsWith('VIPS_')) delete env[k];
    const config = {
      watchDir,
      images: [BIG.jpeg, BIG.png, BIG.gif, BIG.avif],
      avatar: BIG.jpeg,
    };
    const { stdout } = await run(
      process.execPath,
      [join(outDir, 'child.mjs'), JSON.stringify(config)],
      {
        cwd: ROOT,
        env,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 300_000,
      },
    );
    const report = JSON.parse(stdout) as ChildReport;
    expect(report.tmpdir).toBe(watchDir); // el hijo usa de verdad la carpeta vigilada
    expect(report.controlSeen).toBe(true); // control positivo
    expect(report.thumbBytes).toHaveLength(4);
    expect(report.thumbBytes.every((n) => n > 0)).toBe(true);
    // edits-render: 3 estados (dos con las dos pasadas del plan B y la identidad) por imagen.
    expect(report.editBytes).toHaveLength(4 * 3);
    expect(report.editBytes.every((n) => n > 0)).toBe(true);
    expect(report.avatarBytes).toBeGreaterThan(0);
    expect(report.seen).toEqual([]);
    expect(report.entries).toEqual([]);
    expect(readdirSync(watchDir)).toEqual([]);
  }, 300_000);
});
