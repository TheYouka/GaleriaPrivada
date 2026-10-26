import { describe, expect, it } from 'vitest';
import { identityState } from '@shared/edits';
import {
  clampPan,
  clampScale,
  DOUBLE_CLICK_SCALE,
  editedAspect,
  FIT,
  fitContain,
  flipStart,
  MAX_SCALE,
  maxPan,
  MIN_SCALE,
  panBy,
  parseCubicBezier,
  rectsOverlap,
  toggleZoom,
  wheelScale,
  zoomAt,
  type Size,
  type ZoomState,
} from '@renderer/screens/viewer/zoom-math';

const viewport: Size = { w: 1000, h: 600 };
const box: Size = { w: 800, h: 600 };

/** Posición en pantalla (respecto al centro de la vista) del punto `u` del contenido. */
const screenOf = (s: ZoomState, u: { x: number; y: number }) => ({
  x: s.x + s.scale * u.x,
  y: s.y + s.scale * u.y,
});

describe('escala', () => {
  it('está acotada a [1, 8]', () => {
    expect(clampScale(0.2)).toBe(MIN_SCALE);
    expect(clampScale(3)).toBe(3);
    expect(clampScale(50)).toBe(MAX_SCALE);
    expect(clampScale(Number.NaN)).toBe(MIN_SCALE);
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(MIN_SCALE);
  });

  it('la rueda multiplica por 1,1^(−deltaY/100) y respeta los límites', () => {
    expect(wheelScale(2, -100)).toBeCloseTo(2.2, 10);
    expect(wheelScale(2, 100)).toBeCloseTo(2 / 1.1, 10);
    expect(wheelScale(1, 100)).toBe(1);
    expect(wheelScale(7.9, -1000)).toBe(MAX_SCALE);
    // Muchos pasos seguidos nunca salen del intervalo.
    let s = 1;
    for (let i = 0; i < 200; i += 1) s = wheelScale(s, -120);
    expect(s).toBe(MAX_SCALE);
    for (let i = 0; i < 200; i += 1) s = wheelScale(s, 120);
    expect(s).toBe(MIN_SCALE);
  });
});

describe('zoom centrado en el cursor', () => {
  it('el punto bajo el cursor no se mueve', () => {
    // Un contenido grande (el desplazamiento no se limita) y varios cursores y escalas.
    const big: Size = { w: 4000, h: 3000 };
    const cursors = [
      { x: 0, y: 0 },
      { x: 120, y: -80 },
      { x: -300, y: 200 },
      { x: 499, y: 299 },
    ];
    for (const anchor of cursors) {
      let state: ZoomState = { scale: 2, x: 40, y: -25 };
      // Punto del contenido que hay bajo el cursor antes de ampliar.
      const u = { x: (anchor.x - state.x) / state.scale, y: (anchor.y - state.y) / state.scale };
      state = zoomAt(state, 3.7, anchor, big, viewport);
      const p = screenOf(state, u);
      expect(p.x).toBeCloseTo(anchor.x, 9);
      expect(p.y).toBeCloseTo(anchor.y, 9);
    }
  });

  it('la rueda a 1× con deltaY positivo no hace nada', () => {
    const next = zoomAt(FIT, wheelScale(1, 300), { x: 100, y: 100 }, box, viewport);
    expect(next).toEqual(FIT);
  });
});

describe('límites del desplazamiento', () => {
  it('a 1× no hay desplazamiento (la caja cabe en la vista)', () => {
    expect(maxPan(1, box, viewport)).toEqual({ x: 0, y: 0 });
    expect(panBy(FIT, 200, -90, box, viewport)).toEqual(FIT);
  });

  it('con zoom, el contenido nunca deja hueco en los bordes', () => {
    const scale = 3;
    const max = maxPan(scale, box, viewport);
    // (800·3 − 1000)/2 = 700 y (600·3 − 600)/2 = 600.
    expect(max).toEqual({ x: 700, y: 600 });
    const far = panBy({ scale, x: 0, y: 0 }, 99_999, -99_999, box, viewport);
    expect(far).toEqual({ scale, x: 700, y: -600 });
  });

  it('un eje donde el contenido ampliado sigue cabiendo queda centrado', () => {
    const narrow: Size = { w: 300, h: 600 };
    const state = clampPan({ scale: 2, x: 400, y: 400 }, narrow, viewport);
    expect(state.x).toBe(0); // 600 < 1000
    expect(state.y).toBe(300); // (1200 − 600)/2
  });

  it('al ampliar en el borde el desplazamiento se limita', () => {
    const state = zoomAt(FIT, 2, { x: 500, y: 300 }, box, viewport);
    const max = maxPan(2, box, viewport);
    expect(Math.abs(state.x)).toBeLessThanOrEqual(max.x);
    expect(Math.abs(state.y)).toBeLessThanOrEqual(max.y);
  });
});

