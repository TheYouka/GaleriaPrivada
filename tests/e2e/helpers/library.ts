// Ayudantes de los E2E de la galería y la importación (docs/PLAN.md 2.13): fixtures generados,
// carpetas de origen propias de cada test, diálogos nativos simulados, importar por la interfaz y
// comprobar que nada de lo importado queda en claro bajo la raíz de datos (§22).
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import {
  createProfile,
  launchApp,
  ROOT,
  unlockProfile,
  type LaunchedApp,
  type LaunchOptions,
} from './launch';

export const PASSWORD = 'clave-de-prueba-1';
export const PROFILE = 'Ana';
export const FIXTURES_DIR = join(ROOT, 'tests', '.tmp', 'fixtures');
const SOURCES_DIR = join(ROOT, 'tests', '.tmp', 'e2e-src');

export interface FixtureFile {
  file: string;
  kind: 'photo' | 'video' | 'rejected';
  action?: 'as-is' | 'remux' | 'convert';
  seconds?: number;
  bytes: number;
  sha256: string;
  first64Hex: string;
}

export interface FixtureManifest {
  marker: string;
  ffmpeg: boolean;
  h264Encoder: string | null;
  videoSeconds: number;
  files: Record<string, FixtureFile>;
  slow?: { file: string; bytes: number };
}

export function loadFixtures(): FixtureManifest {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'fixtures.json'), 'utf8')) as FixtureManifest;
}

export function fixture(key: string): FixtureFile {
  const f = loadFixtures().files[key];
  if (!f) throw new Error(`fixture desconocido: ${key}`);
  return f;
}

/** Carpeta de origen propia del test (los originales que se importan; el import los borra). */
export function newSourceDir(): string {
  const dir = join(SOURCES_DIR, randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/** Copia un fixture a `dir` (con su nombre o con `as`) y devuelve la ruta de la copia. */
export function copyFixture(key: string, dir: string, as?: string): string {
  const dest = join(dir, as ?? fixture(key).file);
  copyFileSync(join(FIXTURES_DIR, fixture(key).file), dest);
  return dest;
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Lista recursiva de archivos (rutas absolutas). */
export function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Crea un perfil, lo desbloquea y devuelve la app con la galería vacía a la vista. */
export async function launchUnlocked(
  options: LaunchOptions = {},
  size?: { width: number; height: number },
): Promise<LaunchedApp> {
  const launched = await launchApp(options);
  if (size) {
    await launched.app.evaluate(({ BrowserWindow }, bounds) => {
      BrowserWindow.getAllWindows()[0]?.setBounds(bounds);
    }, size);
  }
  await createProfile(launched.page, PROFILE, PASSWORD);
  await unlockProfile(launched.page, PROFILE, PASSWORD);
  await expect(launched.page.getByRole('heading', { level: 1, name: 'Galería' })).toBeVisible();
  return launched;
}

/** Simula el diálogo nativo de abrir (archivos o carpeta) con estas rutas (PLAN.md 2.13). */
export async function mockOpenDialog(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths });
  }, paths);
}

export function importPanel(page: Page): Locator {
  return page.getByRole('region', { name: 'Importación' });
}

/** "Importar" → "Archivos…" o "Carpeta…" con el diálogo simulado devolviendo `paths`. */
export async function startImportFromMenu(
  page: Page,
  app: ElectronApplication,
  paths: string[],
  source: 'files' | 'folder' = 'files',
): Promise<void> {
  await mockOpenDialog(app, paths);
  await page.getByRole('button', { name: 'Importar', exact: true }).click();
  await page
    .getByRole('menuitem', { name: source === 'files' ? /^Archivos…/ : /^Carpeta…/ })
    .click();
}

export interface SummaryCounts {
  imported: number;
  duplicates: number;
  skipped: number;
  failed: number;
}

/** Espera el resumen de la importación y devuelve sus recuentos (el panel queda abierto). */
export async function waitForSummary(page: Page, timeout = 60_000): Promise<SummaryCounts> {
  const panel = importPanel(page);
  await expect(
    panel.getByRole('heading', { name: /^Importación (terminada|cancelada)$/ }),
  ).toBeVisible({ timeout });
  const count = async (label: string): Promise<number> =>
    Number(
      (
        await panel
          .getByText(label, { exact: true })
          .locator('xpath=following-sibling::dd[1]')
          .innerText()
      ).trim(),
    );
  return {
    imported: await count('Importados'),
    duplicates: await count('Duplicados (ya estaban en la bóveda)'),
    skipped: await count('Omitidos'),
    failed: await count('Fallidos'),
  };
}

