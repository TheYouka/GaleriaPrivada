// Búsqueda del selector «Elegir vídeo…» (docs/DESIGN.md §18.1). Sin DOM, para probarla en Vitest.
import type { MediaListItem } from '@shared/types';

/** Tantos vídeos como máximo en la rejilla; para el resto está la búsqueda. */
export const PICKER_LIMIT = 120;

/** Minúsculas y sin acentos, para buscar sin fijarse en ellos. */
export function normalizeSearch(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Los vídeos cuyo nombre contiene la búsqueda (vacía: todos), en el mismo orden. */
export function filterVideos(
  items: readonly MediaListItem[],
  search: string,
): readonly MediaListItem[] {
  const wanted = normalizeSearch(search.trim());
  return wanted ? items.filter((i) => normalizeSearch(i.name).includes(wanted)) : items;
}
