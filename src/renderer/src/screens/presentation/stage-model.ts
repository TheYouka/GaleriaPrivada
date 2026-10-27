// Capas del escenario de la presentación (docs/DESIGN.md §17.3 y §17.5). Puro: qué diapositivas
// están cargadas (o cargándose) y en qué papel, y qué hueco del pool de 3 <video> usa cada vídeo.
// El componente `SlideStage` lo pinta con `useSyncExternalStore`; el anfitrión
// (`presentation-runtime.ts`) lo modifica al recibir los eventos del planificador.
//
// Papeles: `preload` (cargada y oculta, a la espera), `entering`, `current` y `leaving`. Cada
// diapositiva tiene como mucho una capa (clave = índice en la secuencia).
import type { MediaListItem } from '@shared/types';
import type { ResolvedSlide } from './slide-source';

export type LayerRole = 'preload' | 'entering' | 'current' | 'leaving';

export interface StageEntry {
  readonly index: number;
  readonly item: MediaListItem;
  /** null hasta tener `media:get` (fotos); los vídeos lo tienen enseguida. */
  readonly slide: ResolvedSlide | null;
  /** Hueco del pool de vídeos (null en las fotos). */
  readonly slot: number | null;
  /** La imagen está decodificada o el vídeo puede reproducirse. */
  readonly ready: boolean;
  readonly role: LayerRole;
}

/** Tamaño del pool de <video> (§17.5). */
export const VIDEO_POOL_SIZE = 3;

export class StageModel {
  private readonly entries = new Map<number, StageEntry>();
  private readonly usedSlots = new Set<number>();
  private readonly listeners = new Set<() => void>();
  private cached: readonly StageEntry[] = [];
  private dirty = false;

  constructor(
    readonly items: readonly MediaListItem[],
    private readonly poolSize: number = VIDEO_POOL_SIZE,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Lista estable entre cambios (para `useSyncExternalStore`), ordenada por índice. */
  getSnapshot = (): readonly StageEntry[] => {
    if (this.dirty) {
      this.cached = [...this.entries.values()].sort((a, b) => a.index - b.index);
      this.dirty = false;
    }
    return this.cached;
  };

  get(index: number): StageEntry | undefined {
    return this.entries.get(index);
  }

  has(index: number): boolean {
    return this.entries.has(index);
  }

  slotOf(index: number): number | null {
    return this.entries.get(index)?.slot ?? null;
  }

  /** Hueco libre del pool, o null si están los 3 en uso. */
  freeSlot(): number | null {
    for (let s = 0; s < this.poolSize; s += 1) if (!this.usedSlots.has(s)) return s;
    return null;
  }

  /**
   * Crea la capa de una diapositiva (oculta). Un vídeo se queda con un hueco del pool; si no hay,
   * devuelve null y no crea nada. Si ya existía, devuelve la que había.
   */
  add(index: number, slide: ResolvedSlide | null): StageEntry | null {
    const existing = this.entries.get(index);
    if (existing) return existing;
    const item = this.items[index];
    if (!item) return null;
    let slot: number | null = null;
    if (item.kind === 'video') {
      slot = this.freeSlot();
      if (slot === null) return null;
      this.usedSlots.add(slot);
    }
    const entry: StageEntry = { index, item, slide, slot, ready: false, role: 'preload' };
    this.entries.set(index, entry);
    this.touch();
    return entry;
  }

  patch(
    index: number,
    change: Partial<Pick<StageEntry, 'slide' | 'ready' | 'role'>>,
  ): StageEntry | undefined {
    const entry = this.entries.get(index);
    if (!entry) return undefined;
    const next: StageEntry = { ...entry, ...change };
    this.entries.set(index, next);
    this.touch();
    return next;
  }

  /** Quita la capa y libera su hueco. */
  remove(index: number): void {
    const entry = this.entries.get(index);
    if (!entry) return;
    if (entry.slot !== null) this.usedSlots.delete(entry.slot);
    this.entries.delete(index);
    this.touch();
  }

  clear(): void {
    if (this.entries.size === 0) return;
    this.entries.clear();
    this.usedSlots.clear();
    this.touch();
  }

  private touch(): void {
    this.dirty = true;
    for (const listener of [...this.listeners]) listener();
  }
}
