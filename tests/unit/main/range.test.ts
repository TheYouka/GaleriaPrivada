// protocol/range.ts (docs/DESIGN.md §11.2): todas las formas de Range.
import { describe, expect, it } from 'vitest';
import { contentRange, parseRange, unsatisfiedRange } from '../../../src/main/protocol/range';

const P = 1000;

describe('parseRange', () => {
  it('sin cabecera → 200 completo', () => {
    expect(parseRange(null, P)).toEqual({ kind: 'full' });
    expect(parseRange(undefined, P)).toEqual({ kind: 'full' });
  });

  it('bytes=a-b', () => {
    expect(parseRange('bytes=0-0', P)).toEqual({ kind: 'partial', start: 0, end: 0 });
    expect(parseRange('bytes=10-99', P)).toEqual({ kind: 'partial', start: 10, end: 99 });
    expect(parseRange('bytes=999-999', P)).toEqual({ kind: 'partial', start: 999, end: 999 });
  });

  it('bytes=a-', () => {
    expect(parseRange('bytes=0-', P)).toEqual({ kind: 'partial', start: 0, end: 999 });
    expect(parseRange('bytes=500-', P)).toEqual({ kind: 'partial', start: 500, end: 999 });
  });

  it('bytes=-n (últimos n bytes)', () => {
    expect(parseRange('bytes=-1', P)).toEqual({ kind: 'partial', start: 999, end: 999 });
    expect(parseRange('bytes=-100', P)).toEqual({ kind: 'partial', start: 900, end: 999 });
    expect(parseRange('bytes=-1000', P)).toEqual({ kind: 'partial', start: 0, end: 999 });
  });

  it('bytes=-n con n > P sirve [0, P − 1]', () => {
    expect(parseRange('bytes=-5000', P)).toEqual({ kind: 'partial', start: 0, end: 999 });
    expect(parseRange(`bytes=-${'9'.repeat(30)}`, P)).toEqual({
      kind: 'partial',
      start: 0,
      end: 999,
    });
  });

  it('b ≥ P se recorta a P − 1', () => {
    expect(parseRange('bytes=10-1000', P)).toEqual({ kind: 'partial', start: 10, end: 999 });
    expect(parseRange('bytes=10-999999999999999999999', P)).toEqual({
      kind: 'partial',
      start: 10,
      end: 999,
    });
  });

  it('varios rangos → 200 completo', () => {
    expect(parseRange('bytes=0-1,5-6', P)).toEqual({ kind: 'full' });
    expect(parseRange('bytes=0-1, 5-', P)).toEqual({ kind: 'full' });
  });

  it('a > b → 200 completo', () => {
    expect(parseRange('bytes=10-5', P)).toEqual({ kind: 'full' });
  });

  it('sintaxis inválida → 200 completo', () => {
    for (const h of [
      '',
      'bytes=',
      'bytes=-',
      'bytes=a-b',
      'bytes=+1-2',
      'bytes=1.5-2',
      'bytes=-1-2',
      'items=0-1',
      'Bytes=0-1',
      'bytes 0-1',
      'bytes=0x10-20',
      'bytes==0-1',
    ]) {
      expect(parseRange(h, P), h).toEqual({ kind: 'full' });
    }
  });

  it('P = 0 con cualquier Range válido → 416', () => {
    for (const h of ['bytes=0-0', 'bytes=0-', 'bytes=-1', 'bytes=5-10']) {
      expect(parseRange(h, 0), h).toEqual({ kind: 'unsatisfiable' });
    }
    expect(parseRange(null, 0)).toEqual({ kind: 'full' });
    expect(parseRange('bytes=5-1', 0)).toEqual({ kind: 'full' }); // inválido: se ignora
  });

  it('a ≥ P → 416', () => {
    expect(parseRange('bytes=1000-', P)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=1000-2000', P)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange(`bytes=${'9'.repeat(25)}-`, P)).toEqual({ kind: 'unsatisfiable' });
  });

  it('bytes=-0 → 416', () => {
    expect(parseRange('bytes=-0', P)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=-000', P)).toEqual({ kind: 'unsatisfiable' });
  });

  it('ceros a la izquierda son enteros decimales válidos', () => {
    expect(parseRange('bytes=010-020', P)).toEqual({ kind: 'partial', start: 10, end: 20 });
  });

  it('tamaño inválido es un error de programación', () => {
    expect(() => parseRange(null, -1)).toThrow(RangeError);
    expect(() => parseRange(null, 1.5)).toThrow(RangeError);
  });
});

describe('Content-Range', () => {
  it('206 y 416', () => {
    expect(contentRange(10, 99, 1000)).toBe('bytes 10-99/1000');
    expect(unsatisfiedRange(1000)).toBe('bytes */1000');
    expect(unsatisfiedRange(0)).toBe('bytes */0');
  });
});
