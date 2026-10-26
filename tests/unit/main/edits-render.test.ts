// Render de ediciones en main (docs/DESIGN.md §16.3; PLAN.md 3.2). Test obligatorio: una imagen
// asimétrica de 4×2 píxeles con colores distintos, en los 8 estados D4 combinados con un recorte,
// comparada píxel a píxel (WebP sin pérdida) con la matriz que calcula foldEdits.
import { describe, expect, it } from 'vitest';
import { AppErrorException } from '@shared/errors';
import { cropRegion, foldEdits, identityState, type EditState } from '@shared/edits';
import type { EditOp } from '@shared/types';
import { renderEdits } from '../../../src/main/media/edits-render';
import { getSharp } from '../../../src/main/media/sharp-loader';

type Grid = number[][];

const W = 4;
const H = 2;
/** Cada píxel lleva su índice (0–7) en el canal rojo, multiplicado por 30. */
const STEP = 30;

const rotCW = (g: Grid): Grid =>
  (g[0] as number[]).map((_, x) => g.map((r) => r[x] as number).reverse());
const flopG = (g: Grid): Grid => g.map((r) => [...r].reverse());

/** La matriz que calcula foldEdits: R^q, después F^flip, después el recorte en píxeles. */
function expectedGrid(base: Grid, s: EditState): Grid {
  let g = base;
  for (let i = 0; i < s.q; i += 1) g = rotCW(g);
  if (s.flip) g = flopG(g);
  const r = cropRegion(s.crop, (g[0] as number[]).length, g.length);
  return g.slice(r.top, r.top + r.height).map((row) => row.slice(r.left, r.left + r.width));
}

async function decode(webp: Buffer): Promise<{ grid: Grid; format: string | undefined }> {
  const sharp = await getSharp();
  const meta = await sharp(webp).metadata();
  const { data, info } = await sharp(webp)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const grid: Grid = [];
  for (let y = 0; y < info.height; y += 1) {
    const row: number[] = [];
    for (let x = 0; x < info.width; x += 1) {
      const v = data[(y * info.width + x) * info.channels] as number;
      row.push(v / STEP);
    }
    grid.push(row);
  }
  return { grid, format: meta.format };
}

/** PNG de 4×2 (sin pérdida) con una orientación EXIF opcional. */
async function asymmetricPng(orientation?: number): Promise<Buffer> {
  const sharp = await getSharp();
  const px = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i += 1) {
    px[i * 3] = i * STEP;
    px[i * 3 + 1] = 255 - i * STEP; // verde y azul distintos para que no haya dos colores iguales
    px[i * 3 + 2] = (i * 97) % 256;
  }
  const img = sharp(px, { raw: { width: W, height: H, channels: 3 } }).png();
  return orientation ? img.withMetadata({ orientation }).toBuffer() : img.toBuffer();
}

/** La matriz que se ve tras aplicar la orientación EXIF (base de §16.3), leída con sharp. */
async function displayedGrid(png: Buffer): Promise<Grid> {
  const sharp = await getSharp();
  const { data, info } = await sharp(png).autoOrient().raw().toBuffer({ resolveWithObject: true });
  const g: Grid = [];
  for (let y = 0; y < info.height; y += 1) {
    const row: number[] = [];
    for (let x = 0; x < info.width; x += 1) {
      row.push((data[(y * info.width + x) * info.channels] as number) / STEP);
    }
    g.push(row);
  }
  return g;
}

/** Operaciones que llevan a cada estado D4 (q, flip). */
function orientationOps(q: number, flip: boolean): EditOp[] {
  const ops: EditOp[] = [];
  if (q > 0) ops.push({ t: 'rotate', q: q as 1 | 2 | 3 });
  if (flip) ops.push({ t: 'flipH' });
  return ops;
}

/** Recortes alineados a píxeles en los dos marcos (4×2 y 2×4), antes y después de orientar. */
const CROPS: { name: string; at: 'before' | 'after'; op: EditOp }[] = [
  {
    name: 'cuadrante inferior derecho',
    at: 'after',
    op: { t: 'crop', x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
  },
  { name: 'mitad izquierda', at: 'after', op: { t: 'crop', x: 0, y: 0, w: 0.5, h: 1 } },
  { name: 'columna 1 del original', at: 'before', op: { t: 'crop', x: 0.25, y: 0, w: 0.25, h: 1 } },
  { name: 'tres columnas de arriba', at: 'before', op: { t: 'crop', x: 0, y: 0, w: 0.75, h: 0.5 } },
];

describe('renderEdits: 8 estados D4 × recorte, píxel a píxel (§16.3)', () => {
  for (const orientation of [undefined, 6, 2] as const) {
    it(`imagen asimétrica de 4×2${orientation ? ` con orientación EXIF ${orientation}` : ''}`, async () => {
      const png = await asymmetricPng(orientation);
      const base = await displayedGrid(png);
      let checked = 0;
      for (const q of [0, 1, 2, 3]) {
        for (const flip of [false, true]) {
          for (const crop of CROPS) {
            const orient = orientationOps(q, flip);
            const ops = crop.at === 'after' ? [...orient, crop.op] : [crop.op, ...orient];
            const state = foldEdits(ops);
            expect(state.q).toBe(q);
            expect(state.flip).toBe(flip);
            const out = await decode(await renderEdits(png, state, { lossless: true }));
            expect(out.format).toBe('webp');
            expect(out.grid, `${JSON.stringify(ops)} (${crop.name})`).toEqual(
              expectedGrid(base, state),
            );
            checked += 1;
          }
        }
      }
      expect(checked).toBe(8 * CROPS.length);
    });
  }

  it('sin ediciones: la imagen entera tras EXIF (una sola pasada)', async () => {
    const png = await asymmetricPng(6);
    const out = await decode(await renderEdits(png, identityState(), { lossless: true }));
    expect(out.grid).toEqual(await displayedGrid(png));
  });
});

describe('renderEdits: miniatura', () => {
  it('WebP q78 de ≤ 512 px por el lado mayor, sin ampliar, del recorte orientado', async () => {
    const sharp = await getSharp();
    const big = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: '#2a6' },
    })
      .jpeg()
      .toBuffer();
    const state = foldEdits([
      { t: 'rotate', q: 1 },
      { t: 'crop', x: 0, y: 0, w: 1, h: 0.5 },
    ]);
    const meta = await sharp(await renderEdits(big, state)).metadata();
    // Marco orientado 2000×3000, recorte de la mitad superior → 2000×1500 → 512×384.
    expect(meta).toMatchObject({ format: 'webp', width: 512, height: 384 });
    const small = await sharp({
      create: { width: 40, height: 20, channels: 3, background: '#a26' },
    })
      .png()
      .toBuffer();
    const smallMeta = await sharp(
      await renderEdits(small, foldEdits([{ t: 'rotate', q: 1 }])),
    ).metadata();
    expect(smallMeta).toMatchObject({ width: 20, height: 40 });
  });

  it('una entrada que sharp no decodifica → INTERNAL (render)', async () => {
    const err = await renderEdits(
      Buffer.from('no es una imagen'),
      foldEdits([{ t: 'flipH' }]),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppErrorException);
    expect((err as AppErrorException).error).toEqual({
      code: 'INTERNAL',
      details: { reason: 'render' },
    });
    const err2 = await renderEdits(Buffer.from('tampoco'), identityState()).catch(
      (e: unknown) => e,
    );
    expect((err2 as AppErrorException).error.code).toBe('INTERNAL');
  });
});