export async function closeSummary(page: Page): Promise<void> {
  await importPanel(page).getByRole('button', { name: 'Cerrar' }).click();
  await expect(importPanel(page)).toBeHidden();
}

/** Importa por el menú, espera el resumen y lo cierra. */
export async function importAndSummarize(
  page: Page,
  app: ElectronApplication,
  paths: string[],
  source: 'files' | 'folder' = 'files',
  timeout = 60_000,
): Promise<SummaryCounts> {
  await startImportFromMenu(page, app, paths, source);
  const counts = await waitForSummary(page, timeout);
  await closeSummary(page);
  return counts;
}

export function gridCells(page: Page): Locator {
  return page.getByRole('grid', { name: 'Galería' }).getByRole('gridcell');
}

/** El recuento del encabezado de la galería ('8 elementos'): vale aunque la rejilla virtualice. */
export async function expectItemCount(page: Page, n: number): Promise<void> {
  await expect(
    page.getByText(n === 1 ? '1 elemento' : `${n} elementos`, { exact: true }),
  ).toBeVisible();
}

/** Nombres (aria-label sin el sufijo de vídeo) de las celdas montadas, en el orden del DOM. */
export async function cellNames(page: Page): Promise<string[]> {
  const labels = await gridCells(page).evaluateAll((els) =>
    els.map((el) => el.getAttribute('aria-label') ?? ''),
  );
  return labels.map((l) => l.replace(/, vídeo(, [\d:]+)?$/, ''));
}

export interface Needle {
  label: string;
  bytes: Buffer;
}

/** Marcador, primeros 64 bytes y nombre de cada fixture, en UTF-8 y UTF-16LE (el nombre). */
export function fixtureNeedles(keys: string[]): Needle[] {
  const m = loadFixtures();
  const needles: Needle[] = [
    { label: 'marcador utf8', bytes: Buffer.from(m.marker, 'utf8') },
    { label: 'marcador utf16le', bytes: Buffer.from(m.marker, 'utf16le') },
  ];
  for (const key of keys) {
    const f = fixture(key);
    needles.push({ label: `64 bytes de ${key}`, bytes: Buffer.from(f.first64Hex, 'hex') });
    needles.push({ label: `nombre de ${key} utf8`, bytes: Buffer.from(f.file, 'utf8') });
    needles.push({ label: `nombre de ${key} utf16le`, bytes: Buffer.from(f.file, 'utf16le') });
  }
  return needles;
}

/**
 * §22: busca las agujas en todos los archivos bajo `roots` (salvo `music/`, que va en claro por
 * diseño). Devuelve los archivos analizados y los aciertos.
 */
export function scanForNeedles(
  roots: string[],
  needles: Needle[],
  baseDir: string,
): { scanned: number; hits: string[]; files: string[] } {
  const hits: string[] = [];
  const scanned: string[] = [];
  for (const root of roots) {
    for (const file of filesUnder(root)) {
      const rel = relative(baseDir, file);
      if (rel.split(/[\\/]/).includes('music')) continue;
      const data = readFileSync(file);
      scanned.push(file);
      for (const n of needles) {
        if (data.includes(n.bytes)) hits.push(`${n.label} en ${rel}`);
      }
    }
  }
  return { scanned: scanned.length, hits, files: scanned };
}

/**
 * Vídeo sintético largo (VP9 + Opus en MP4 con `+faststart`, testsrc2 + sine) con el ffmpeg
 * empaquetado, para probar saltos de ±10 s y búsquedas (los fixtures de 4 s no dan para eso). Se
 * importa tal cual (§12.5) y solo existe en `tests/.tmp/`.
 */
