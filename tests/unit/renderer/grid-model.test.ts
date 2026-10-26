// Modelo de la rejilla de la galería (docs/DESIGN.md §14.6): filas por mes, columnas y navegación.
import { describe, expect, it } from 'vitest';
import { buildGrid, columnsFor, moveFocus } from '@renderer/screens/gallery/grid-model';

const naive = (y: number, m: number, d = 1): number => Date.UTC(y, m - 1, d, 12, 0, 0);
const item = (capturedAt: number, importedAt = capturedAt) => ({ capturedAt, importedAt });

describe('columnsFor', () => {
  it('floor((ancho + gap) / (tamaño + gap)) y al menos una', () => {
    expect(columnsFor(1000, 180, 4)).toBe(5); // 1004 / 184
    expect(columnsFor(1000, 120, 8)).toBe(7); // 1008 / 128
    expect(columnsFor(100, 260, 4)).toBe(1);
    expect(columnsFor(0, 180, 4)).toBe(1);
    expect(columnsFor(Number.NaN, 180, 4)).toBe(1);
  });
});

describe('buildGrid', () => {
  it('con orden por fecha, una cabecera por mes y los mosaicos en filas de `cols`', () => {
    const items = [
      item(naive(2026, 10, 20)),
      item(naive(2026, 10, 3)),
      item(naive(2026, 10, 1)),
      item(naive(2026, 9, 30)),
      item(naive(2025, 12, 31)),
    ];
    const { rows, rowOfItem } = buildGrid(items, 2, 'captured');
    expect(rows.map((r) => (r.kind === 'header' ? r.label : `${r.start}+${r.count}`))).toEqual([
      'octubre de 2026',
      '0+2',
      '2+1',
      'septiembre de 2026',
      '3+1',
      'diciembre de 2025',
      '4+1',
    ]);
    expect(Array.from(rowOfItem)).toEqual([1, 1, 2, 4, 6]);
  });

  it('la fecha de captura usa la hora de pared: un 31 a las 23:30 sigue en su mes', () => {
    const { rows } = buildGrid([item(Date.UTC(2026, 0, 31, 23, 30))], 4, 'captured');
    expect(rows[0]).toMatchObject({ kind: 'header', label: 'enero de 2026' });
  });

  it('sin agrupar es una lista plana, sin cabeceras', () => {
    const { rows } = buildGrid([item(1), item(2), item(3), item(4), item(5)], 3, null);
    expect(rows).toEqual([
      { kind: 'tiles', key: 't0', start: 0, count: 3 },
      { kind: 'tiles', key: 't3', start: 3, count: 2 },
    ]);
  });

  it('una lista vacía no tiene filas', () => {
    expect(buildGrid([], 3, 'captured').rows).toEqual([]);
    expect(buildGrid([], 3, null).rowOfItem.length).toBe(0);
  });
});

describe('moveFocus', () => {
  // Dos meses: [0 1 2 | 3 4] y [5 6 7 | 8]; 3 columnas.
  const items = [
    ...[1, 2, 3, 4, 5].map((d) => item(naive(2026, 10, 30 - d))),
    ...[1, 2, 3, 4].map((d) => item(naive(2026, 9, 30 - d))),
  ];
  const model = buildGrid(items, 3, 'captured');

  it('izquierda y derecha se paran en los extremos', () => {
    expect(moveFocus(model, 0, 'ArrowLeft')).toBe(0);
    expect(moveFocus(model, 0, 'ArrowRight')).toBe(1);
    expect(moveFocus(model, 8, 'ArrowRight')).toBe(8);
  });

  it('arriba y abajo conservan la columna, cruzan cabeceras y se recortan en filas cortas', () => {
    expect(moveFocus(model, 1, 'ArrowDown')).toBe(4);
    expect(moveFocus(model, 2, 'ArrowDown')).toBe(4); // la fila 3-4 solo llega a la columna 1
    expect(moveFocus(model, 4, 'ArrowDown')).toBe(6); // salta la cabecera de septiembre
    expect(moveFocus(model, 6, 'ArrowUp')).toBe(4);
    expect(moveFocus(model, 0, 'ArrowUp')).toBe(0);
    expect(moveFocus(model, 8, 'ArrowDown')).toBe(8);
  });

  it('Home/End van a los extremos de la fila y con Ctrl a los de todo', () => {
    expect(moveFocus(model, 1, 'Home')).toBe(0);
    expect(moveFocus(model, 1, 'End')).toBe(2);
    expect(moveFocus(model, 4, 'End')).toBe(4);
    expect(moveFocus(model, 4, 'Home')).toBe(3);
    expect(moveFocus(model, 4, 'Home', { ctrl: true })).toBe(0);
    expect(moveFocus(model, 1, 'End', { ctrl: true })).toBe(8);
  });

  it('RePág y AvPág avanzan por páginas de filas de mosaicos', () => {
    expect(moveFocus(model, 0, 'PageDown', { pageRows: 2 })).toBe(5);
    expect(moveFocus(model, 0, 'PageDown', { pageRows: 99 })).toBe(8);
    expect(moveFocus(model, 8, 'PageUp', { pageRows: 99 })).toBe(0);
  });

  it('sin elementos no hay foco', () => {
    expect(moveFocus(buildGrid([], 3, null), 0, 'ArrowDown')).toBe(-1);
  });
});
