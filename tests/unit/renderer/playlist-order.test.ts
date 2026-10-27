// Lógica pura de las playlists en la UI (docs/DESIGN.md §14.8, PLAN.md 4.4): mover elementos (arrastre
// y Alt+↑/↓), anuncios en español para el lector de pantalla, validación del nombre, marcar pistas, el
// filtro de la galería por playlist y los textos de «Añadir a playlist».
import { describe, expect, it } from 'vitest';
import {
  announceMoved,
  moveId,
  moveIndex,
  playlistNameProblem,
  reorderAnnouncements,
  sameOrder,
  toggleTrack,
} from '@renderer/screens/playlists/playlist-order';
import { previewStartSeconds, PREVIEW_MS } from '@renderer/screens/settings/music-preview';
import { buildQuery, NO_FILTERS } from '@renderer/stores/library-store';
import { addedMessage, plural } from '@renderer/stores/playlists-store';

describe('moveId (Alt+↑/↓)', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('sube y baja una posición', () => {
    expect(moveId(ids, 'c', -1)).toEqual({ ids: ['a', 'c', 'b', 'd'], from: 2, to: 1 });
    expect(moveId(ids, 'b', 1)).toEqual({ ids: ['a', 'c', 'b', 'd'], from: 1, to: 2 });
  });

  it('se queda en los extremos', () => {
    expect(moveId(ids, 'a', -1)).toEqual({ ids, from: 0, to: 0 });
    expect(moveId(ids, 'd', 1)).toEqual({ ids, from: 3, to: 3 });
  });

  it('un id desconocido no cambia nada', () => {
    expect(moveId(ids, 'z', 1)).toEqual({ ids, from: -1, to: -1 });
  });

  it('no modifica la lista original y conserva la permutación', () => {
    const copy = [...ids];
    const moved = moveId(ids, 'a', 3);
    expect(ids).toEqual(copy);
    expect([...moved.ids].sort()).toEqual(copy);
    expect(moved.ids).toEqual(['b', 'c', 'd', 'a']);
  });
});

