// Partes puras de la pantalla de vídeo dual y el diálogo de fusión (docs/PLAN.md 5.4, docs/DESIGN.md
// §18.1, §18.2 y §18.7): valores por defecto, resolución de salida, mensajes de error, la búsqueda del
// selector «Elegir vídeo…» y la regla de «Vídeo dual» de la barra de selección.
import { describe, expect, it } from 'vitest';
import type { AppError } from '@shared/errors';
import type { MediaListItem } from '@shared/types';
import {
  defaultMergeAudio,
  defaultMergeName,
  formatSize,
  isMergeAudioAvailable,
  MERGE_AUDIO_OPTIONS,
  MERGE_BUSY_MESSAGE,
  mergeErrorMessage,
  mergeOutputSize,
  mergeResolutionOptions,
  percentOf,
  resolutionOfChoice,
} from '@renderer/screens/dual/merge-model';
import { filterVideos, normalizeSearch, PICKER_LIMIT } from '@renderer/screens/dual/picker-model';
import { dualPair, DUAL_NEEDS_TWO } from '@renderer/screens/gallery/dual-pair';

const item = (id: string, kind: 'photo' | 'video', name = id): MediaListItem => ({
  id,
  kind,
  name,
  ext: kind === 'video' ? 'mp4' : 'jpg',
  capturedAt: 0,
  importedAt: 0,
  sizeBytes: 1,
  durationMs: kind === 'video' ? 1000 : null,
  width: 10,
  height: 10,
  thumbRev: 0,
});

describe('valores por defecto de la fusión (§18.1)', () => {
  it('el nombre es "Fusión AAAA-MM-DD HH.mm" con la hora local y con ceros a la izquierda', () => {
    expect(defaultMergeName(new Date(2026, 9, 28, 14, 5))).toBe('Fusión 2026-10-28 14.05');
    expect(defaultMergeName(new Date(2026, 0, 3, 0, 0))).toBe('Fusión 2026-01-03 00.00');
  });

  it('audio: mezcla si los dos tienen; si no, el que lo tenga; si ninguno, ninguno', () => {
    expect(defaultMergeAudio(true, true)).toBe('mix');
    expect(defaultMergeAudio(true, false)).toBe('left');
    expect(defaultMergeAudio(false, true)).toBe('right');
    expect(defaultMergeAudio(false, false)).toBe('none');
    // Se desconoce (null) cuenta como con audio: main rechaza la opción si de verdad no lo tiene.
    expect(defaultMergeAudio(null, null)).toBe('mix');
    expect(defaultMergeAudio(null, false)).toBe('left');
  });

  it('las opciones sin audio de origen están deshabilitadas; "Ninguno" siempre vale', () => {
    expect(MERGE_AUDIO_OPTIONS.map((o) => o.value)).toEqual(['left', 'right', 'mix', 'none']);
    expect(MERGE_AUDIO_OPTIONS.map((o) => o.label)).toEqual([
      'Izquierdo',
      'Derecho',
      'Mezcla',
      'Ninguno',
    ]);
    expect(isMergeAudioAvailable('left', false, true)).toBe(false);
    expect(isMergeAudioAvailable('right', false, true)).toBe(true);
    expect(isMergeAudioAvailable('mix', false, true)).toBe(true);
    expect(isMergeAudioAvailable('mix', false, false)).toBe(false);
    expect(isMergeAudioAvailable('none', false, false)).toBe(true);
  });
});

