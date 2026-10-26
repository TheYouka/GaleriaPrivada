// Modelo de edición (docs/DESIGN.md §16.3; PLAN.md 3.1): foldEdits, forma canónica y mapeo a sharp.
// La semántica se comprueba contra un modelo de matrices: aplicar cada operación a la VISTA actual
// (girar, voltear o recortar lo que se ve) tiene que dar lo mismo que aplicar al original el estado
// canónico T = F^flip ∘ R^q y después su recorte.
import { describe, expect, it } from 'vitest';
import {
  applyEdit,
  canonicalOps,
  cropRegion,
  foldEdits,
  identityState,
  isEditOp,
  isIdentity,
  opsForSave,
  orientedSize,
  sameEditState,
  sharpParams,
  type EditState,
} from '@shared/edits';
import type { EditOp } from '@shared/types';

type Grid = number[][];

const rotCW = (g: Grid): Grid =>
  (g[0] as number[]).map((_, x) => g.map((r) => r[x] as number).reverse());
const flopG = (g: Grid): Grid => g.map((r) => [...r].reverse());
const flipG = (g: Grid): Grid => [...g].reverse();
function cropG(g: Grid, c: { x: number; y: number; w: number; h: number }): Grid {
  const H = g.length;
  const W = (g[0] as number[]).length;
  const r = cropRegion(c, W, H);
  return g.slice(r.top, r.top + r.height).map((row) => row.slice(r.left, r.left + r.width));
}

/** Matriz W×H con un valor distinto en cada celda (asimétrica en todas las direcciones). */
function grid(W: number, H: number): Grid {
  return Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => y * W + x));
}

/** Aplica la operación a lo que se ve (la definición de cada operación en el editor). */
function viewOp(g: Grid, op: EditOp): Grid {
  switch (op.t) {
    case 'rotate': {
      let out = g;
      for (let i = 0; i < op.q; i += 1) out = rotCW(out);
      return out;
    }
    case 'flipH':
      return flopG(g);
    case 'flipV':
      return flipG(g);
    case 'crop':
      return cropG(g, op);
  }
}

/** Lo que dibuja un EditState: R^q, después F^flip, después el recorte (§16.3). */
function render(g: Grid, s: EditState): Grid {
  let out = g;
  for (let i = 0; i < s.q; i += 1) out = rotCW(out);
  if (s.flip) out = flopG(out);
  return cropG(out, s.crop);
}

