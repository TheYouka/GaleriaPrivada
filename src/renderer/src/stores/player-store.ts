// Reproductor de vídeo (docs/DESIGN.md §16.6): el volumen, el silencio y la velocidad se recuerdan
// durante la sesión, solo en memoria (nada se guarda en disco). También lleva la cuenta de los
// reproductores que están sonando: con alguno en marcha se envía `session:setPlayback { active: true }`
// (pausa el auto-bloqueo y evita que la pantalla se apague, D12) y los fondos animados se pausan.
import { create } from 'zustand';
import { invoke } from '../lib/ipc';
import { clamp, DEFAULT_SPEED, SPEEDS } from '../screens/player/player-math';

interface PlayerState {
  /** 0–1. */
  volume: number;
  muted: boolean;
  speed: number;
  /** Ids de los reproductores en marcha (ni en pausa ni terminados). */
  playingIds: ReadonlySet<string>;
  /** Hay al menos un vídeo reproduciéndose. */
  playing: boolean;
}

export const usePlayerStore = create<PlayerState>(() => ({
  volume: 1,
  muted: false,
  speed: DEFAULT_SPEED,
  playingIds: new Set<string>(),
  playing: false,
}));

export function setPlayerVolume(volume: number): void {
  usePlayerStore.setState({ volume: clamp(volume, 0, 1) });
}

export function setPlayerMuted(muted: boolean): void {
  usePlayerStore.setState({ muted });
}

export function setPlayerSpeed(speed: number): void {
  if ((SPEEDS as readonly number[]).includes(speed)) usePlayerStore.setState({ speed });
}

/** Marca un reproductor como sonando o no. Avisa a main solo cuando cambia el estado global. */
export function setPlayerPlaying(id: string, on: boolean): void {
  const { playingIds, playing } = usePlayerStore.getState();
  if (playingIds.has(id) === on) return;
  const next = new Set(playingIds);
  if (on) next.add(id);
  else next.delete(id);
  const nowPlaying = next.size > 0;
  usePlayerStore.setState({ playingIds: next, playing: nowPlaying });
  if (nowPlaying !== playing) void invoke('session:setPlayback', { active: nowPlaying });
}