export function writeLongVideo(path: string, seconds: number): void {
  const win = process.platform === 'win32';
  const dir = join(ROOT, 'resources', 'ffmpeg', win ? 'win-x64' : 'linux-x64');
  execFileSync(
    join(dir, 'bin', win ? 'ffmpeg.exe' : 'ffmpeg'),
    [
      ...['-hide_banner', '-nostdin', '-v', 'error', '-y'],
      ...['-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=15:duration=${seconds}`],
      ...['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`],
      ...['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '300k'],
      ...['-g', '15', '-c:a', 'libopus', '-b:a', '64k', '-movflags', '+faststart', '-f', 'mp4'],
      path,
    ],
    {
      env: win
        ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }
        : { LD_LIBRARY_PATH: join(dir, 'lib') },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 120_000,
    },
  );
}

/**
 * Pista de música sintética (tono de 440 Hz) con el ffmpeg empaquetado, para los E2E de música y de
 * la presentación (PLAN.md 4.2, 4.7). Nunca se usa música real; solo existe en `tests/.tmp/`.
 */
export function writeTone(path: string, seconds: number, format: 'wav' | 'mp3' = 'wav'): void {
  const win = process.platform === 'win32';
  const dir = join(ROOT, 'resources', 'ffmpeg', win ? 'win-x64' : 'linux-x64');
  const codec =
    format === 'mp3'
      ? ['-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3']
      : ['-c:a', 'pcm_s16le', '-f', 'wav'];
  execFileSync(
    join(dir, 'bin', win ? 'ffmpeg.exe' : 'ffmpeg'),
    [
      ...['-hide_banner', '-nostdin', '-v', 'error', '-y'],
      ...['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${seconds}`],
      ...codec,
      path,
    ],
    {
      env: win
        ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }
        : { LD_LIBRARY_PATH: join(dir, 'lib') },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 60_000,
    },
  );
}

/** Pista importada (forma de MusicTrack). */
export interface ImportedTrack {
  id: string;
  title: string;
  durationMs: number | null;
  sizeBytes: number;
}

/**
 * Importa música por el camino real de main (`music:import` con el diálogo nativo simulado) y
 * devuelve el resultado. La UI de Ajustes → Música (PLAYLISTS-UI) usa el mismo canal.
 */
export async function importMusic(
  app: ElectronApplication,
  page: Page,
  paths: string[],
): Promise<{ imported: ImportedTrack[]; failed: { name: string; code: string }[] }> {
  await mockOpenDialog(app, paths);
  const res = await page.evaluate(async () => {
    const api = (
      window as unknown as {
        galeria: { invoke(c: string): Promise<{ ok: boolean; data?: unknown; error?: unknown }> };
      }
    ).galeria;
    return api.invoke('music:import');
  });
  if (!res.ok) throw new Error(`music:import falló: ${JSON.stringify(res.error)}`);
  return res.data as { imported: ImportedTrack[]; failed: { name: string; code: string }[] };
}

/** Escribe un JPEG/PNG sintético y único (color de fondo distinto) con sharp, sin EXIF. */
export async function writePhoto(
  path: string,
  seed: number,
  options: { width?: number; height?: number; mtime?: Date; format?: 'jpeg' | 'png' } = {},
): Promise<void> {
  const sharp = (await import('sharp')).default;
  const width = options.width ?? 320 + (seed % 7) * 16;
  const height = options.height ?? 240 + (seed % 5) * 12;
  const r = (seed * 53) % 256;
  const g = (seed * 97 + 40) % 256;
  const b = (seed * 29 + 120) % 256;
  // Un degradado diagonal con el color de la semilla, para que las miniaturas no sean un color liso.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="rgb(${r},${g},${b})"/>
      <stop offset="1" stop-color="rgb(${255 - r},${255 - g},${(b + 90) % 256})"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${width * 0.7}" cy="${height * 0.35}" r="${Math.min(width, height) * 0.18}" fill="rgba(255,255,255,0.75)"/>
    <rect x="${width * 0.1}" y="${height * 0.62}" width="${width * 0.5}" height="${height * 0.2}" fill="rgba(0,0,0,0.35)"/>
  </svg>`;
  const image = sharp(Buffer.from(svg));
  const buffer =
    options.format === 'png'
      ? await image.png().toBuffer()
      : await image.jpeg({ quality: 80 + (seed % 15) }).toBuffer();
  writeFileSync(path, buffer);
  if (options.mtime) utimesSync(path, options.mtime, options.mtime);
}

/** Colores de los cuatro cuadrantes de `writeQuadrants`: rojo, verde, azul y amarillo. */
export const QUADRANT_COLORS = {
  red: [255, 0, 0],
  green: [0, 200, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
} as const;
export type QuadrantColor = keyof typeof QUADRANT_COLORS;

/**
 * PNG asimétrico de `width × height` con un color distinto en cada cuadrante (arriba a la izquierda
 * rojo, arriba a la derecha verde, abajo a la izquierda azul, abajo a la derecha amarillo): cualquier
 * giro, volteo o recorte cambia lo que se ve en cada punto. Sin EXIF.
 */
export async function writeQuadrants(
  path: string,
  options: { width?: number; height?: number; mtime?: Date } = {},
): Promise<void> {
  const sharp = (await import('sharp')).default;
  const width = options.width ?? 400;
  const height = options.height ?? 200;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color =
        y < height / 2
          ? x < width / 2
            ? QUADRANT_COLORS.red
            : QUADRANT_COLORS.green
          : x < width / 2
            ? QUADRANT_COLORS.blue
            : QUADRANT_COLORS.yellow;
      raw.set(color, (y * width + x) * 3);
    }
  }
  writeFileSync(
    path,
    await sharp(raw, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer(),
  );
  if (options.mtime) utimesSync(path, options.mtime, options.mtime);
}

/** El color de cuadrante más cercano a un píxel [r, g, b]. */
export function nearestQuadrant(rgb: readonly number[]): QuadrantColor {
  let best: QuadrantColor = 'red';
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [name, c] of Object.entries(QUADRANT_COLORS) as [QuadrantColor, readonly number[]][]) {
    const d = (rgb[0] - c[0]) ** 2 + (rgb[1] - c[1]) ** 2 + (rgb[2] - c[2]) ** 2;
    if (d < bestDistance) {
      best = name;
      bestDistance = d;
    }
  }
  return best;
}

/** Los colores de cuadrante en cuatro puntos (en fracciones del ancho y el alto) de una captura PNG. */
export async function quadrantsOfPng(
  png: Buffer,
  points: readonly (readonly [number, number])[],
): Promise<{ width: number; height: number; colors: QuadrantColor[] }> {
  const sharp = (await import('sharp')).default;
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const colors = points.map(([fx, fy]) => {
    const x = Math.min(info.width - 1, Math.max(0, Math.floor(fx * info.width)));
    const y = Math.min(info.height - 1, Math.max(0, Math.floor(fy * info.height)));
    const i = (y * info.width + x) * info.channels;
    return nearestQuadrant([data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0]);
  });
  return { width: info.width, height: info.height, colors };
}

/** Id del medio de una celda de la rejilla (`data-media-id`, un identificador aleatorio). */
export async function mediaIdOf(cell: Locator): Promise<string> {
  const id = await cell.getAttribute('data-media-id');
  if (!id) throw new Error('la celda no tiene data-media-id');
  return id;
}

/** `rev` de la miniatura de una celda (`vault://thumb/<id>?rev=<n>`). */
export async function thumbRevOf(cell: Locator): Promise<number> {
  const src = (await cell.locator('img').first().getAttribute('src')) ?? '';
  const m = /[?&]rev=(\d+)/.exec(src);
  if (!m) throw new Error(`miniatura sin rev: ${src}`);
  return Number(m[1]);
}

/** SHA-256 de cada archivo de `vaults/<profileId>/objects/` (los objetos cifrados), por ruta relativa. */
export function objectHashes(dataDir: string, profileId: string): Record<string, string> {
  const base = join(dataDir, 'vaults', profileId, 'objects');
  const out: Record<string, string> = {};
  for (const file of filesUnder(base)) out[relative(base, file)] = sha256File(file);
  return out;
}

/** Operaciones guardadas de un medio, tal como las devuelve media:get. */
export async function savedEdits(page: Page, id: string): Promise<unknown[]> {
  return page.evaluate(async (mediaId) => {
    const api = (
      window as unknown as {
        galeria: {
          invoke(
            channel: 'media:get',
            req: { id: string },
          ): Promise<{ ok: boolean; data?: { edits: unknown[] } }>;
        };
      }
    ).galeria;
    const res = await api.invoke('media:get', { id: mediaId });
    return res.ok && res.data ? res.data.edits : ['error'];
  }, id);
}

/**
 * Colores de cuadrante de la miniatura de un medio: se dibuja en un lienzo (el protocolo envía CORS
 * para el origen del renderer) y se muestrea en los puntos dados.
 */
export async function thumbQuadrants(
  page: Page,
  id: string,
  rev: number,
  points: readonly (readonly [number, number])[],
): Promise<{ width: number; height: number; colors: QuadrantColor[] }> {
  const sampled = await page.evaluate(
    async ({ id: mediaId, rev: r, pts }) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = `vault://thumb/${mediaId}?rev=${r}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('sin lienzo 2d');
      ctx.drawImage(img, 0, 0);
      return {
        width: canvas.width,
        height: canvas.height,
        pixels: pts.map(([fx, fy]) => {
          const x = Math.min(canvas.width - 1, Math.floor(fx * canvas.width));
          const y = Math.min(canvas.height - 1, Math.floor(fy * canvas.height));
          return Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
        }),
      };
    },
    { id, rev, pts: points },
  );
  return {
    width: sampled.width,
    height: sampled.height,
    colors: sampled.pixels.map((p) => nearestQuadrant(p)),
  };
}
