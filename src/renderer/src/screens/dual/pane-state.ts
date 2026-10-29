// Estado de un lado de la pantalla de vídeo dual y el adaptador del <video> para sync.ts
// (docs/DESIGN.md §18.1). Sin componentes: DualPane.tsx solo exporta el componente.
import type { RefObject } from 'react';
import { effectiveDuration } from '../player/player-math';
import type { SyncMedia } from './sync';

export interface PaneState {
  /** Clave (época + id del medio) a la que corresponde el estado; si no coincide con la actual, es el inicial. */
  key: string | null;
  playing: boolean;
  /** Segundos. */
  time: number;
  /** Segundos; 0 si se desconoce. */
  duration: number;
  /** Hay un primer fotograma. */
  ready: boolean;
  error: string | null;
}

export const INITIAL_PANE: PaneState = Object.freeze({
  key: null,
  playing: false,
  time: 0,
  duration: 0,
  ready: false,
  error: null,
});

/** El <video> de una referencia, visto como lo que necesita el controlador de sincronización. */
export function videoAsSyncMedia(
  ref: RefObject<HTMLVideoElement | null>,
  durationMs: number | null,
): SyncMedia {
  return {
    get currentTime() {
      return ref.current?.currentTime ?? 0;
    },
    set currentTime(t: number) {
      if (ref.current) ref.current.currentTime = t;
    },
    get duration() {
      return ref.current ? effectiveDuration(ref.current.duration, durationMs) : 0;
    },
    get paused() {
      return ref.current?.paused ?? true;
    },
    get ended() {
      return ref.current?.ended ?? false;
    },
    get readyState() {
      return ref.current?.readyState ?? 0;
    },
    get playbackRate() {
      return ref.current?.playbackRate ?? 1;
    },
    set playbackRate(rate: number) {
      if (ref.current) ref.current.playbackRate = rate;
    },
    play: () => ref.current?.play() ?? Promise.resolve(),
    pause: () => ref.current?.pause(),
  };
}

/** Velocidad de un <video> con el tono conservado; `now` también cambia la velocidad actual. */
export function applySpeed(video: HTMLVideoElement | null, rate: number, now: boolean): void {
  if (!video) return;
  video.preservesPitch = true;
  video.defaultPlaybackRate = rate;
  if (now) video.playbackRate = rate;
}