/** PRNG determinista (mulberry32). */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Recortes que dejan siempre una matriz de 2^k (las mitades caen en píxeles exactos). */
const HALF_CROPS: EditOp[] = [
  { t: 'crop', x: 0, y: 0, w: 0.5, h: 1 },
  { t: 'crop', x: 0.5, y: 0, w: 0.5, h: 1 },
  { t: 'crop', x: 0, y: 0.5, w: 1, h: 0.5 },
  { t: 'crop', x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
  { t: 'crop', x: 0, y: 0.25, w: 0.75, h: 0.5 },
];
const ORIENT_OPS: EditOp[] = [
  { t: 'rotate', q: 1 },
  { t: 'rotate', q: 2 },
  { t: 'rotate', q: 3 },
  { t: 'flipH' },
  { t: 'flipV' },
];

describe('foldEdits: composición en cualquier orden (modelo de matrices)', () => {
  it('500 listas aleatorias de giros, volteos y recortes: el estado canónico dibuja lo mismo', () => {
    const rnd = prng(20261026);
    const base = grid(32, 16);
    for (let n = 0; n < 500; n += 1) {
      const ops: EditOp[] = [];
      let crops = 0;
      const len = 1 + Math.floor(rnd() * 10);
      for (let i = 0; i < len; i += 1) {
        if (crops < 2 && rnd() < 0.3) {
          ops.push(HALF_CROPS[Math.floor(rnd() * HALF_CROPS.length)] as EditOp);
          crops += 1;
        } else {
          ops.push(ORIENT_OPS[Math.floor(rnd() * ORIENT_OPS.length)] as EditOp);
        }
      }
      const expected = ops.reduce(viewOp, base);
      expect(render(base, foldEdits(ops)), JSON.stringify(ops)).toEqual(expected);
    }
  });

  it('recortar antes o después de girar no es lo mismo, y los dos casos salen bien', () => {
    const base = grid(4, 2);
    const crop: EditOp = { t: 'crop', x: 0.5, y: 0, w: 0.5, h: 1 };
    const a: EditOp[] = [crop, { t: 'rotate', q: 1 }];
    const b: EditOp[] = [{ t: 'rotate', q: 1 }, crop];
    expect(render(base, foldEdits(a))).toEqual(a.reduce(viewOp, base));
    expect(render(base, foldEdits(b))).toEqual(b.reduce(viewOp, base));
    expect(render(base, foldEdits(a))).not.toEqual(render(base, foldEdits(b)));
  });
});

describe('foldEdits: identidades de §16.3', () => {
  it('lista vacía = identidad', () => {
    expect(foldEdits([])).toEqual(identityState());
    expect(isIdentity(foldEdits([]))).toBe(true);
  });

  it('4 giros = identidad (con y sin volteo, y con 4 × rotate 1, 2 × rotate 2, 1 + 3)', () => {
    for (const ops of [
      [1, 1, 1, 1],
      [2, 2],
      [1, 3],
      [3, 3, 3, 3],
    ] as const) {
      const rot = ops.map((q) => ({ t: 'rotate', q }) as EditOp);
      expect(foldEdits(rot)).toEqual(identityState());
      const flipped = foldEdits([{ t: 'flipH' }, ...rot]);
      expect(flipped).toEqual({ ...identityState(), flip: true });
    }
  });

  it('flipH² = identidad', () => {
    expect(foldEdits([{ t: 'flipH' }, { t: 'flipH' }])).toEqual(identityState());
    expect(foldEdits([{ t: 'flipV' }, { t: 'flipV' }])).toEqual(identityState());
  });

  it('flipV = rotate 2 + flipH (también tras otras operaciones y con un recorte)', () => {
    const prefixes: EditOp[][] = [
      [],
      [{ t: 'rotate', q: 1 }],
      [{ t: 'flipH' }, { t: 'rotate', q: 3 }],
      [{ t: 'crop', x: 0.1, y: 0.2, w: 0.3, h: 0.5 }],
    ];
    for (const p of prefixes) {
      const a = foldEdits([...p, { t: 'flipV' }]);
      const b = foldEdits([...p, { t: 'rotate', q: 2 }, { t: 'flipH' }]);
      expect(sameEditState(a, b), JSON.stringify(p)).toBe(true);
    }
  });

  it('la regla del giro con volteo: q ← (q − q′) mod 4', () => {
    expect(foldEdits([{ t: 'flipH' }, { t: 'rotate', q: 1 }])).toMatchObject({ q: 3, flip: true });
    expect(foldEdits([{ t: 'rotate', q: 1 }, { t: 'flipH' }])).toMatchObject({ q: 1, flip: true });
  });

  it('composición de recortes: (x + cx·w, y + cy·h, cw·w, ch·h)', () => {
    const s = foldEdits([
      { t: 'crop', x: 0.2, y: 0.1, w: 0.5, h: 0.8 },
      { t: 'crop', x: 0.5, y: 0.25, w: 0.5, h: 0.5 },
    ]);
    expect(s.q).toBe(0);
    expect(s.flip).toBe(false);
    expect(s.crop.x).toBeCloseTo(0.45, 12);
    expect(s.crop.y).toBeCloseTo(0.3, 12);
    expect(s.crop.w).toBeCloseTo(0.25, 12);
    expect(s.crop.h).toBeCloseTo(0.4, 12);
  });

  it('un giro horario lleva el recorte (x, y, w, h) a (1−y−h, x, h, w); flipH a (1−x−w, y, w, h)', () => {
    const s0: EditState = { q: 0, flip: false, crop: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } };
    const r = applyEdit(s0, { t: 'rotate', q: 1 });
    expect(r.crop.x).toBeCloseTo(0.4, 12);
    expect(r.crop.y).toBeCloseTo(0.1, 12);
    expect(r.crop.w).toBeCloseTo(0.4, 12);
    expect(r.crop.h).toBeCloseTo(0.3, 12);
    const f = applyEdit(s0, { t: 'flipH' });
    expect(f.crop.x).toBeCloseTo(0.6, 12);
    expect(f.crop.y).toBeCloseTo(0.2, 12);
    const v = applyEdit(s0, { t: 'flipV' });
    expect(v.crop.x).toBeCloseTo(0.1, 12);
    expect(v.crop.y).toBeCloseTo(0.4, 12);
    expect(applyEdit(s0, { t: 'flipH' })).not.toBe(s0); // no modifica el estado de entrada
    expect(s0.crop.x).toBe(0.1);
  });
});

