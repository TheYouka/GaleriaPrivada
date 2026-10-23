// Foco (docs/DESIGN.md §14.1): en cada cambio de pantalla el foco pasa al <h1 tabIndex={-1}> de la
// pantalla nueva (o al elemento que indique la pantalla). Un remontaje sin cambio de pantalla (por
// ejemplo, al cambiar de shell con el tema) no lo mueve.
import { useEffect } from 'react';
import { useNavStore } from '../stores/nav-store';

/** Mueve el foco a `resolve()` una vez por cambio de pantalla. */
export function useScreenFocus(resolve: () => HTMLElement | null | undefined): void {
  const seq = useNavStore((s) => s.seq);
  useEffect(() => {
    const nav = useNavStore.getState();
    if (nav.focusedSeq === seq) return;
    const el = resolve();
    if (!el) return;
    nav.markFocused(seq);
    el.focus();
  }, [seq, resolve]);
}

/** Enfoca el elemento con ese id si existe (tras un remontaje). */
export function focusById(id: string): boolean {
  const el = document.getElementById(id);
  if (!el) return false;
  if (el !== document.activeElement) el.focus({ preventScroll: true });
  return true;
}
