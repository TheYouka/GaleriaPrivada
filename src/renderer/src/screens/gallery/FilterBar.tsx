// Filtros de la galería (docs/DESIGN.md §14.6): el Popover "Filtros" (tipo con ToggleGroup y rango
// de fechas sobre captured_at) y los chips de los filtros activos, cada uno con su botón "Quitar".
// El filtro de playlist llega con las playlists (F4: aún no existe ningún canal para listarlas).
// El tipo es la entrada activa del NavModel (Todo / Fotos / Vídeos): cambiarlo aquí o en la
// navegación es lo mismo.
import { Filter, X } from 'lucide-react';
import { Popover, ToggleGroup } from 'radix-ui';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { formatNaiveDate } from '../../lib/format';
import {
  dayStartMs,
  isDateRangeInvalid,
  setFilters,
  useLibraryStore,
} from '../../stores/library-store';
import { useNavStore } from '../../stores/nav-store';
import { galleryKindOf, KIND_LABELS, navKeyOfKind, type GalleryKind } from './gallery-nav';

const KINDS: readonly GalleryKind[] = ['all', 'photo', 'video'];

function useKind(): GalleryKind {
  return useNavStore((s) => galleryKindOf(s.active)) ?? 'all';
}

function setKind(kind: GalleryKind): void {
  useNavStore.getState().setActive(navKeyOfKind(kind));
}

function dateLabel(prefix: string, day: string): string {
  const ms = dayStartMs(day);
  return ms === null ? `${prefix} ${day}` : `${prefix} ${formatNaiveDate(ms)}`;
}

export function FilterPopover() {
  const kind = useKind();
  const filters = useLibraryStore((s) => s.filters);
  const count = (kind === 'all' ? 0 : 1) + (filters.dateFrom ? 1 : 0) + (filters.dateTo ? 1 : 0);
  const rangeInvalid = isDateRangeInvalid(filters);
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button>
          <Filter aria-hidden="true" size={16} strokeWidth={1.75} />
          Filtros
          {count > 0 ? (
            <span className="rounded-full bg-accent px-1.5 text-xs text-on-accent">{count}</span>
          ) : null}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          aria-label="Filtros de la galería"
          className="z-50 flex w-80 flex-col gap-4 rounded-md border border-border bg-bg-elevated p-4 text-text shadow-md"
        >
          <div className="flex flex-col gap-1.5">
            <span id="filter-kind-label" className="text-sm font-medium">
              Tipo
            </span>
            <ToggleGroup.Root
              type="single"
              value={kind}
              onValueChange={(value) => {
                if (value) setKind(value as GalleryKind);
              }}
              aria-labelledby="filter-kind-label"
              className="inline-flex gap-1 self-start rounded-md border border-border-strong p-0.5"
            >
              {KINDS.map((k) => (
                <ToggleGroup.Item
                  key={k}
                  value={k}
                  className="h-8 rounded-sm px-3 text-sm text-text hover:bg-surface-hover data-[state=on]:bg-accent data-[state=on]:text-on-accent"
                >
                  {KIND_LABELS[k]}
                </ToggleGroup.Item>
              ))}
            </ToggleGroup.Root>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label="Desde"
              type="date"
              value={filters.dateFrom ?? ''}
              onChange={(e) => setFilters({ dateFrom: e.target.value || null })}
            />
            <TextField
              label="Hasta"
              type="date"
              value={filters.dateTo ?? ''}
              onChange={(e) => setFilters({ dateTo: e.target.value || null })}
            />
          </div>
          {rangeInvalid ? (
            <p role="alert" className="text-sm text-danger-text">
              La fecha «desde» es posterior a «hasta». Mientras tanto no se filtra por fechas.
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button
              variant="ghost"
              disabled={count === 0}
              onClick={() => {
                setFilters({ dateFrom: null, dateTo: null });
                setKind('all');
              }}
            >
              Quitar filtros
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

interface Chip {
  id: string;
  label: string;
  remove(): void;
}

/** Filtros activos como chips, cada uno con su botón "Quitar". No ocupa sitio si no hay ninguno. */
export function FilterChips() {
  const kind = useKind();
  const filters = useLibraryStore((s) => s.filters);
  const chips: Chip[] = [];
  if (kind !== 'all') {
    chips.push({ id: 'kind', label: KIND_LABELS[kind], remove: () => setKind('all') });
  }
  if (filters.dateFrom) {
    chips.push({
      id: 'from',
      label: dateLabel('Desde', filters.dateFrom),
      remove: () => setFilters({ dateFrom: null }),
    });
  }
  if (filters.dateTo) {
    chips.push({
      id: 'to',
      label: dateLabel('Hasta', filters.dateTo),
      remove: () => setFilters({ dateTo: null }),
    });
  }
  if (chips.length === 0) return null;
  return (
    <ul aria-label="Filtros activos" className="flex flex-wrap gap-2 px-6 pb-2">
      {chips.map((chip) => (
        <li
          key={chip.id}
          className="inline-flex items-center gap-1 rounded-full border border-border-strong bg-surface py-0.5 pr-1 pl-3 text-sm text-text"
        >
          {chip.label}
          <button
            type="button"
            aria-label={`Quitar filtro: ${chip.label}`}
            title="Quitar"
            onClick={chip.remove}
            className="inline-flex size-6 items-center justify-center rounded-full hover:bg-surface-hover"
          >
            <X aria-hidden="true" size={14} strokeWidth={2} />
          </button>
        </li>
      ))}
    </ul>
  );
}