describe('moveIndex y sameOrder', () => {
  it('mueve de una posición a otra como arrayMove', () => {
    expect(moveIndex(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveIndex(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
    expect(moveIndex(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
  });

  it('compara el orden', () => {
    expect(sameOrder(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameOrder(['a'], ['a', 'b'])).toBe(false);
  });
});

describe('anuncios en español', () => {
  const names: Record<string, string> = { a: 'Playa', b: 'Montaña', c: 'Ciudad' };
  const order = ['a', 'b', 'c'];
  const announcements = reorderAnnouncements({
    nameOf: (id) => names[id] ?? '?',
    order: () => order,
  });

  it('levantar, pasar por encima, soltar y cancelar dicen la posición de N', () => {
    expect(announcements.onDragStart({ active: { id: 'b' } })).toBe(
      'Elemento «Montaña» levantado, posición 2 de 3.',
    );
    // Sobre sí mismo (justo tras levantar): sin anuncio, para no tapar el de «levantado».
    expect(announcements.onDragOver({ active: { id: 'b' }, over: { id: 'b' } })).toBeUndefined();
    expect(announcements.onDragOver({ active: { id: 'b' }, over: { id: 'c' } })).toBe(
      '«Montaña» está sobre la posición 3 de 3.',
    );
    expect(announcements.onDragEnd({ active: { id: 'b' }, over: { id: 'a' } })).toBe(
      '«Montaña» soltado en la posición 1 de 3.',
    );
    expect(announcements.onDragEnd({ active: { id: 'b' }, over: null })).toBe(
      '«Montaña» soltado sin cambios.',
    );
    expect(announcements.onDragCancel({ active: { id: 'c' } })).toBe(
      'Movimiento cancelado. «Ciudad» vuelve a la posición 3 de 3.',
    );
  });

  it('Alt+↑/↓ anuncia el movimiento o que ya está en el extremo', () => {
    expect(announceMoved('Playa', 1, 3, true)).toBe('«Playa» movido a la posición 2 de 3.');
    expect(announceMoved('Playa', 0, 3, false)).toBe(
      '«Playa» ya está en la posición 1 de 3; no se puede mover más.',
    );
  });
});

describe('nombre de la playlist', () => {
  it('acepta 1–100 caracteres sin control, tras NFC y trim', () => {
    expect(playlistNameProblem('Vacaciones')).toBeNull();
    expect(playlistNameProblem('  Vacaciones  ')).toBeNull();
    expect(playlistNameProblem('a'.repeat(100))).toBeNull();
    expect(playlistNameProblem('😀'.repeat(100))).toBeNull();
  });

  it('rechaza vacío, demasiado largo y caracteres de control', () => {
    expect(playlistNameProblem('')).toMatch(/nombre/i);
    expect(playlistNameProblem('   ')).toMatch(/nombre/i);
    expect(playlistNameProblem('a'.repeat(101))).toMatch(/100/);
    expect(playlistNameProblem('a\u0007b')).toMatch(/control/);
  });
});

describe('música de la playlist', () => {
  it('toggleTrack añade al final o quita, conservando el orden de marcado', () => {
    expect(toggleTrack([], 'x')).toEqual(['x']);
    expect(toggleTrack(['x'], 'y')).toEqual(['x', 'y']);
    expect(toggleTrack(['x', 'y', 'z'], 'y')).toEqual(['x', 'z']);
  });

  it('el fragmento de la vista previa empieza hacia el 30 % sin pasarse del final', () => {
    expect(previewStartSeconds(null)).toBe(0);
    expect(previewStartSeconds(PREVIEW_MS)).toBe(0);
    expect(previewStartSeconds(100_000)).toBe(30);
    // 12 s: el 30 % sería 3,6 s, pero 3,6 + 10 pasa del final: empieza a los 2 s.
    expect(previewStartSeconds(12_000)).toBe(2);
  });
});

describe('filtro de la galería por playlist', () => {
  const sort = { field: 'captured', dir: 'desc' } as const;
  const ID = 'a'.repeat(32);

  it('sin playlist no añade nada', () => {
    expect(buildQuery('all', NO_FILTERS, sort)).toEqual({ kind: 'all', sort });
  });

  it('con playlist y su orden usa position ascendente (no se guarda en prefs)', () => {
    const q = buildQuery('all', { ...NO_FILTERS, playlistId: ID, playlistOrder: true }, sort);
    expect(q).toEqual({ kind: 'all', playlistId: ID, sort: { field: 'position', dir: 'asc' } });
  });

  it('con playlist pero otro orden conserva el orden elegido', () => {
    const q = buildQuery('photo', { ...NO_FILTERS, playlistId: ID }, sort);
    expect(q).toEqual({ kind: 'photo', playlistId: ID, sort });
  });
});

describe('textos de «Añadir a playlist»', () => {
  it('singular, plural y los que ya estaban', () => {
    expect(addedMessage('Viaje', 1, 0)).toBe('Se añadió 1 elemento a «Viaje».');
    expect(addedMessage('Viaje', 3, 0)).toBe('Se añadieron 3 elementos a «Viaje».');
    expect(addedMessage('Viaje', 2, 1)).toBe('Se añadieron 2 elementos a «Viaje». 1 ya estaba.');
    expect(addedMessage('Viaje', 2, 4)).toBe('Se añadieron 2 elementos a «Viaje». 4 ya estaban.');
    expect(addedMessage('Viaje', 0, 1)).toBe('Ese elemento ya estaba en «Viaje».');
    expect(addedMessage('Viaje', 0, 5)).toBe('Esos 5 elementos ya estaban en «Viaje».');
  });

  it('plural()', () => {
    expect(plural(1, 'playlist', 'playlists')).toBe('1 playlist');
    expect(plural(0, 'playlist', 'playlists')).toBe('0 playlists');
  });
});
