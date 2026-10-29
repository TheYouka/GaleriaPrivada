// Regla de la barra de selección para «Vídeo dual» (docs/PLAN.md 5.4): solo se habilita con
// EXACTAMENTE dos vídeos seleccionados. Sin DOM, para probarla en Vitest.
import type { Id, MediaListItem } from '@shared/types';

export const DUAL_NEEDS_TWO = 'Selecciona exactamente dos vídeos.';

/**
 * Los dos vídeos seleccionados, en el orden de la galería (el primero va a la izquierda); null si
 * la selección no son exactamente dos vídeos.
 */
export function dualPair(
  items: readonly MediaListItem[],
  selected: ReadonlySet<Id>,
): [MediaListItem, MediaListItem] | null {
  if (selected.size !== 2) return null;
  const picked = items.filter((i) => selected.has(i.id));
  const [first, second] = picked;
  if (picked.length !== 2 || !first || !second) return null;
  return first.kind === 'video' && second.kind === 'video' ? [first, second] : null;
}
