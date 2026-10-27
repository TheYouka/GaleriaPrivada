// Cola de pistas de la presentación (docs/DESIGN.md §17.8, «Música»): se encadenan en orden y en
// bucle, sin fundido entre pistas; una pista que falla se salta y, si fallan todas, la música se
// desactiva. Puro.
import type { Id } from '@shared/types';

export class MusicQueue {
  private tracks: readonly Id[];
  private position = 0;
  private readonly failedIds = new Set<Id>();

  constructor(trackIds: readonly Id[]) {
    this.tracks = [...trackIds];
  }

  /** Pista que toca ahora; null si no hay pistas o fallaron todas. */
  current(): Id | null {
    if (this.exhausted) return null;
    return this.tracks[this.position] ?? null;
  }

  /** `ended`: pasa a la siguiente (la primera después de la última). */
  advance(): Id | null {
    return this.moveToPlayable(1);
  }

  /** La pista actual no se pudo cargar o reproducir: se salta y se recuerda. */
  fail(): Id | null {
    const id = this.tracks[this.position];
    if (id !== undefined) this.failedIds.add(id);
    return this.moveToPlayable(1);
  }

  /** Todas las pistas fallaron (o no hay ninguna): hay que desactivar la música con un toast. */
  get exhausted(): boolean {
    return this.tracks.every((id) => this.failedIds.has(id));
  }

  /** Cambia la lista en vivo; sigue con la pista actual si continúa en ella. */
  setTracks(trackIds: readonly Id[]): void {
    const keep = this.tracks[this.position];
    this.tracks = [...trackIds];
    const at = keep === undefined ? -1 : this.tracks.indexOf(keep);
    this.position = at >= 0 ? at : 0;
  }

  private moveToPlayable(step: number): Id | null {
    const n = this.tracks.length;
    if (n === 0 || this.exhausted) return null;
    for (let k = 0; k < n; k += 1) {
      this.position = (this.position + step) % n;
      const id = this.tracks[this.position];
      if (!this.failedIds.has(id)) return id;
    }
    return null;
  }
}
