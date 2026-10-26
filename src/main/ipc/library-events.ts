// Agrupación de `library:changed` (docs/DESIGN.md §10.2). media:list devuelve la biblioteca entera
// (R13), así que un evento por archivo en una importación de 10 000 archivos provocaría miles de
// recargas completas:
//
// - mientras haya una importación o una fusión activa (beginJob … end), el evento sale como mucho
//   una vez por segundo y por `reason`, sin `ids` (el renderer recarga la consulta actual), y una
//   vez más al terminar el trabajo (después de la última confirmación);
// - fuera de los trabajos (renombrar, borrar, editar, playlists), sale al momento con sus `ids`.
//
// Usa setTimeout y Date.now globales: los tests usan el reloj falso de Vitest.
import type { Id, LibraryChanged, LibraryChangeReason } from '@shared/types';

export const LIBRARY_EVENT_WINDOW_MS = 1000;

interface ReasonState {
  /** Último envío en modo agrupado (ms). */
  lastSent: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Hubo cambios con esta razón durante el trabajo: al terminar se envía uno más. */
  touched: boolean;
}

export class LibraryEvents {
  private activeJobs = 0;
  private readonly reasons = new Map<LibraryChangeReason, ReasonState>();

  constructor(
    private readonly send: (payload: LibraryChanged) => void,
    private readonly windowMs: number = LIBRARY_EVENT_WINDOW_MS,
  ) {}

  /** Hay algún trabajo (importación o fusión) agrupando eventos. */
  get batching(): boolean {
    return this.activeJobs > 0;
  }

  /**
   * Una importación o una fusión empieza a agrupar. Devuelve `end()` (idempotente): envía el
   * evento final de cada razón que cambió durante el trabajo.
   */
  beginJob(): () => void {
    this.activeJobs += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.activeJobs -= 1;
      this.flush();
    };
  }

  /** Un cambio en la biblioteca. Con un trabajo activo se agrupa (sin ids); si no, sale ya. */
  changed(reason: LibraryChangeReason, ids?: readonly Id[]): void {
    if (this.activeJobs === 0) {
      this.emit(ids && ids.length > 0 ? { reason, ids: [...ids] } : { reason });
      return;
    }
    const state = this.stateOf(reason);
    state.touched = true;
    if (state.timer) return; // ya hay uno programado
    const now = Date.now();
    const wait = state.lastSent === null ? 0 : state.lastSent + this.windowMs - now;
    if (wait <= 0) {
      state.lastSent = now;
      this.emit({ reason });
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      state.lastSent = Date.now();
      this.emit({ reason });
    }, wait);
  }

  /** Cancela los envíos programados (al cerrar la app o en los tests). */
  dispose(): void {
    for (const state of this.reasons.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.reasons.clear();
  }

  private stateOf(reason: LibraryChangeReason): ReasonState {
    let state = this.reasons.get(reason);
    if (!state) {
      state = { lastSent: null, timer: null, touched: false };
      this.reasons.set(reason, state);
    }
    return state;
  }

  /** Fin de un trabajo: un evento final por razón tocada (sustituye al programado). */
  private flush(): void {
    for (const [reason, state] of this.reasons) {
      if (!state.touched) continue;
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.touched = false;
      state.lastSent = Date.now();
      this.emit({ reason });
    }
    if (this.activeJobs === 0) this.reasons.clear();
  }

  private emit(payload: LibraryChanged): void {
    try {
      this.send(payload);
    } catch {
      // la ventana puede no existir (bloqueo en curso): el evento se pierde sin más
    }
  }
}
