// Modelo puro de los ajustes de la presentación en la interfaz (docs/DESIGN.md §17.2; PLAN.md notas
// 173, 175 y 178): cómo se leen y se escriben los interruptores del diálogo de inicio, del panel en
// vivo y de Ajustes → Presentación sobre `PresentationSettings`. Sin React ni DOM.
//
// Las tres cosas que se pueden apagar son independientes: transiciones (`transition: 'none'`),
// animaciones (`animations`, Ken Burns) y música (`musicEnabled`). El audio son dos interruptores
// que se ven juntos, «Silenciar vídeos» y «Música de fondo» (D16), más «Mantener la música durante
// los vídeos», que solo cuenta con la música encendida: de ahí salen los cuatro modos de §17.8.
import { PRESENTATION_LIMITS } from '@shared/constants';
import type {
  AudioMode,
  Id,
  PresentationPlainSettings,
  PresentationSettings,
  TransitionKind,
} from '@shared/types';
import { audioPlan, choiceOfMode, modeOfChoice, type AudioSettings } from './audio-graph';
import type { SchedulerSettings } from './scheduler';
import type { TransitionSetting } from './transitions';

export const TRANSITION_OPTIONS: readonly { value: TransitionSetting; label: string }[] = [
  { value: 'fade', label: 'Fundido' },
  { value: 'slide', label: 'Deslizar' },
  { value: 'zoom', label: 'Zoom' },
  { value: 'kenburns', label: 'Paneo lento (Ken Burns)' },
  { value: 'random', label: 'Aleatoria' },
  { value: 'none', label: 'Sin transición (corte)' },
];

export const TRANSITION_KIND_LABELS: Readonly<Record<TransitionKind, string>> = {
  fade: 'Fundido',
  slide: 'Deslizar',
  zoom: 'Zoom',
  kenburns: 'Paneo lento',
};

export const TRANSITION_KINDS: readonly TransitionKind[] = ['fade', 'slide', 'zoom', 'kenburns'];

export function transitionLabel(value: TransitionSetting): string {
  return TRANSITION_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

/** Nombre de cada modo de audio, tal como lo oye el usuario durante un vídeo (§17.2). */
export const AUDIO_MODE_LABELS: Readonly<Record<AudioMode, string>> = {
  video: 'Solo el audio del vídeo',
  music: 'Solo la música',
  both: 'El vídeo y la música',
  mute: 'Silencio en los vídeos',
};

// ---- Transiciones ----

export function transitionsOn(s: Pick<PresentationPlainSettings, 'transition'>): boolean {
  return s.transition !== 'none';
}

/**
 * Enciende o apaga las transiciones. Al apagarlas queda `none`; al encenderlas vuelve la última
 * elegida (o el fundido).
 */
export function setTransitionsOn(
  s: PresentationPlainSettings,
  on: boolean,
  last: TransitionSetting = 'fade',
): Partial<PresentationPlainSettings> {
  if (!on) return { transition: 'none' };
  if (s.transition !== 'none') return {};
  return { transition: last === 'none' ? 'fade' : last };
}

/** Quita o pone un tipo del grupo aleatorio; siempre queda al menos uno (§17.2). */
export function toggleRandomKind(
  pool: readonly TransitionKind[],
  kind: TransitionKind,
): TransitionKind[] {
  const has = pool.includes(kind);
  if (has && pool.length === 1) return [...pool];
  const next = has ? pool.filter((k) => k !== kind) : [...pool, kind];
  return TRANSITION_KINDS.filter((k) => next.includes(k));
}

// ---- Tiempos ----

export function slideSeconds(ms: number): number {
  return ms / 1000;
}

/** «5 s», «2,5 s». */
export function formatSeconds(ms: number): string {
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1).replace('.', ',')} s`;
}

export function clampSlideMs(ms: number): number {
  const { slideMsMin, slideMsMax, slideMsStep } = PRESENTATION_LIMITS;
  const stepped = Math.round(ms / slideMsStep) * slideMsStep;
  return Math.min(slideMsMax, Math.max(slideMsMin, stepped));
}

/** Paso de la duración de la transición en el deslizador (ms). */
export const TRANSITION_MS_STEP = 100;

export function clampTransitionMs(ms: number): number {
  const { transitionMsMin, transitionMsMax } = PRESENTATION_LIMITS;
  const stepped = Math.round(ms / TRANSITION_MS_STEP) * TRANSITION_MS_STEP;
  return Math.min(transitionMsMax, Math.max(transitionMsMin, stepped));
}

// ---- Audio ----

/** «Silenciar vídeos» está activado. */
export function videosSilenced(s: Pick<PresentationPlainSettings, 'audioMode'>): boolean {
  return !choiceOfMode(s.audioMode).videoAudio;
}

export function musicDuringVideo(s: Pick<PresentationPlainSettings, 'audioMode'>): boolean {
  return choiceOfMode(s.audioMode).musicDuringVideo;
}

export function setVideosSilenced(mode: AudioMode, silenced: boolean): AudioMode {
  return modeOfChoice({ ...choiceOfMode(mode), videoAudio: !silenced });
}

export function setMusicDuringVideo(mode: AudioMode, keep: boolean): AudioMode {
  return modeOfChoice({ ...choiceOfMode(mode), musicDuringVideo: keep });
}

/** Lo que se oye durante un vídeo con esta combinación (para el texto de ayuda de los ajustes). */
export function describeAudio(
  s: Pick<PresentationPlainSettings, 'audioMode' | 'musicEnabled'>,
): string {
  const plan = audioPlan(s.audioMode, 'video', s.musicEnabled);
  if (plan.videoAudio === 'sound' && plan.music === 'sound')
    return 'Durante los vídeos suenan el vídeo y la música.';
  if (plan.videoAudio === 'sound') {
    return s.musicEnabled
      ? 'Durante los vídeos suena solo el vídeo: la música baja y vuelve al terminar.'
      : 'Durante los vídeos suena solo el vídeo.';
  }
  if (plan.music === 'sound') return 'Durante los vídeos suena solo la música.';
  return s.musicEnabled
    ? 'Durante los vídeos no suena nada: la música vuelve al terminar.'
    : 'No suena nada durante los vídeos.';
}

// ---- Hacia el motor ----

export function schedulerSettingsOf(s: PresentationPlainSettings): SchedulerSettings {
  return {
    transition: s.transition,
    randomPool: s.randomPool,
    transitionMs: s.transitionMs,
    slideMs: s.slideMs,
    loop: s.loop,
    kenBurns: s.animations,
  };
}

export function audioSettingsOf(s: PresentationPlainSettings): AudioSettings {
  return {
    audioMode: s.audioMode,
    musicEnabled: s.musicEnabled,
    musicVolume: s.musicVolume,
    videoVolume: s.videoVolume,
    musicFadeMs: s.musicFadeMs,
  };
}

// ---- Pistas ----

/** Añade las pistas nuevas al final sin pasar del máximo ni repetir. */
export function appendTracks(
  trackIds: readonly Id[],
  extra: readonly Id[],
  max: number = PRESENTATION_LIMITS.trackIdsMax,
): Id[] {
  const out = [...trackIds];
  for (const id of extra) {
    if (out.length >= max) break;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Copia editable de los ajustes (los arrays no se comparten con el estado de origen). */
export function cloneSettings(s: PresentationSettings): PresentationSettings {
  return { ...s, randomPool: [...s.randomPool], trackIds: [...s.trackIds] };
}
