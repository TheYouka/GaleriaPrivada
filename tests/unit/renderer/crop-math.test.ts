import { describe, expect, it } from 'vitest';
import type { CropRect } from '@shared/edits';
import {
  arrowDelta,
  CROP_HANDLES,
  CROP_RATIOS,
  cropLimits,
  fitRatio,
  moveRect,
  ratioK,
  resizeRect,
  type CropHandle,
} from '@renderer/screens/viewer/crop-math';

const FULL: CropRect = { x: 0, y: 0, w: 1, h: 1 };
const limits = { minW: 0.01, minH: 0.01 };
const inside = (r: CropRect): boolean =>
  r.x >= -1e-12 && r.y >= -1e-12 && r.x + r.w <= 1 + 1e-12 && r.y + r.h <= 1 + 1e-12;

describe('rectángulo de recorte', () => {
  it('mover no cambia el tamaño y no se sale del marco', () => {
    const r = moveRect({ x: 0.2, y: 0.2, w: 0.5, h: 0.4 }, 0.9, -0.9);
    expect(r).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.4 });
  });

  it('cada asa mueve solo sus bordes (proporción libre)', () => {
    const r = { x: 0.2, y: 0.2, w: 0.5, h: 0.5 };
    const e = resizeRect(r, 'e', 0.1, 0.3, limits);
    expect(e.x).toBe(0.2);
    expect(e.y).toBe(0.2);
    expect(e.w).toBeCloseTo(0.6, 12);
    expect(e.h).toBe(0.5);
    const nw = resizeRect(r, 'nw', 0.1, 0.05, limits);
    expect(nw.x).toBeCloseTo(0.3, 12);
    expect(nw.y).toBeCloseTo(0.25, 12);
    expect(nw.x + nw.w).toBeCloseTo(0.7, 12);
    expect(nw.y + nw.h).toBeCloseTo(0.7, 12);
    // Un borde horizontal ignora el desplazamiento horizontal.
    const n = resizeRect(r, 'n', 0.4, 0.1, limits);
    expect(n.x).toBe(0.2);
    expect(n.w).toBe(0.5);
    expect(n.y).toBeCloseTo(0.3, 12);
    expect(n.h).toBeCloseTo(0.4, 12);
  });

  it('respeta el tamaño mínimo y el marco', () => {
    const r = { x: 0.2, y: 0.2, w: 0.5, h: 0.5 };
    expect(resizeRect(r, 'e', -5, 0, limits).w).toBeCloseTo(0.01, 12);
    expect(resizeRect(r, 'w', 5, 0, limits).w).toBeCloseTo(0.01, 12);
    const big = resizeRect(r, 'se', 5, 5, limits);
    expect(big).toEqual({ x: 0.2, y: 0.2, w: 0.8, h: 0.8 });
  });

  it('con proporción fijada la conserva en las 8 asas y no se sale del marco', () => {
    const k = 16 / 9;
    const start = fitRatio({ ...FULL }, k, limits);
    expect(start.w / start.h).toBeCloseTo(k, 12);
    for (const handle of CROP_HANDLES) {
      for (const [dx, dy] of [
        [0.1, 0.03],
        [-0.2, -0.2],
        [0.5, -0.4],
        [-0.9, 0.9],
        [0.02, 0],
      ] as const) {
        const base: CropRect = { x: 0.2, y: 0.2, w: 0.4 * k > 0.7 ? 0.7 : 0.4 * k, h: 0 };
        base.h = base.w / k;
        const r = resizeRect(base, handle as CropHandle, dx, dy, limits, k);
        expect(inside(r)).toBe(true);
        expect(r.w / r.h).toBeCloseTo(k, 9);
        expect(r.w).toBeGreaterThanOrEqual(limits.minW - 1e-12);
        expect(r.h).toBeGreaterThanOrEqual(limits.minH - 1e-12);
      }
    }
  });

  it('una esquina deja fija la opuesta', () => {
    const k = 1;
    const base = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
    const r = resizeRect(base, 'se', 0.1, 0.1, limits, k);
    expect(r.x).toBeCloseTo(0.2, 12);
    expect(r.y).toBeCloseTo(0.2, 12);
    expect(r.w).toBeCloseTo(0.5, 12);
    const nw = resizeRect(base, 'nw', -0.1, -0.1, limits, k);
    expect(nw.x + nw.w).toBeCloseTo(0.6, 12);
    expect(nw.y + nw.h).toBeCloseTo(0.6, 12);
  });

  it('fitRatio conserva el centro y cabe en el rectángulo', () => {
    const r = fitRatio({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, 2, limits);
    expect(r.w / r.h).toBeCloseTo(2, 12);
    expect(r.x + r.w / 2).toBeCloseTo(0.5, 12);
    expect(r.y + r.h / 2).toBeCloseTo(0.5, 12);
    expect(r.w).toBeLessThanOrEqual(0.8 + 1e-12);
  });
});

describe('proporciones y límites', () => {
  it('ratioK convierte píxeles a unidades normalizadas', () => {
    // Vista de 4000×3000: un 1:1 en píxeles es 0,75 en unidades normalizadas.
    expect(ratioK(1, { w: 4000, h: 3000 })).toBeCloseTo(0.75, 12);
    expect(ratioK('original', { w: 4000, h: 3000 })).toBeCloseTo(1, 12);
    expect(ratioK(null, { w: 4000, h: 3000 })).toBeNull();
    expect(CROP_RATIOS.map((r) => r.id)).toEqual([
      'free',
      'original',
      '1:1',
      '4:3',
      '3:2',
      '16:9',
      '3:4',
      '2:3',
      '9:16',
    ]);
  });

  it('el recorte acumulado no baja del 1 % del marco (nota 140)', () => {
    expect(cropLimits({ w: 1, h: 1 })).toEqual({ minW: 0.01, minH: 0.01 });
    const l = cropLimits({ w: 0.2, h: 0.5 });
    expect(l.minW).toBeCloseTo(0.05, 12);
    expect(l.minH).toBeCloseTo(0.02, 12);
    expect(0.2 * l.minW).toBeGreaterThanOrEqual(0.01 - 1e-12);
  });

  it('las flechas dan 1 % o 10 % por eje', () => {
    expect(arrowDelta('ArrowLeft', 0.01)).toEqual({ dx: -0.01, dy: 0 });
    expect(arrowDelta('ArrowDown', 0.1)).toEqual({ dx: 0, dy: 0.1 });
    expect(arrowDelta('a', 0.1)).toBeNull();
  });
});
