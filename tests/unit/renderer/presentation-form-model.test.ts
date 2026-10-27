// Ajustes de la presentación en la interfaz (PLAN.md notas 173, 175 y 178): los interruptores
// «Transiciones», «Animaciones», «Silenciar vídeos» y «Música de fondo» y los cuatro modos de audio.
import { describe, expect, it } from 'vitest';
import { DEFAULT_PRESENTATION } from '../../../src/shared/presentation';
import type { AudioMode, PresentationSettings } from '../../../src/shared/types';
import { audioPlan } from '../../../src/renderer/src/screens/presentation/audio-graph';
import {
  appendTracks,
  audioSettingsOf,
  clampSlideMs,
  clampTransitionMs,
  describeAudio,
  formatSeconds,
  musicDuringVideo,
  schedulerSettingsOf,
  setMusicDuringVideo,
  setTransitionsOn,
  setVideosSilenced,
  toggleRandomKind,
  videosSilenced,
} from '../../../src/renderer/src/screens/presentation/presentation-form-model';

const base: PresentationSettings = {
  ...DEFAULT_PRESENTATION,
  randomPool: [...DEFAULT_PRESENTATION.randomPool],
  trackIds: [],
};

describe('transiciones', () => {
  it('apagarlas deja `none`; encenderlas devuelve la última elegida o el fundido', () => {
    expect(setTransitionsOn(base, false)).toEqual({ transition: 'none' });
    const off = { ...base, transition: 'none' as const };
    expect(setTransitionsOn(off, true, 'zoom')).toEqual({ transition: 'zoom' });
    expect(setTransitionsOn(off, true)).toEqual({ transition: 'fade' });
    expect(setTransitionsOn(off, true, 'none')).toEqual({ transition: 'fade' });
    // Ya encendidas: no cambia nada.
    expect(setTransitionsOn(base, true, 'zoom')).toEqual({});
  });

  it('el grupo aleatorio nunca se queda vacío y conserva el orden de los tipos', () => {
    expect(toggleRandomKind(['fade'], 'fade')).toEqual(['fade']);
    expect(toggleRandomKind(['fade', 'zoom'], 'fade')).toEqual(['zoom']);
    expect(toggleRandomKind(['zoom'], 'fade')).toEqual(['fade', 'zoom']);
    expect(toggleRandomKind(['kenburns'], 'slide')).toEqual(['slide', 'kenburns']);
  });
});

describe('tiempos', () => {
  it('la duración de la foto va en pasos de 500 ms entre 1 y 60 s', () => {
    expect(clampSlideMs(0)).toBe(1000);
    expect(clampSlideMs(1230)).toBe(1000);
    expect(clampSlideMs(1300)).toBe(1500);
    expect(clampSlideMs(999_999)).toBe(60_000);
  });
  it('la duración de la transición va en pasos de 100 ms hasta 3 s', () => {
    expect(clampTransitionMs(-5)).toBe(0);
    expect(clampTransitionMs(749)).toBe(700);
    expect(clampTransitionMs(10_000)).toBe(3000);
  });
  it('formatSeconds usa coma decimal', () => {
    expect(formatSeconds(5000)).toBe('5 s');
    expect(formatSeconds(2500)).toBe('2,5 s');
    expect(formatSeconds(300)).toBe('0,3 s');
  });
});

describe('audio: «Silenciar vídeos» + «Música de fondo» + mantener la música', () => {
  const MODES: AudioMode[] = ['video', 'music', 'both', 'mute'];

  it('los cuatro modos salen de las dos casillas y vuelven a ellas', () => {
    for (const mode of MODES) {
      const silenced = videosSilenced({ audioMode: mode });
      const keep = musicDuringVideo({ audioMode: mode });
      let rebuilt: AudioMode = 'video';
      rebuilt = setVideosSilenced(rebuilt, silenced);
      rebuilt = setMusicDuringVideo(rebuilt, keep);
      expect(rebuilt).toBe(mode);
    }
  });

  it('por defecto (`video`): suena el vídeo y la música baja durante él', () => {
    expect(videosSilenced(base)).toBe(false);
    expect(musicDuringVideo(base)).toBe(false);
    expect(audioPlan(base.audioMode, 'video', true)).toEqual({
      music: 'silent',
      videoAudio: 'sound',
    });
  });

  it('las cuatro combinaciones del usuario (D16) suenan como dice el anexo', () => {
    // Solo el audio del vídeo, solo la música, los dos y silencio total.
    const cases: [AudioMode, boolean, 'sound' | 'silent', 'sound' | 'silent'][] = [
      ['video', false, 'silent', 'sound'],
      ['music', true, 'sound', 'silent'],
      ['both', true, 'sound', 'sound'],
      ['mute', false, 'silent', 'silent'],
    ];
    for (const [mode, musicEnabled, music, videoAudio] of cases) {
      expect(audioPlan(mode, 'video', musicEnabled)).toEqual({ music, videoAudio });
    }
  });

  it('silenciar los vídeos conserva si la música sigue durante ellos', () => {
    expect(setVideosSilenced('both', true)).toBe('music');
    expect(setVideosSilenced('video', true)).toBe('mute');
    expect(setVideosSilenced('mute', false)).toBe('video');
    expect(setMusicDuringVideo('video', true)).toBe('both');
    expect(setMusicDuringVideo('music', false)).toBe('mute');
  });

  it('describeAudio dice qué se oye durante un vídeo', () => {
    expect(describeAudio({ audioMode: 'video', musicEnabled: false })).toMatch(/solo el vídeo/);
    expect(describeAudio({ audioMode: 'video', musicEnabled: true })).toMatch(/la música baja/);
    expect(describeAudio({ audioMode: 'both', musicEnabled: true })).toMatch(/vídeo y la música/);
    expect(describeAudio({ audioMode: 'music', musicEnabled: true })).toMatch(/solo la música/);
    expect(describeAudio({ audioMode: 'mute', musicEnabled: false })).toMatch(/no suena nada/i);
  });
});

describe('hacia el motor', () => {
  it('«Animaciones» llega al planificador como Ken Burns y el movimiento reducido pasa tal cual', () => {
    expect(schedulerSettingsOf(base, false)).toMatchObject({
      transition: 'fade',
      transitionMs: 700,
      slideMs: 5000,
      loop: true,
      kenBurns: true,
      reducedMotion: false,
    });
    expect(schedulerSettingsOf({ ...base, animations: false }, true)).toMatchObject({
      kenBurns: false,
      reducedMotion: true,
    });
  });

  it('el audio lleva modo, música, volúmenes y fundido', () => {
    expect(audioSettingsOf(base)).toEqual({
      audioMode: 'video',
      musicEnabled: false,
      musicVolume: 0.7,
      videoVolume: 1,
      musicFadeMs: 1500,
    });
  });
});

describe('pistas', () => {
  it('appendTracks añade las nuevas al final, sin repetir y sin pasar del máximo', () => {
    expect(appendTracks(['a'], ['b', 'a', 'c'])).toEqual(['a', 'b', 'c']);
    expect(appendTracks(['a', 'b'], ['c', 'd'], 3)).toEqual(['a', 'b', 'c']);
  });
});