describe('forma canónica (≤ 3 ops) para listas de más de 64', () => {
  it('da el mismo EditState en los 8 estados D4 con y sin recorte', () => {
    for (const q of [0, 1, 2, 3] as const) {
      for (const flip of [false, true]) {
        for (const crop of [
          { x: 0, y: 0, w: 1, h: 1 },
          { x: 0.1, y: 0.2, w: 0.6, h: 0.5 },
        ]) {
          const s: EditState = { q, flip, crop };
          const ops = canonicalOps(s);
          expect(ops.length).toBeLessThanOrEqual(3);
          expect(sameEditState(foldEdits(ops), s)).toBe(true);
          for (const op of ops) expect(isEditOp(op)).toBe(true);
        }
      }
    }
    expect(canonicalOps(identityState())).toEqual([]);
  });

  it('una lista de 200 operaciones se colapsa a ≤ 3 y dibuja lo mismo', () => {
    const rnd = prng(7);
    const base = grid(32, 16);
    const ops: EditOp[] = [];
    for (let i = 0; i < 200; i += 1) {
      ops.push(
        i === 50 || i === 150
          ? (HALF_CROPS[i % HALF_CROPS.length] as EditOp)
          : (ORIENT_OPS[Math.floor(rnd() * ORIENT_OPS.length)] as EditOp),
      );
    }
    const saved = opsForSave(ops);
    expect(saved.length).toBeLessThanOrEqual(3);
    expect(sameEditState(foldEdits(saved), foldEdits(ops))).toBe(true);
    expect(render(base, foldEdits(saved))).toEqual(ops.reduce(viewOp, base));
  });

  it('hasta 64 operaciones se guardan tal cual', () => {
    const ops: EditOp[] = Array.from({ length: 64 }, () => ({ t: 'flipH' }) as EditOp);
    expect(opsForSave(ops)).toEqual(ops);
    expect(opsForSave([...ops, { t: 'flipH' }])).toEqual([{ t: 'flipH' }]);
  });

  it('la deriva de coma flotante se sanea: el recorte canónico cumple las reglas de §10.3', () => {
    const drifted: EditState = {
      q: 1,
      flip: false,
      crop: { x: 0.30000000000000004, y: -1e-17, w: 0.7000000000000001, h: 1 },
    };
    const crop = canonicalOps(drifted).find((o) => o.t === 'crop');
    expect(crop && isEditOp(crop)).toBe(true);
    if (crop?.t !== 'crop') throw new Error('sin recorte');
    expect(crop.x + crop.w).toBeLessThanOrEqual(1);
    expect(crop.y).toBe(0);
    // Y muchas vueltas con recortes no acumulan error visible.
    let s = identityState();
    for (let i = 0; i < 64; i += 1) {
      s = applyEdit(s, { t: 'rotate', q: 1 });
      s = applyEdit(s, { t: 'flipV' });
    }
    s = applyEdit(s, { t: 'crop', x: 0.1, y: 0.2, w: 0.7, h: 0.6 });
    for (const op of canonicalOps(s)) expect(isEditOp(op)).toBe(true);
  });
});

