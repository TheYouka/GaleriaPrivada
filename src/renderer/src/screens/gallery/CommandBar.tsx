// Barra de comandos de la galería (docs/DESIGN.md §14.5 y §14.6): búsqueda (debounce de 200 ms en
// la consulta, Esc la limpia), filtros, orden (se guarda en prefs.gallerySort), tamaño de las
// miniaturas (prefs.gridSize) e "Importar" (Archivos… / Carpeta…). Mientras hay una importación
// en curso, "Importar" queda con aria-disabled y un tooltip (§14.6): sigue enfocable y el menú no se
// abre. El shell la coloca según el tema (§15.5). "Bloquear" está en la barra de título (Ctrl+L).
import { useState } from 'react';
import { ArrowUpDown, Check, FolderOpen, Grid2x2, Search, Upload } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { Button } from '../../components/Button';
import { Menu } from '../../components/Menu';
import { Tooltip } from '../../components/Tooltip';
import { FIELD_INPUT_CLASS } from '../../components/TextField';
import { cx } from '../../lib/cx';
import { startImport, useImportStore } from '../../stores/import-store';
import { setFilters, useLibraryStore } from '../../stores/library-store';
import { useSessionStore } from '../../stores/session-store';
import { FilterPopover } from './FilterBar';
import { GRID_SIZE_LABELS, SORT_FIELDS, setGallerySort, setGridSize } from './gallery-prefs';
import type { GridSize } from './grid-model';

/** Id del campo de búsqueda: Ctrl+F lo enfoca (§14.1). */
export const GALLERY_SEARCH_ID = 'gallery-search';

export const IMPORT_BUSY_TOOLTIP = 'Espera a que termine la importación en curso';

const MENU_CONTENT =
  'z-50 min-w-52 rounded-md border border-border bg-bg-elevated p-1 text-text shadow-md';
const MENU_ITEM =
  'relative flex h-9 cursor-default items-center rounded-sm pr-3 pl-8 text-sm outline-none data-highlighted:bg-surface-hover data-highlighted:outline-2 data-highlighted:outline-focus-ring';
const MENU_LABEL = 'px-3 py-1.5 text-xs text-text-muted';

/** Valor del radio "Orden de la playlist" (con un filtro de playlist; no se guarda en prefs). */
const PLAYLIST_ORDER = 'position';

function SortMenu() {
  const sort = useSessionStore((s) => s.prefs?.gallerySort);
  const playlistFiltered = useLibraryStore((s) => s.filters.playlistId !== null);
  const playlistOrder = useLibraryStore((s) => s.filters.playlistOrder);
  if (!sort) return null;
  const byPlaylist = playlistFiltered && playlistOrder;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button>
          <ArrowUpDown aria-hidden="true" size={16} strokeWidth={1.75} />
          Ordenar
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className={MENU_CONTENT}>
          <DropdownMenu.Label className={MENU_LABEL}>Ordenar por</DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={byPlaylist ? PLAYLIST_ORDER : sort.field}
            onValueChange={(field) => {
              if (field === PLAYLIST_ORDER) return setFilters({ playlistOrder: true });
              const next = SORT_FIELDS.find((f) => f.value === field);
              if (!next) return;
              setFilters({ playlistOrder: false });
              void setGallerySort({ field: next.value, dir: sort.dir });
            }}
          >
            {playlistFiltered ? (
              <DropdownMenu.RadioItem value={PLAYLIST_ORDER} className={MENU_ITEM}>
                <DropdownMenu.ItemIndicator className="absolute left-2 inline-flex">
                  <Check aria-hidden="true" size={16} />
                </DropdownMenu.ItemIndicator>
                Orden de la playlist
              </DropdownMenu.RadioItem>
            ) : null}
            {SORT_FIELDS.map((f) => (
              <DropdownMenu.RadioItem key={f.value} value={f.value} className={MENU_ITEM}>
                <DropdownMenu.ItemIndicator className="absolute left-2 inline-flex">
                  <Check aria-hidden="true" size={16} />
                </DropdownMenu.ItemIndicator>
                {f.label}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          {byPlaylist ? null : (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.Label className={MENU_LABEL}>Sentido</DropdownMenu.Label>
              <DropdownMenu.RadioGroup
                value={sort.dir}
                onValueChange={(dir) => {
                  if (dir === 'asc' || dir === 'desc')
                    void setGallerySort({ field: sort.field, dir });
                }}
              >
                {(
                  [
                    ['asc', 'Ascendente'],
                    ['desc', 'Descendente'],
                  ] as const
                ).map(([value, label]) => (
                  <DropdownMenu.RadioItem key={value} value={value} className={MENU_ITEM}>
                    <DropdownMenu.ItemIndicator className="absolute left-2 inline-flex">
                      <Check aria-hidden="true" size={16} />
                    </DropdownMenu.ItemIndicator>
                    {label}
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function SizeMenu() {
  const size = useSessionStore((s) => s.prefs?.gridSize);
  if (!size) return null;
  return (
    <Menu
      label="Tamaño de las miniaturas"
      value={size}
      options={(Object.keys(GRID_SIZE_LABELS) as GridSize[]).map((value) => ({
        value,
        label: GRID_SIZE_LABELS[value],
      }))}
      onValueChange={(value) => void setGridSize(value as GridSize)}
      trigger={
        <Button>
          <Grid2x2 aria-hidden="true" size={16} strokeWidth={1.75} />
          Tamaño
        </Button>
      }
    />
  );
}

function ImportMenu() {
  const importing = useImportStore((s) => s.job !== null);
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu.Root
      open={open && !importing}
      onOpenChange={(next) => setOpen(next && !importing)}
    >
      <Tooltip content={IMPORT_BUSY_TOOLTIP} enabled={importing}>
        <DropdownMenu.Trigger asChild>
          <Button
            variant="primary"
            aria-disabled={importing || undefined}
            className={cx(importing && 'cursor-not-allowed opacity-50')}
          >
            <Upload aria-hidden="true" size={16} strokeWidth={1.75} />
            Importar
          </Button>
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className={MENU_CONTENT}>
          <DropdownMenu.Item
            className={cx(MENU_ITEM, 'pl-3')}
            onSelect={() => void startImport('files')}
          >
            <Upload aria-hidden="true" size={16} className="mr-2" />
            Archivos…
            <span className="ml-auto pl-4 text-xs text-text-muted">Ctrl+I</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={cx(MENU_ITEM, 'pl-3')}
            onSelect={() => void startImport('folder')}
          >
            <FolderOpen aria-hidden="true" size={16} className="mr-2" />
            Carpeta…
            <span className="ml-auto pl-4 text-xs text-text-muted">Ctrl+Mayús+I</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function CommandBar() {
  const search = useLibraryStore((s) => s.filters.search);
  return (
    <section aria-label="Herramientas de la galería" className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-48 flex-1">
        <Search
          aria-hidden="true"
          size={16}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-muted"
        />
        <label htmlFor={GALLERY_SEARCH_ID} className="sr-only">
          Buscar
        </label>
        <input
          id={GALLERY_SEARCH_ID}
          type="search"
          value={search}
          maxLength={200}
          placeholder="Buscar por nombre"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setFilters({ search: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && search) {
              e.preventDefault();
              e.stopPropagation();
              setFilters({ search: '' });
            }
          }}
          className={cx(
            FIELD_INPUT_CLASS,
            'pl-9 [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden',
          )}
        />
      </div>
      <FilterPopover />
      <SortMenu />
      <SizeMenu />
      <ImportMenu />
    </section>
  );
}
