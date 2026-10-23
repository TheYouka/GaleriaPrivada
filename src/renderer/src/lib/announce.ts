// Región global aria-live (docs/DESIGN.md §14.1): `polite` para avisos y progreso, `assertive` solo
// para los errores de contraseña. La pinta components/LiveRegion.tsx.
import { create } from 'zustand';

export type Politeness = 'polite' | 'assertive';

interface AnnounceState {
  polite: string;
  assertive: string;
  /** Cambia en cada aviso, para repetir el mismo texto. */
  seq: number;
}

export const useAnnounceStore = create<AnnounceState>(() => ({
  polite: '',
  assertive: '',
  seq: 0,
}));

export function announce(message: string, politeness: Politeness = 'polite'): void {
  // Vaciar y volver a escribir hace que el lector de pantalla repita un texto igual al anterior.
  useAnnounceStore.setState((s) => ({ [politeness]: '', seq: s.seq + 1 }));
  queueMicrotask(() => {
    useAnnounceStore.setState({ [politeness]: message });
  });
}
