// Capas del escenario de la presentación (docs/DESIGN.md §17.5): una por diapositiva, un hueco del
// pool de 3 <video> para cada vídeo, que se libera al quitar la capa.
import { describe, expect, it, vi } from 'vitest';
import type { MediaListItem } from '../../../src/shared/types';
import { StageModel } from '../../../src/renderer/src/screens/presentation/stage-model';

function item(i: number, kind: 'photo' | 'video'): MediaListItem {
  return {
    id: i.toString(16).padStart(32, '0'),
    kind,
    name: `m${i}`,
    ext: kind === 'photo' ? 'jpg' : 'mp4',
    capturedAt: 0,
    importedAt: 0,
    sizeBytes: 1,
    durationMs: kind === 'video' ? 1000 : null,
    width: 10,
    height: 10,
    thumbRev: 0,
  };
}

const ITEMS = [
  item(0, 'photo'),
  item(1, 'video'),
  item(2, 'video'),
  item(3, 'video'),
  item(4, 'video'),
  item(5, 'photo'),
];

describe('StageModel', () => {
  it('una foto no usa hueco; cada vídeo se queda con uno distinto', () => {
    const m = new StageModel(ITEMS);
    expect(m.add(0, null)?.slot).toBeNull();
    expect(m.add(1, null)?.slot).toBe(0);
    expect(m.add(2, null)?.slot).toBe(1);
    expect(m.slotOf(1)).toBe(0);
    expect(m.slotOf(0)).toBeNull();
  });

  it('con los 3 huecos en uso, un cuarto vídeo no se crea; quitar una capa libera el hueco', () => {
    const m = new StageModel(ITEMS);
    m.add(1, null);
    m.add(2, null);
    m.add(3, null);
    expect(m.freeSlot()).toBeNull();
    expect(m.add(4, null)).toBeNull();
    expect(m.has(4)).toBe(false);
    m.remove(2);
    expect(m.freeSlot()).toBe(1);
    expect(m.add(4, null)?.slot).toBe(1);
  });

  it('añadir dos veces la misma diapositiva devuelve la que había', () => {
    const m = new StageModel(ITEMS);
    const a = m.add(1, null);
    expect(m.add(1, null)).toBe(a);
    expect(m.getSnapshot()).toHaveLength(1);
  });

  it('un índice fuera de la secuencia no crea nada', () => {
    const m = new StageModel(ITEMS);
    expect(m.add(99, null)).toBeNull();
  });

  it('empieza oculta y lista = false; patch cambia papel y estado', () => {
    const m = new StageModel(ITEMS);
    expect(m.add(0, null)).toMatchObject({ role: 'preload', ready: false });
    m.patch(0, { ready: true, role: 'entering' });
    expect(m.get(0)).toMatchObject({ role: 'entering', ready: true });
    expect(m.patch(7, { ready: true })).toBeUndefined();
  });

  it('getSnapshot es estable entre cambios, va ordenado por índice y avisa a los oyentes', () => {
    const m = new StageModel(ITEMS);
    const listener = vi.fn();
    const off = m.subscribe(listener);
    m.add(5, null);
    m.add(0, null);
    const first = m.getSnapshot();
    expect(first.map((e) => e.index)).toEqual([0, 5]);
    expect(m.getSnapshot()).toBe(first);
    expect(listener).toHaveBeenCalledTimes(2);
    m.patch(0, { ready: true });
    expect(m.getSnapshot()).not.toBe(first);
    off();
    m.remove(0);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('clear quita todas las capas y libera todos los huecos', () => {
    const m = new StageModel(ITEMS);
    m.add(1, null);
    m.add(2, null);
    m.add(0, null);
    m.clear();
    expect(m.getSnapshot()).toEqual([]);
    expect(m.freeSlot()).toBe(0);
  });
});
