// NavModel común a todos los temas (docs/DESIGN.md §14.5 y §15.5): los shells solo cambian cómo se
// presenta. Las playlists del usuario serán subelementos de "Playlists" en F4.
import type { ReactNode } from 'react';
import {
  Columns2,
  Film,
  Image,
  Images,
  LayoutGrid,
  ListVideo,
  CircleQuestionMark,
  Settings,
  type LucideIcon,
} from 'lucide-react';

export type NavKey =
  'gallery-all' | 'gallery-photos' | 'gallery-videos' | 'playlists' | 'dual' | 'settings' | 'help';

export interface NavItem {
  key: NavKey;
  label: string;
  icon: LucideIcon;
}

export interface NavCategory {
  id: 'gallery' | 'playlists' | 'dual' | 'settings' | 'help';
  label: string;
  icon: LucideIcon;
  /** Subelementos; si no tiene, la propia categoría es el destino. */
  items: readonly NavItem[];
}

export type NavModel = readonly NavCategory[];

export const NAV_MODEL: NavModel = Object.freeze([
  {
    id: 'gallery',
    label: 'Galería',
    icon: Images,
    items: [
      { key: 'gallery-all', label: 'Todo', icon: LayoutGrid },
      { key: 'gallery-photos', label: 'Fotos', icon: Image },
      { key: 'gallery-videos', label: 'Vídeos', icon: Film },
    ],
  },
  {
    id: 'playlists',
    label: 'Playlists',
    icon: ListVideo,
    items: [{ key: 'playlists', label: 'Playlists', icon: ListVideo }],
  },
  {
    id: 'dual',
    label: 'Vídeo dual',
    icon: Columns2,
    items: [{ key: 'dual', label: 'Vídeo dual', icon: Columns2 }],
  },
  {
    id: 'settings',
    label: 'Ajustes',
    icon: Settings,
    items: [{ key: 'settings', label: 'Ajustes', icon: Settings }],
  },
  {
    id: 'help',
    label: 'Ayuda',
    icon: CircleQuestionMark,
    items: [{ key: 'help', label: 'Ayuda', icon: CircleQuestionMark }],
  },
] satisfies NavCategory[]);

/** La categoría que contiene `key`. */
export function categoryOf(nav: NavModel, key: NavKey): number {
  const i = nav.findIndex((c) => c.items.some((it) => it.key === key));
  return i === -1 ? 0 : i;
}

/** Título de la pantalla de cada entrada. */
export function navLabel(nav: NavModel, key: NavKey): string {
  for (const c of nav) {
    const item = c.items.find((it) => it.key === key);
    if (item) return key === 'gallery-all' ? c.label : item.label;
  }
  return '';
}

/** Interfaz común de los shells (§15.5). */
export interface ShellProps {
  nav: NavModel;
  active: NavKey;
  onNavigate(key: NavKey): void;
  commandBar: ReactNode;
  children: ReactNode;
}

/** id del contenido principal (destino de "Saltar al contenido"). */
export const MAIN_CONTENT_ID = 'contenido';
