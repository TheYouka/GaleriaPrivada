// Relación entre las entradas "Todo / Fotos / Vídeos" del NavModel (§14.5) y el filtro de tipo.
import type { MediaKind } from '@shared/types';
import type { NavKey } from '../../themes/shells/nav-model';

export type GalleryKind = 'all' | MediaKind;

const KIND_BY_NAV: Partial<Record<NavKey, GalleryKind>> = {
  'gallery-all': 'all',
  'gallery-photos': 'photo',
  'gallery-videos': 'video',
};

/** Tipo de la entrada activa, o null si no es una pantalla de la galería. */
export function galleryKindOf(active: NavKey): GalleryKind | null {
  return KIND_BY_NAV[active] ?? null;
}

export function navKeyOfKind(kind: GalleryKind): NavKey {
  return kind === 'photo' ? 'gallery-photos' : kind === 'video' ? 'gallery-videos' : 'gallery-all';
}

export const KIND_LABELS: Record<GalleryKind, string> = {
  all: 'Todo',
  photo: 'Fotos',
  video: 'Vídeos',
};
