// Decisión de audio por diapositiva (docs/DESIGN.md §17.8, tabla `audioPlan`) y las cuatro
// combinaciones de D16 (confirmada la opción (a)): solo el audio del vídeo (por defecto), solo la
// música, los dos a la vez y todo en silencio.
import { describe, expect, it } from 'vitest';
import type { AudioMode } from '../../../src/shared/types';
import {
  audioPlan,
  choiceOfMode,
  directVideoElementState,
  modeOfChoice,
} from '../../../src/renderer/src/screens/presentation/audio-graph';
import { DEFAULT_PRESENTATION } from '../../../src/shared/presentation';

const MODES: AudioMode[] = ['video', 'music', 'both', 'mute'];

describe('audioPlan (tabla de §17.8)', () => {
  it('el modo por defecto es `video`', () => {
    expect(DEFAULT_PRESENTATION.audioMode).toBe('video');
  });

  it('video (por defecto): en las fotos suena la música; en los vídeos, solo el vídeo', () => {
    expect(audioPlan('video', 'photo')).toEqual({ music: 'sound', videoAudio: 'silent' });
    expect(audioPlan('video', 'video')).toEqual({ music: 'silent', videoAudio: 'sound' });
  });

  it('music: en los vídeos sigue la música y el vídeo no suena', () => {
    expect(audioPlan('music', 'photo')).toEqual({ music: 'sound', videoAudio: 'silent' });
    expect(audioPlan('music', 'video')).toEqual({ music: 'sound', videoAudio: 'silent' });
  });

  it('both: en los vídeos suenan los dos', () => {
    expect(audioPlan('both', 'photo')).toEqual({ music: 'sound', videoAudio: 'silent' });
    expect(audioPlan('both', 'video')).toEqual({ music: 'sound', videoAudio: 'sound' });
  });

  it('mute: en los vídeos no suena nada (la música se desvanece como en `video`)', () => {
    expect(audioPlan('mute', 'photo')).toEqual({ music: 'sound', videoAudio: 'silent' });
    expect(audioPlan('mute', 'video')).toEqual({ music: 'silent', videoAudio: 'silent' });
  });

  it('con «Música de fondo» apagada la música no suena en ningún modo ni tipo', () => {
    for (const mode of MODES) {
      for (const kind of ['photo', 'video'] as const) {
        expect(audioPlan(mode, kind, false).music).toBe('silent');
      }
    }
  });

  it('apagar la música no toca el audio de los vídeos', () => {
    for (const mode of MODES) {
      expect(audioPlan(mode, 'video', false).videoAudio).toBe(
        audioPlan(mode, 'video', true).videoAudio,
      );
    }
  });

  it('el audio del vídeo nunca suena en una foto', () => {
    for (const mode of MODES) {
      for (const on of [true, false]) {
        expect(audioPlan(mode, 'photo', on).videoAudio).toBe('silent');
      }
    }
  });
});

describe('las cuatro combinaciones de D16', () => {
  // Lo que se oye durante un vídeo, con la música de fondo activada.
  const heardDuringVideo = (mode: AudioMode, musicOn = true) => {
    const p = audioPlan(mode, 'video', musicOn);
    return { video: p.videoAudio === 'sound', music: p.music === 'sound' };
  };

  it('(1) solo el audio del vídeo = por defecto; la música baja y vuelve después', () => {
    expect(heardDuringVideo('video')).toEqual({ video: true, music: false });
    expect(audioPlan('video', 'photo').music).toBe('sound');
  });

  it('(2) solo la música (vídeos silenciados)', () => {
    expect(heardDuringVideo('music')).toEqual({ video: false, music: true });
  });

  it('(3) los dos a la vez', () => {
    expect(heardDuringVideo('both')).toEqual({ video: true, music: true });
  });

  it('(4) todo en silencio = «Silencio en los vídeos» + música de fondo apagada', () => {
    for (const kind of ['photo', 'video'] as const) {
      expect(audioPlan('mute', kind, false)).toEqual({ music: 'silent', videoAudio: 'silent' });
    }
  });

  it('el par «Silenciar vídeos» / «música durante el vídeo» recorre los cuatro modos', () => {
    const modes = new Set<AudioMode>();
    for (const videoAudio of [true, false]) {
      for (const musicDuringVideo of [true, false]) {
        const mode = modeOfChoice({ videoAudio, musicDuringVideo });
        modes.add(mode);
        expect(choiceOfMode(mode)).toEqual({ videoAudio, musicDuringVideo });
      }
    }
    expect([...modes].sort()).toEqual([...MODES].sort());
  });

  it('la elección de cada modo coincide con lo que dice el plan en un vídeo', () => {
    for (const mode of MODES) {
      const c = choiceOfMode(mode);
      const p = audioPlan(mode, 'video', true);
      expect(p.videoAudio === 'sound').toBe(c.videoAudio);
      expect(p.music === 'sound').toBe(c.musicDuringVideo);
    }
  });
});

describe('directVideoElementState (sin AudioContext, §17.8)', () => {
  it('el vídeo suena desde su elemento con volume = videoVolume y muted según el modo', () => {
    expect(directVideoElementState('video', 0.4)).toEqual({ muted: false, volume: 0.4 });
    expect(directVideoElementState('both', 1)).toEqual({ muted: false, volume: 1 });
    expect(directVideoElementState('music', 1)).toEqual({ muted: true, volume: 1 });
    expect(directVideoElementState('mute', 0.5)).toEqual({ muted: true, volume: 0.5 });
  });

  it('un volumen inválido se limita a [0, 1]', () => {
    expect(directVideoElementState('video', 7).volume).toBe(1);
    expect(directVideoElementState('video', -2).volume).toBe(0);
    expect(directVideoElementState('video', Number.NaN).volume).toBe(1);
  });
});