describe('isEditOp (§10.3)', () => {
  it('acepta las operaciones válidas y rechaza el resto', () => {
    for (const ok of [
      { t: 'rotate', q: 1 },
      { t: 'rotate', q: 3 },
      { t: 'flipH' },
      { t: 'flipV' },
      { t: 'crop', x: 0, y: 0, w: 1, h: 1 },
      { t: 'crop', x: 0.99, y: 0, w: 0.01, h: 0.01 },
      { t: 'crop', x: 0.5, y: 0.5, w: 0.5 + 5e-10, h: 0.5 },
    ]) {
      expect(isEditOp(ok), JSON.stringify(ok)).toBe(true);
    }
    for (const bad of [
      null,
      [],
      { t: 'rotate', q: 0 },
      { t: 'rotate', q: 4 },
      { t: 'rotate' },
      { t: 'flipH', extra: 1 },
      { t: 'crop', x: 0, y: 0, w: 0.005, h: 1 },
      { t: 'crop', x: 0.6, y: 0, w: 0.5, h: 1 },
      { t: 'crop', x: -0.1, y: 0, w: 0.5, h: 1 },
      { t: 'crop', x: Number.NaN, y: 0, w: 0.5, h: 1 },
      { t: 'crop', x: 0, y: 0, w: Infinity, h: 1 },
      { t: 'crop', x: 0, y: 0, w: 1 },
      { t: 'scale', k: 2 },
    ]) {
      expect(isEditOp(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('mapeo a sharp (§16.3)', () => {
  it('q2 = flip ? (4 − q) mod 4 : q', () => {
    expect(sharpParams({ q: 1, flip: false, crop: identityState().crop })).toEqual({
      flop: false,
      angle: 90,
    });
    expect(sharpParams({ q: 1, flip: true, crop: identityState().crop })).toEqual({
      flop: true,
      angle: 270,
    });
    expect(sharpParams({ q: 0, flip: true, crop: identityState().crop }).angle).toBe(0);
    expect(sharpParams({ q: 2, flip: true, crop: identityState().crop }).angle).toBe(180);
    expect(sharpParams({ q: 3, flip: true, crop: identityState().crop }).angle).toBe(90);
  });

  it('el marco orientado intercambia W y H con q impar', () => {
    expect(orientedSize({ q: 1 }, 4000, 3000)).toEqual({ width: 3000, height: 4000 });
    expect(orientedSize({ q: 2 }, 4000, 3000)).toEqual({ width: 4000, height: 3000 });
  });

  it('región en píxeles: redondeo, mínimo 1 px y siempre dentro del marco', () => {
    expect(cropRegion({ x: 0.25, y: 0.5, w: 0.5, h: 0.5 }, 4, 2)).toEqual({
      left: 1,
      top: 1,
      width: 2,
      height: 1,
    });
    expect(cropRegion({ x: 0, y: 0, w: 0.001, h: 0.001 }, 100, 100)).toEqual({
      left: 0,
      top: 0,
      width: 1,
      height: 1,
    });
    // round(0.5·4) = 2 y round(0.625·4) = 3 → se acota a 2 para no salirse.
    expect(cropRegion({ x: 0.375, y: 0, w: 0.625, h: 1 }, 4, 1)).toEqual({
      left: 2,
      top: 0,
      width: 2,
      height: 1,
    });
    expect(cropRegion({ x: 1, y: 1, w: 0.01, h: 0.01 }, 10, 10)).toEqual({
      left: 9,
      top: 9,
      width: 1,
      height: 1,
    });
  });
});
