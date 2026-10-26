// Orden y tamaño de las miniaturas de la galería: se guardan en las preferencias del perfil
// (prefs.gallerySort y prefs.gridSize, en claro, §14.6) y la galería los lee de ahí.
import type { MediaSort, ProfilePrefs } from '@shared/types';
import { errorMessage } from '../../lib/errors-es';
import { invoke } from '../../lib/ipc';
import { toast } from '../../lib/toast';
import { useSessionStore } from '../../stores/session-store';
import type { GridSize } from './grid-model';

async function savePrefs(patch: Partial<ProfilePrefs>): Promise<void> {
  const res = await invoke('prefs:set', patch);
  if (!res.ok) return void toast(errorMessage(res.error), 'error');
  useSessionStore.getState().setPrefs(res.data);
}

export const SORT_FIELDS: readonly { value: MediaSort['field']; label: string }[] = [
  { value: 'captured', label: 'Fecha de captura' },
  { value: 'imported', label: 'Fecha de importación' },
  { value: 'name', label: 'Nombre' },
  { value: 'size', label: 'Tamaño' },
  { value: 'duration', label: 'Duración' },
];

export const GRID_SIZE_LABELS: Record<GridSize, string> = {
  small: 'Pequeño',
  medium: 'Mediano',
  large: 'Grande',
};

export function setGallerySort(sort: MediaSort): Promise<void> {
  return savePrefs({ gallerySort: sort });
}

export function setGridSize(size: GridSize): Promise<void> {
  return savePrefs({ gridSize: size });
}
