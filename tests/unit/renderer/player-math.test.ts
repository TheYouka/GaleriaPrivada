// Cálculos del reproductor de vídeo (docs/DESIGN.md §16.6, PLAN.md 3.6): velocidades, volumen,
// saltos, rangos cargados, duración de respaldo, mensajes de error y visibilidad de los controles.
import { describe, expect, it, vi } from 'vitest';
import {
  bufferedSegments,
  controlsVisible,
  effectiveDuration,
  formatSpeed,
  fromBarValue,
  seekTime,
  SPEEDS,
  stepSpeed,
  stepVolume,
  toBarValue,
  VIDEO_DAMAGED_MESSAGE,
  VIDEO_ERROR_MESSAGE,
  videoErrorMessage,
} from '@renderer/screens/player/player-math';

describe('velocidad', () => {
  it('va de 0,25× a 2× en ocho pasos y se queda en los extremos', () => {
    expect(SPEEDS).toEqual([0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
    expect(stepSpeed(1, 1)).toBe(1.25);
    expect(stepSpeed(1, -1)).toBe(0.75);
    expect(stepSpeed(2, 1)).toBe(2);
    expect(stepSpeed(0.25, -1)).toBe(0.25);
  });

  it('un valor fuera de la lista se acerca al paso más cercano', () => {
    expect(stepSpeed(1.1, 1)).toBe(1.25);
    expect(stepSpeed(1.4, -1)).toBe(1.25);
  });

  it('se escribe en español', () => {
    expect(formatSpeed(0.25)).toBe('0,25×');
    expect(formatSpeed(1)).toBe('1×');
    expect(formatSpeed(1.75)).toBe('1,75×');
  });
});

describe('volumen', () => {
  it('±5 % sin arrastrar error de coma flotante y dentro de [0, 1]', () => {
    expect(stepVolume(0.7, 1)).toBe(0.75);
    expect(stepVolume(0.75, -1)).toBe(0.7);
    expect(stepVolume(1, 1)).toBe(1);
    expect(stepVolume(0, -1)).toBe(0);
    let v = 0;
    for (let i = 0; i < 20; i += 1) v = stepVolume(v, 1);
    expect(v).toBe(1);
  });
});

describe('saltos y duración', () => {
  it('seekTime queda dentro de [0, duración]', () => {
    expect(seekTime(5, 10, 100)).toBe(15);
    expect(seekTime(5, -10, 100)).toBe(0);
    expect(seekTime(95, 10, 100)).toBe(100);
    expect(seekTime(5, 10, 0)).toBe(15); // sin duración conocida
  });

  it('effectiveDuration usa la de la DB si la del vídeo no es finita (§18.4)', () => {
    expect(effectiveDuration(12.5, 99_000)).toBe(12.5);
    expect(effectiveDuration(Number.POSITIVE_INFINITY, 4_000)).toBe(4);
    expect(effectiveDuration(Number.NaN, 4_000)).toBe(4);
    expect(effectiveDuration(Number.NaN, null)).toBe(0);
    expect(effectiveDuration(0, 0)).toBe(0);
  });

  it('la barra va de 0 a 1000 y vuelve al mismo tiempo', () => {
    expect(toBarValue(2, 4)).toBe(500);
    expect(toBarValue(9, 4)).toBe(1000);
    expect(toBarValue(1, 0)).toBe(0);
    expect(fromBarValue(500, 4)).toBe(2);
    expect(fromBarValue(2000, 4)).toBe(4);
  });
});

describe('rangos cargados', () => {
  it('los fusiona, los ordena y los acota a la duración', () => {
    const segments = bufferedSegments(
      [
        { start: 50, end: 60 },
        { start: 0, end: 10 },
        { start: 8, end: 20 },
        { start: 90, end: 130 },
      ],
      100,
    );
    expect(segments).toEqual([
      { left: 0, width: 20 },
      { left: 50, width: 10 },
      { left: 90, width: 10 },
    ]);
  });

  it('sin duración o con rangos vacíos no hay segmentos', () => {
    expect(bufferedSegments([{ start: 0, end: 5 }], 0)).toEqual([]);
    expect(bufferedSegments([{ start: 3, end: 3 }], 10)).toEqual([]);
  });
});

describe('errores (§16.6)', () => {
  it('un corte de lectura o de descifrado a mitad dice "archivo dañado"; el resto, el genérico', () => {
    expect(videoErrorMessage(2)).toBe(VIDEO_DAMAGED_MESSAGE);
    expect(videoErrorMessage(3)).toBe(VIDEO_DAMAGED_MESSAGE);
    expect(videoErrorMessage(4)).toBe(VIDEO_ERROR_MESSAGE);
    expect(videoErrorMessage(1)).toBe(VIDEO_ERROR_MESSAGE);
    expect(videoErrorMessage(undefined)).toBe(VIDEO_ERROR_MESSAGE);
    expect(VIDEO_ERROR_MESSAGE).toContain('No se puede reproducir este vídeo');
    expect(VIDEO_DAMAGED_MESSAGE).toContain('dañado');
  });
});

describe('visibilidad de los controles', () => {
  const idle = {
    playing: true,
    recentActivity: false,
    focusWithin: false,
    hovering: false,
    menuOpen: false,
    error: false,
  };

  it('se ocultan solo con el vídeo en marcha y sin actividad, foco, puntero ni menú', () => {
    expect(controlsVisible(idle)).toBe(false);
    expect(controlsVisible({ ...idle, playing: false })).toBe(true);
    expect(controlsVisible({ ...idle, recentActivity: true })).toBe(true);
    expect(controlsVisible({ ...idle, focusWithin: true })).toBe(true);
    expect(controlsVisible({ ...idle, hovering: true })).toBe(true);
    expect(controlsVisible({ ...idle, menuOpen: true })).toBe(true);
    expect(controlsVisible({ ...idle, error: true })).toBe(true);
  });
});

describe('player-store', () => {
  it('avisa a main solo cuando cambia que haya algún vídeo sonando', async () => {
    vi.resetModules();
    const invoke = vi.fn(() => Promise.resolve({ ok: true, data: undefined }));
    vi.doMock('@renderer/lib/ipc', () => ({ invoke }));
    const store = await import('@renderer/stores/player-store');
    store.setPlayerPlaying('a', true);
    store.setPlayerPlaying('a', true); // sin cambio
    store.setPlayerPlaying('b', true); // otro reproductor: el estado global no cambia
    expect(invoke.mock.calls).toEqual([['session:setPlayback', { active: true }]]);
    store.setPlayerPlaying('a', false);
    expect(store.usePlayerStore.getState().playing).toBe(true);
    store.setPlayerPlaying('b', false);
    expect(store.usePlayerStore.getState().playing).toBe(false);
    expect(invoke.mock.calls).toEqual([
      ['session:setPlayback', { active: true }],
      ['session:setPlayback', { active: false }],
    ]);
    vi.doUnmock('@renderer/lib/ipc');
  });

  it('recuerda volumen, silencio y velocidad (solo valores válidos)', async () => {
    vi.resetModules();
    vi.doMock('@renderer/lib/ipc', () => ({ invoke: vi.fn() }));
    const store = await import('@renderer/stores/player-store');
    store.setPlayerVolume(1.5);
    expect(store.usePlayerStore.getState().volume).toBe(1);
    store.setPlayerVolume(0.4);
    store.setPlayerMuted(true);
    store.setPlayerSpeed(1.5);
    store.setPlayerSpeed(3); // fuera del menú: se ignora
    expect(store.usePlayerStore.getState()).toMatchObject({ volume: 0.4, muted: true, speed: 1.5 });
    vi.doUnmock('@renderer/lib/ipc');
  });
});