describe('mergeOutputSize (misma fórmula que merge-service.ts)', () => {
  it('altura común par ≤ 1080 y anchos escalados con scale=-2:H', () => {
    // 320×180 + 240×180 → 560×180 (el caso de 5.1).
    expect(mergeOutputSize({ width: 320, height: 180 }, { width: 240, height: 180 })).toEqual({
      width: 560,
      height: 180,
    });
    // La menor altura manda: 640×360 y 320×180 → H = 180; el primero se escala a 320.
    expect(mergeOutputSize({ width: 640, height: 360 }, { width: 320, height: 180 })).toEqual({
      width: 640,
      height: 180,
    });
    // Tope de 1080 y alturas impares → par.
    expect(mergeOutputSize({ width: 3840, height: 2160 }, { width: 3840, height: 2160 })).toEqual({
      width: 3840,
      height: 1080,
    });
    expect(mergeOutputSize({ width: 100, height: 101 }, { width: 100, height: 101 })?.height).toBe(
      100,
    );
    // Vertical: 160×120 rotado → 120×160 junto a 120×160.
    expect(mergeOutputSize({ width: 120, height: 160 }, { width: 120, height: 160 })).toEqual({
      width: 240,
      height: 160,
    });
  });

  it('el ancho de cada lado es par y redondea al más cercano', () => {
    // H = 100: 333×200 → 166,5 → 83·2 = 166 (par); 100×100 → 100.
    expect(mergeOutputSize({ width: 333, height: 200 }, { width: 100, height: 100 })).toEqual({
      width: 266,
      height: 100,
    });
  });

  it('sin dimensiones (o con ceros) no hay resolución', () => {
    expect(mergeOutputSize(null, { width: 10, height: 10 })).toBeNull();
    expect(mergeOutputSize({ width: 10, height: 10 }, { width: null, height: null })).toBeNull();
    expect(mergeOutputSize({ width: 0, height: 10 }, { width: 10, height: 10 })).toBeNull();
    expect(mergeOutputSize({ width: 10, height: 1 }, { width: 10, height: 10 })).toBeNull();
  });

  it('con una resolución elegida, los dos lados se escalan a esa altura', () => {
    const l = { width: 320, height: 180 };
    const r = { width: 240, height: 180 };
    expect(mergeOutputSize(l, r, 'auto')).toEqual({ width: 560, height: 180 });
    expect(mergeOutputSize(l, r, 360)).toEqual({ width: 1120, height: 360 });
    expect(mergeOutputSize(l, r, 1080)).toEqual({ width: 3360, height: 1080 });
    expect(mergeOutputSize(null, r, 720)).toBeNull();
  });

  it('opciones de resolución: Automática (recomendada) y 360/480/720/1080; amplía lo que pasa del más alto', () => {
    const labels = (lh: number, rh: number): string[] =>
      mergeResolutionOptions({ height: lh }, { height: rh }).map((o) => o.label);
    expect(mergeResolutionOptions({ height: 180 }, { height: 180 }).map((o) => o.value)).toEqual([
      'auto',
      '360',
      '480',
      '720',
      '1080',
    ]);
    expect(labels(180, 180)).toEqual([
      'Automática (recomendada)',
      '360 px (amplía la imagen)',
      '480 px (amplía la imagen)',
      '720 px (amplía la imagen)',
      '1080 px (amplía la imagen)',
    ]);
    // El más alto manda: con 480 y 360 de alto, 480 no amplía.
    expect(labels(360, 480)).toEqual([
      'Automática (recomendada)',
      '360 px',
      '480 px',
      '720 px (amplía la imagen)',
      '1080 px (amplía la imagen)',
    ]);
    expect(labels(2160, 1080).slice(1)).toEqual(['360 px', '480 px', '720 px', '1080 px']);
  });

  it('resolutionOfChoice: auto o la altura como número', () => {
    expect(resolutionOfChoice('auto')).toBe('auto');
    expect(resolutionOfChoice('360')).toBe(360);
    expect(resolutionOfChoice('1080')).toBe(1080);
  });

  it('formatSize y percentOf', () => {
    expect(formatSize({ width: 560, height: 180 })).toBe('560 × 180');
    expect(percentOf(0)).toBe(0);
    expect(percentOf(0.456)).toBe(46);
    expect(percentOf(1)).toBe(100);
    expect(percentOf(2)).toBe(100);
    expect(percentOf(-1)).toBe(0);
    expect(percentOf(Number.NaN)).toBe(0);
  });
});

