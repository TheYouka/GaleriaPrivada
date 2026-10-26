// Conjunto `inFlight` (docs/DESIGN.md §12.6 punto 7): ids de objetos y miniaturas nuevos que aún
// no referencia ningún COMMIT. Importación (§12.4 paso 5), edición (§16.5) y fusión (§18.6) los
// registran antes de renombrarlos a su sitio y los liberan después del COMMIT que los referencia,
// o tras limpiar un fallo. El barrido de huérfanos de la reconciliación ignora estos ids.
//
// Un único conjunto por proceso (lo crea index.ts) y no por sesión: tras un bloqueo de 0 ms el
// trabajo de la sesión anterior puede seguir con ids registrados mientras empieza el barrido de la
// siguiente (PLAN.md nota 6, [H3-6]). Cuenta referencias, así que dos registros del mismo id
// necesitan dos liberaciones.
import { ID_PATTERN } from '@shared/constants';
import type { Id } from '@shared/types';

export class InFlight {
  private readonly counts = new Map<Id, number>();

  /**
   * Registra los ids (los null/undefined se ignoran, p. ej. un medio sin miniatura) y devuelve la
   * función que los libera, idempotente.
   */
  track(...ids: (Id | null | undefined)[]): () => void {
    const tracked: Id[] = [];
    for (const id of ids) {
      if (id === null || id === undefined) continue;
      if (!ID_PATTERN.test(id)) throw new RangeError('id inválido');
      this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
      tracked.push(id);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const id of tracked) {
        const n = (this.counts.get(id) ?? 0) - 1;
        if (n > 0) this.counts.set(id, n);
        else this.counts.delete(id);
      }
    };
  }

  has(id: Id): boolean {
    return this.counts.has(id);
  }

  get size(): number {
    return this.counts.size;
  }
}
