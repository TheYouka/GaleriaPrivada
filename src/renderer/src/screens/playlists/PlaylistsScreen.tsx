// Pantalla Playlists (docs/DESIGN.md §14.8): tarjetas con la miniatura del primer elemento como
// portada, el nombre y el número de elementos; "Nueva playlist"; y un menú por tarjeta con Abrir,
// Presentación, Renombrar y Eliminar (con confirmación; borra la playlist, no los medios). Al abrir
// una playlist se muestra su detalle (PlaylistDetail) en esta misma pantalla. Solo usa tokens del
// tema (superficies, bordes y radio de mosaico) y las clases `g-pl-*` de styles/themes.css (6.4): la
// estructura y el teclado son los mismos en los 5 temas; Mosaico la ve como mosaicos 2×2/2×1/1×1,
// Ondas como lista, Cristal como tarjetas con sombra y Cine como pósters.
import { Ellipsis, ListVideo, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import type { PlaylistSummary } from '@shared/types';
import { Button } from '../../components/Button';
import { ScreenHeading } from '../../components/ScreenHeading';
import { errorMessage } from '../../lib/errors-es';
import { thumbUrl } from '../../lib/vault-url';
import {
  loadPlaylists,
  openPlaylist,
  plural,
  requestCreatePlaylist,
  requestDeletePlaylist,
  requestRenamePlaylist,
  usePlaylistsStore,
} from '../../stores/playlists-store';
import { startFromPlaylist } from '../../stores/presentation-store';
import { PlaylistDetail } from './PlaylistDetail';

const MENU_CONTENT =
  'z-50 min-w-48 rounded-md border border-border bg-bg-elevated p-1 text-text shadow-md';
const MENU_ITEM =
  'relative flex h-9 cursor-default items-center gap-2 rounded-sm px-3 text-sm outline-none data-disabled:opacity-50 data-highlighted:bg-surface-hover data-highlighted:outline-2 data-highlighted:outline-focus-ring';

function PlaylistCard({ playlist }: { playlist: PlaylistSummary }) {
  return (
    <li className="g-pl-card group relative">
      <button
        type="button"
        onClick={() => openPlaylist(playlist.id)}
        aria-label={`${playlist.name}, ${plural(playlist.itemCount, 'elemento', 'elementos')}`}
        className="g-pl-btn flex w-full flex-col overflow-hidden rounded-tile border border-border-strong bg-surface-alpha text-left text-text transition-colors hover:bg-surface-hover"
      >
        <span className="g-pl-cover relative flex aspect-video w-full items-center justify-center overflow-hidden bg-tile-placeholder">
          {playlist.coverMediaId ? (
            <img
              src={thumbUrl(playlist.coverMediaId, playlist.updatedAt)}
              alt=""
              draggable={false}
              className="absolute inset-0 size-full object-cover"
            />
          ) : (
            <ListVideo aria-hidden="true" size={36} strokeWidth={1.5} className="text-text-muted" />
          )}
        </span>
        <span className="g-pl-info flex flex-col gap-0.5 px-3 py-2 pr-11">
          <span className="truncate text-base font-semibold">{playlist.name}</span>
          <span className="text-sm text-text-muted">
            {plural(playlist.itemCount, 'elemento', 'elementos')}
          </span>
        </span>
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label={`Opciones de «${playlist.name}»`}
            title="Opciones"
            className="g-pl-opts absolute right-1.5 bottom-1.5 inline-flex size-9 items-center justify-center rounded-md text-text hover:bg-surface-hover"
          >
            <Ellipsis aria-hidden="true" size={18} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            aria-label={`Opciones de «${playlist.name}»`}
            className={MENU_CONTENT}
          >
            <DropdownMenu.Item className={MENU_ITEM} onSelect={() => openPlaylist(playlist.id)}>
              <ListVideo aria-hidden="true" size={16} />
              Abrir
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className={MENU_ITEM}
              onSelect={() => void startFromPlaylist(playlist)}
            >
              <Play aria-hidden="true" size={16} />
              Presentación
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className={MENU_ITEM}
              onSelect={() => requestRenamePlaylist(playlist)}
            >
              <Pencil aria-hidden="true" size={16} />
              Renombrar
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <DropdownMenu.Item
              className={`${MENU_ITEM} text-danger-text`}
              onSelect={() => requestDeletePlaylist(playlist)}
            >
              <Trash2 aria-hidden="true" size={16} />
              Eliminar
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </li>
  );
}

function PlaylistList() {
  const playlists = usePlaylistsStore((s) => s.playlists);
  const status = usePlaylistsStore((s) => s.status);
  const error = usePlaylistsStore((s) => s.error);
  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-wrap items-center gap-3">
        <ScreenHeading className="text-2xl text-text">Playlists</ScreenHeading>
        {status === 'ready' ? (
          <p className="text-sm text-text-muted">
            {plural(playlists.length, 'playlist', 'playlists')}
          </p>
        ) : null}
        <Button variant="primary" className="ml-auto" onClick={() => requestCreatePlaylist()}>
          <Plus aria-hidden="true" size={16} strokeWidth={1.75} />
          Nueva playlist
        </Button>
      </header>
      {status === 'error' ? (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-danger-text">
            {errorMessage(error)}
          </p>
          <Button onClick={() => void loadPlaylists()}>Reintentar</Button>
        </div>
      ) : status !== 'ready' ? (
        <p role="status" className="text-text-muted">
          Cargando…
        </p>
      ) : playlists.length === 0 ? (
        <p className="max-w-prose text-text">
          Todavía no hay playlists. Crea una con «Nueva playlist», o selecciona fotos y vídeos en la
          galería y elige «Añadir a playlist».
        </p>
      ) : (
        <ul
          aria-label="Playlists"
          className="g-pl-grid grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4"
        >
          {playlists.map((p) => (
            <PlaylistCard key={p.id} playlist={p} />
          ))}
        </ul>
      )}
    </div>
  );
}

export function PlaylistsScreen() {
  const openId = usePlaylistsStore((s) => s.openId);
  return openId ? <PlaylistDetail key={openId} id={openId} /> : <PlaylistList />;
}
