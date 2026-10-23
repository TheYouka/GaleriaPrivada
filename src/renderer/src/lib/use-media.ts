// Suscripciones del DOM como hooks (useSyncExternalStore): visibilidad del documento y media queries.
import { useSyncExternalStore } from 'react';

function subscribeVisibility(cb: () => void): () => void {
  document.addEventListener('visibilitychange', cb);
  return () => document.removeEventListener('visibilitychange', cb);
}

/** document.hidden en vivo (ventana minimizada u oculta). */
export function useDocumentHidden(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => document.hidden);
}

/** matchMedia(query).matches en vivo. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', cb);
      return () => mql.removeEventListener('change', cb);
    },
    () => window.matchMedia(query).matches,
  );
}
