// Origen de cada diapositiva (PLAN.md notas 147/152): las fotos editadas muestran su versión
// editada igual que el visor (vault://media + ediciones por CSS), los vídeos su póster.
import { describe, expect, it } from 'vitest';
import type { EditOp } from '../../../src/shared/types';
import {
  resolveSlide,
  slideBox,
  slideSpecs,
  type SlideItem,
} from '../../../src/renderer/src/screens/presentation/slide-source';

const ID = '0123456789abcdef0123456789abcdef';
const photo: SlideItem = { id: ID, kind: 'photo', thumbRev: 3, width: 400, height: 200 };
const video: SlideItem = { ...photo, kind: 'video' };

describe('resolveSlide', () => {
  it('una foto sin ediciones: vault://media, estado identidad, proporción de la foto', () => {
    const s = resolveSlide(photo, []);
    expect(s.mediaUrl).toBe(`vault://media/${ID}`);
    expect(s.posterUrl).toBe(`vault://thumb/${ID}?rev=3`);
    expect(s.edited).toBe(false);
    expect(s.aspect).toBe(2);
    expect(s.needsDetail).toBe(true);
  });

  it('una foto editada usa la misma fuente y el estado de foldEdits (giro + recorte)', () => {
    const edits: EditOp[] = [
      { t: 'rotate', q: 1 },
      { t: 'crop', x: 0, y: 0, w: 1, h: 0.5 },
    ];
    const s = resolveSlide(photo, edits);
    expect(s.mediaUrl).toBe(`vault://media/${ID}`);
    expect(s.edited).toBe(true);
    expect(s.editState.q).toBe(1);
    // 400×200 girada un cuarto → 200×400; recorte de media altura → 200×200.
    expect(s.aspect).toBeCloseTo(1, 9);
  });

  it('sin `media:get` todavía (null) se muestra sin editar', () => {
    const s = resolveSlide(photo, null);
    expect(s.edited).toBe(false);
    expect(s.editState.q).toBe(0);
  });

  it('los vídeos ignoran las ediciones y no las necesitan', () => {
    const s = resolveSlide(video, [{ t: 'rotate', q: 1 }]);
    expect(s.edited).toBe(false);
    expect(s.needsDetail).toBe(false);
    expect(s.aspect).toBe(2);
  });

  it('sin dimensiones no hay proporción', () => {
    expect(resolveSlide({ ...photo, width: null }, []).aspect).toBeNull();
    expect(resolveSlide({ ...photo, height: 0 }, []).aspect).toBeNull();
  });

  it('un id inválido no construye URLs', () => {
    expect(() => resolveSlide({ ...photo, id: '../x' }, [])).toThrow(RangeError);
  });
});

describe('slideBox', () => {
  it('ajusta la proporción al escenario (contain)', () => {
    expect(slideBox({ aspect: 2 }, { w: 1000, h: 1000 })).toEqual({ w: 1000, h: 500 });
    expect(slideBox({ aspect: 0.5 }, { w: 1000, h: 1000 })).toEqual({ w: 500, h: 1000 });
    expect(slideBox({ aspect: null }, { w: 1000, h: 1000 })).toEqual({ w: 0, h: 0 });
  });
});

describe('slideSpecs', () => {
  it('traduce la lista al planificador, con duraciones propias solo en fotos', () => {
    const other = '1'.repeat(32);
    const specs = slideSpecs(
      [
        { id: ID, kind: 'photo' },
        { id: other, kind: 'video' },
        { id: '2'.repeat(32), kind: 'photo' },
      ],
      new Map([
        [ID, 1500],
        [other, 9999],
      ]),
    );
    expect(specs).toEqual([
      { kind: 'photo', durationMs: 1500 },
      { kind: 'video' },
      { kind: 'photo' },
    ]);
  });
});
