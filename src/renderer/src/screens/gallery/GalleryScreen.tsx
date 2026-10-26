// Galería (docs/DESIGN.md §14.6): cabecera con el recuento, chips de filtros, barra de selección y
// la rejilla virtualizada. El tipo sale de la entrada activa del NavModel (Todo / Fotos / Vídeos), el
// orden y el tamaño de las preferencias del perfil y la búsqueda se aplica con un debounce de 200 ms.
import { useEffect, useMemo } from 'react';
import { FolderOpen, Upload } from 'lucide-react';
import type { MediaSort } from '@shared/types';
import { Button } from '../../components/Button';
import { ScreenHeading } from '../../components/ScreenHeading';
import { errorMessage } from '../../lib/errors-es';
import { useDebounced } from '../../lib/use-debounced';
import { startImport, useImportStore } from '../../stores/import-store';
import {
  buildQuery,
  clearFilters,
  reloadLibrary,
  setLibraryQuery,
  useLibraryStore,
} from '../../stores/library-store';
import { useNavStore } from '../../stores/nav-store';
import { useSessionStore } from '../../stores/session-store';
import { NAV_MODEL, navLabel } from '../../themes/shells/nav-model';
import { FilterChips } from './FilterBar';
import { galleryKindOf } from './gallery-nav';
import { GalleryGrid } from './GalleryGrid';
import type { GridGrouping, GridSize } from './grid-model';
import { SelectionBar } from './SelectionBar';

/** Debounce de la búsqueda (§14.6). */
export const SEARCH_DEBOUNCE_MS = 200;

const DEFAULT_SORT: MediaSort = { field: 'captured', dir: 'desc' };

function groupingOf(sort: MediaSort): GridGrouping {
  return sort.field === 'captured' || sort.field === 'imported' ? sort.field : null;
}

function EmptyState({ filtered }: { filtered: boolean }) {
  const importing = useImportStore((s) => s.job !== null);
  if (filtered) {
    return (
      <div className="flex flex-col items-start gap-3 p-8">
        <p className="text-text">
          No hay ningún elemento que coincida con la búsqueda o los filtros.
        </p>
        <Button
          onClick={() => {
            clearFilters();
            useNavStore.getState().setActive('gallery-all');
          }}
        >
          Quitar búsqueda y filtros
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-4 p-8">
      <p className="max-w-prose text-text">
        Tu bóveda está vacía. Importa fotos y vídeos o arrástralos aquí.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button variant="primary" disabled={importing} onClick={() => void startImport('files')}>
          <Upload aria-hidden="true" size={16} strokeWidth={1.75} />
          Importar archivos…
        </Button>
        <Button disabled={importing} onClick={() => void startImport('folder')}>
          <FolderOpen aria-hidden="true" size={16} strokeWidth={1.75} />
          Importar carpeta…
        </Button>
      </div>
      <p className="max-w-prose text-sm text-text-muted">
        Al importar, el original se borra cuando la copia cifrada está verificada.
      </p>
    </div>
  );
}

export function GalleryScreen() {
  const active = useNavStore((s) => s.active);
  const kind = galleryKindOf(active) ?? 'all';
  const prefs = useSessionStore((s) => s.prefs);
  const sort = prefs?.gallerySort ?? DEFAULT_SORT;
  const size: GridSize = prefs?.gridSize ?? 'medium';
  const filters = useLibraryStore((s) => s.filters);
  const items = useLibraryStore((s) => s.items);
  const status = useLibraryStore((s) => s.status);
  const error = useLibraryStore((s) => s.error);

  const search = useDebounced(filters.search, SEARCH_DEBOUNCE_MS);
  const query = useMemo(
    () =>
      buildQuery(
        kind,
        { search, dateFrom: filters.dateFrom, dateTo: filters.dateTo },
        { field: sort.field, dir: sort.dir },
      ),
    [kind, search, filters.dateFrom, filters.dateTo, sort.field, sort.dir],
  );
  useEffect(() => setLibraryQuery(query), [query]);

  const filtered =
    kind !== 'all' ||
    query.search !== undefined ||
    query.dateFrom !== undefined ||
    query.dateTo !== undefined;
  const title = navLabel(NAV_MODEL, active);
  const count = items.length === 1 ? '1 elemento' : `${items.length} elementos`;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header className="flex items-baseline gap-3 px-6 pt-3 pb-2">
        <ScreenHeading className="text-2xl text-text">{title}</ScreenHeading>
        {status === 'ready' ? <p className="text-sm text-text-muted">{count}</p> : null}
      </header>
      <FilterChips />
      <SelectionBar />
      <div className="relative min-h-0 flex-1">
        {status === 'error' ? (
          <div className="flex flex-col items-start gap-3 p-8">
            <p role="alert" className="text-danger-text">
              {errorMessage(error)}
            </p>
            <Button onClick={reloadLibrary}>Reintentar</Button>
          </div>
        ) : items.length > 0 ? (
          <GalleryGrid items={items} size={size} grouping={groupingOf(sort)} />
        ) : status === 'ready' ? (
          <EmptyState filtered={filtered} />
        ) : (
          <p role="status" className="p-8 text-text-muted">
            Cargando…
          </p>
        )}
      </div>
    </div>
  );
}