describe('mergeErrorMessage (tabla de §18.7)', () => {
  const err = (code: AppError['code'], reason?: string): AppError =>
    reason === undefined ? { code } : { code, details: { reason } };

  it('BUSY → hay otra fusión en curso', () => {
    expect(mergeErrorMessage(err('BUSY'))).toBe(MERGE_BUSY_MESSAGE);
    expect(MERGE_BUSY_MESSAGE).toContain('fusión en curso');
  });

  it('VALIDATION con motivo conocido, y genérico sin él', () => {
    expect(mergeErrorMessage(err('VALIDATION', 'same-video'))).toBe('Elige dos vídeos distintos.');
    expect(mergeErrorMessage(err('VALIDATION', 'not-ready'))).toContain('ya no está disponible');
    expect(mergeErrorMessage(err('VALIDATION', 'not-video'))).toContain('vídeos');
    expect(mergeErrorMessage(err('VALIDATION', 'audio'))).toContain('no tiene audio');
    expect(mergeErrorMessage(err('VALIDATION', 'mime'))).toContain('formato');
    expect(mergeErrorMessage(err('VALIDATION', 'metadata'))).toContain('Faltan datos');
    expect(mergeErrorMessage(err('VALIDATION', 'otra-cosa'))).toContain('no es válido');
    expect(mergeErrorMessage(err('VALIDATION'))).toContain('no es válido');
  });

  it('el resto de códigos de §18.7 tienen su mensaje en español', () => {
    expect(mergeErrorMessage(err('FFMPEG_MISSING'))).toContain('Falta el componente de vídeo');
    expect(mergeErrorMessage(err('FFMPEG_FAILED'))).toContain('No se pudo crear');
    expect(mergeErrorMessage(err('DISK_FULL'))).toContain('espacio');
    expect(mergeErrorMessage(err('INTEGRITY'))).toContain('verificación');
    expect(mergeErrorMessage(err('CANCELLED'))).toBe('Fusión cancelada.');
  });

  it('otros códigos usan el mensaje general; ninguno está vacío ni muestra el código', () => {
    for (const code of ['LOCKED', 'IO', 'NOT_FOUND', 'INTERNAL'] as const) {
      const message = mergeErrorMessage(err(code));
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toContain(code);
    }
  });
});

describe('selector «Elegir vídeo…»', () => {
  it('normalizeSearch ignora mayúsculas y acentos', () => {
    expect(normalizeSearch('Vídeo ÁÉÍ Ñandú')).toBe('video aei nandu');
  });

  it('filterVideos: vacío devuelve todo; si no, los que contienen la búsqueda', () => {
    const items = [item('a', 'video', 'Vídeo de la playa'), item('b', 'video', 'Cumpleaños')];
    expect(filterVideos(items, '')).toHaveLength(2);
    expect(filterVideos(items, '   ')).toHaveLength(2);
    expect(filterVideos(items, 'VIDEO').map((i) => i.id)).toEqual(['a']);
    expect(filterVideos(items, 'cumple').map((i) => i.id)).toEqual(['b']);
    expect(filterVideos(items, 'zzz')).toEqual([]);
    expect(PICKER_LIMIT).toBeGreaterThan(20);
  });
});

describe('«Vídeo dual» en la barra de selección', () => {
  const items = [
    item('v1', 'video'),
    item('p1', 'photo'),
    item('v2', 'video'),
    item('v3', 'video'),
  ];

  it('solo con EXACTAMENTE dos vídeos, el primero (en el orden de la galería) a la izquierda', () => {
    expect(dualPair(items, new Set(['v3', 'v1']))?.map((i) => i.id)).toEqual(['v1', 'v3']);
    expect(dualPair(items, new Set(['v2', 'v3']))?.map((i) => i.id)).toEqual(['v2', 'v3']);
  });

  it('ninguno, uno o tres elementos → null', () => {
    expect(dualPair(items, new Set())).toBeNull();
    expect(dualPair(items, new Set(['v1']))).toBeNull();
    expect(dualPair(items, new Set(['v1', 'v2', 'v3']))).toBeNull();
  });

  it('con una foto entre los dos → null', () => {
    expect(dualPair(items, new Set(['v1', 'p1']))).toBeNull();
  });

  it('con un id que ya no está en la lista → null', () => {
    expect(dualPair(items, new Set(['v1', 'zz']))).toBeNull();
  });

  it('el aviso explica la regla', () => {
    expect(DUAL_NEEDS_TWO).toBe('Selecciona exactamente dos vídeos.');
  });
});