describe('doble clic', () => {
  it('alterna entre 1 y 2', () => {
    const anchor = { x: 150, y: 90 };
    const zoomed = toggleZoom(FIT, anchor, box, viewport);
    expect(zoomed.scale).toBe(DOUBLE_CLICK_SCALE);
    expect(toggleZoom(zoomed, anchor, box, viewport)).toEqual(FIT);
    // Desde cualquier ampliación vuelve a ajustar.
    expect(toggleZoom({ scale: 5.5, x: 10, y: 10 }, anchor, box, viewport)).toEqual(FIT);
  });
});

describe('ajuste y proporción', () => {
  it('fitContain cabe siempre en el espacio disponible', () => {
    expect(fitContain(2, { w: 1000, h: 1000 })).toEqual({ w: 1000, h: 500 });
    expect(fitContain(0.5, { w: 1000, h: 400 })).toEqual({ w: 200, h: 400 });
    expect(fitContain(0, { w: 100, h: 100 })).toEqual({ w: 0, h: 0 });
    expect(fitContain(1, { w: 0, h: 100 })).toEqual({ w: 0, h: 0 });
  });

  it('editedAspect usa el marco orientado y el recorte', () => {
    expect(editedAspect(identityState(), 400, 200)).toBe(2);
    expect(editedAspect({ ...identityState(), q: 1 }, 400, 200)).toBe(0.5);
    const cropped = { ...identityState(), crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.25 } };
    expect(editedAspect(cropped, 400, 200)).toBeCloseTo((0.5 * 400) / (0.25 * 200), 12);
    expect(editedAspect({ ...cropped, q: 3 }, 400, 200)).toBeCloseTo(
      (0.5 * 200) / (0.25 * 400),
      12,
    );
  });
});

describe('FLIP', () => {
  const finalBox = { left: 100, top: 50, width: 800, height: 600 };
  const tile = { left: 20, top: 400, width: 180, height: 180 };

  it('el centro de la caja va al del mosaico y la escala cubre el mosaico', () => {
    const f = flipStart(finalBox, tile, 8);
    expect(finalBox.left + finalBox.width / 2 + f.x).toBeCloseTo(tile.left + tile.width / 2, 9);
    expect(finalBox.top + finalBox.height / 2 + f.y).toBeCloseTo(tile.top + tile.height / 2, 9);
    expect(f.scale).toBeCloseTo(0.3, 9); // max(180/800, 180/600)
  });

  it('el recorte deja visible exactamente el mosaico (imita object-fit: cover)', () => {
    const f = flipStart(finalBox, tile, 8);
    const m = /^inset\(([\d.]+)px ([\d.]+)px ([\d.]+)px ([\d.]+)px round ([\d.]+)px\)$/.exec(
      f.clipPath,
    );
    expect(m).not.toBeNull();
    const [iy, ix] = [Number(m?.[1]), Number(m?.[2])];
    expect((finalBox.width - 2 * ix) * f.scale).toBeCloseTo(tile.width, 9);
    expect((finalBox.height - 2 * iy) * f.scale).toBeCloseTo(tile.height, 9);
    expect(Number(m?.[5]) * f.scale).toBeCloseTo(8, 9);
  });

  it('un mosaico más ancho que la caja recorta arriba y abajo', () => {
    const f = flipStart({ left: 0, top: 0, width: 400, height: 800 }, { ...tile, width: 200 });
    expect(f.scale).toBeCloseTo(0.5, 9);
    expect(f.clipPath.startsWith('inset(')).toBe(true);
  });

  it('rectsOverlap y parseCubicBezier', () => {
    expect(rectsOverlap(tile, { left: 0, top: 0, width: 1000, height: 500 })).toBe(true);
    expect(rectsOverlap(tile, { left: 0, top: 0, width: 1000, height: 300 })).toBe(false);
    expect(parseCubicBezier('cubic-bezier(0.3, 0, 0, 1)')).toEqual([0.3, 0, 0, 1]);
    expect(parseCubicBezier('linear')).toEqual([0.3, 0, 0, 1]);
  });
});
