// Con la bóveda abierta (docs/DESIGN.md §14.5): el shell del tema con el NavModel común, la pantalla
// activa, la barra de comandos de la galería, los atajos globales de §14.1 (Ctrl+L, Ctrl+I,
// Ctrl+Shift+I, Ctrl+F, F5, F1 y Ctrl+,) y el aviso de actividad para el bloqueo por inactividad
// (session:activity, como mucho cada 10 s). Aquí se montan también lo que debe seguir visible en
// cualquier pantalla: el panel de importación, la capa de soltar archivos, los diálogos de renombrar y
// eliminar (también los de playlists), el visor de fotos y vídeos (§16.1) y el traslado de la bóveda.
import { useEffect } from 'react';
import { installActivityReporter } from '../lib/activity';
import { announce } from '../lib/announce';
import { isCtrlKey, isTextInputTarget } from '../lib/keyboard';
import { toast } from '../lib/toast';
import { isImporting, startImport } from '../stores/import-store';
import { resetDual } from '../stores/dual-store';
import { subscribeLibrary } from '../stores/library-store';
import { resetMusic } from '../stores/music-store';
import { useNavStore } from '../stores/nav-store';
import { resetPresentation, startFromGallery } from '../stores/presentation-store';
import {
  closePlaylist,
  loadPlaylists,
  resetPlaylists,
  subscribePlaylists,
} from '../stores/playlists-store';
import { lockSession } from '../stores/session-store';
import { NAV_MODEL, type NavKey } from '../themes/shells/nav-model';
import { SidebarShell } from '../themes/shells/SidebarShell';
import { XmbShell } from '../themes/shells/XmbShell';
import { useTheme } from '../themes/use-theme';
import { CommandBar, GALLERY_SEARCH_ID, IMPORT_BUSY_TOOLTIP } from './gallery/CommandBar';
import { DeleteDialog } from './gallery/DeleteDialog';
import { DualVideoScreen } from './dual/DualVideoScreen';
import { MergeDialog } from './dual/MergeDialog';
import { galleryKindOf } from './gallery/gallery-nav';
import { GalleryScreen } from './gallery/GalleryScreen';
import { ImportDropZone } from './gallery/ImportDropZone';
import { ImportProgress } from './gallery/ImportProgress';
import { RenameDialog } from './gallery/RenameDialog';
import { HelpScreen } from './help/HelpScreen';
import { PlaylistDialogs } from './playlists/PlaylistDialogs';
import { PlaylistsScreen } from './playlists/PlaylistsScreen';
import { PresentationScreen } from './presentation/PresentationScreen';
import { PresentationSetupDialog } from './presentation/PresentationSetupDialog';
import { Viewer } from './viewer/Viewer';
import { RelocateDialog } from './settings/RelocateDialog';
import { SettingsScreen } from './settings/SettingsScreen';

function Screen({ active }: { active: NavKey }) {
  switch (active) {
    case 'settings':
      return <SettingsScreen />;
    case 'playlists':
      return <PlaylistsScreen />;
    case 'dual':
      return <DualVideoScreen />;
    case 'help':
      return <HelpScreen />;
    default:
      return <GalleryScreen />;
  }
}

/** Hay un diálogo modal abierto (los atajos globales no actúan por debajo, salvo Ctrl+L). */
function modalIsOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
}

function importFromShortcut(source: 'files' | 'folder'): void {
  if (isImporting()) {
    announce(IMPORT_BUSY_TOOLTIP);
    toast(IMPORT_BUSY_TOOLTIP);
    return;
  }
  void startImport(source);
}

function focusSearch(): void {
  const input = document.getElementById(GALLERY_SEARCH_ID);
  if (input) {
    input.focus();
    return;
  }
  // Desde otra pantalla: va a la galería y enfoca la búsqueda cuando ya está montada.
  useNavStore.getState().navigate('gallery-all');
  setTimeout(() => document.getElementById(GALLERY_SEARCH_ID)?.focus(), 120);
}

export function UnlockedApp() {
  const active = useNavStore((s) => s.active);
  const { def } = useTheme();

  useEffect(() => installActivityReporter(), []);
  // library:changed → recarga con debounce, también fuera de la galería (§10.2).
  useEffect(() => subscribeLibrary(), []);
  // Playlists: la lista (para el menú «Añadir a playlist» y el filtro de la galería) se carga al abrir
  // la bóveda y se refresca con library:changed; al bloquear no queda nada en memoria.
  useEffect(() => {
    void loadPlaylists();
    const off = subscribePlaylists();
    return () => {
      off();
      resetPlaylists();
      resetMusic();
      resetPresentation();
      resetDual();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // Bloquear funciona también desde un campo de texto: es la acción más segura.
      if (isCtrlKey(e, 'l')) {
        e.preventDefault();
        lockSession();
        return;
      }
      // El resto, sin un diálogo abierto y sin el foco en un campo de texto (§14.1).
      if (e.defaultPrevented || modalIsOpen() || isTextInputTarget(e.target)) return;
      const nav = useNavStore.getState();
      if (isCtrlKey(e, ',')) {
        e.preventDefault();
        nav.navigate('settings');
      } else if (isCtrlKey(e, 'i')) {
        e.preventDefault();
        importFromShortcut('files');
      } else if (
        e.ctrlKey &&
        e.shiftKey &&
        !e.altKey &&
        !e.metaKey &&
        e.key.toLowerCase() === 'i'
      ) {
        e.preventDefault();
        importFromShortcut('folder');
      } else if (isCtrlKey(e, 'f')) {
        e.preventDefault();
        focusSearch();
      } else if (e.key === 'F1') {
        e.preventDefault();
        nav.navigate('help');
      } else if (e.key === 'F5') {
        // F5 no debe recargar la ventana: empieza la presentación de la selección o, sin selección,
        // de todo lo visible en la galería (§17.1).
        e.preventDefault();
        if (galleryKindOf(nav.active) === null) {
          toast('Para empezar una presentación, ve a la galería y pulsa F5.');
        } else {
          void startFromGallery();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const navigate = (key: NavKey): void => {
    // Elegir «Playlists» en la navegación vuelve a la lista de tarjetas.
    if (key === 'playlists') closePlaylist();
    useNavStore.getState().navigate(key);
  };
  const screen = <Screen active={active} />;
  const commandBar =
    galleryKindOf(active) === null ? null : (
      <div className={def.shell === 'xmb' ? 'p-3 pb-1' : 'pb-2'}>
        <CommandBar />
      </div>
    );
  return (
    <>
      {def.shell === 'xmb' ? (
        <XmbShell nav={NAV_MODEL} active={active} onNavigate={navigate} commandBar={commandBar}>
          {screen}
        </XmbShell>
      ) : (
        <SidebarShell nav={NAV_MODEL} active={active} onNavigate={navigate} commandBar={commandBar}>
          {screen}
        </SidebarShell>
      )}
      <ImportProgress />
      <ImportDropZone />
      <RenameDialog />
      <DeleteDialog />
      <PlaylistDialogs />
      <Viewer />
      <PresentationSetupDialog />
      <PresentationScreen />
      {/* Fusión de vídeos (§18): sigue visible, y escuchando merge:progress/done, en cualquier pantalla. */}
      <MergeDialog />
      {/* Traslado de la bóveda (§8.7): progreso no descartable, visible en cualquier pantalla. */}
      <RelocateDialog />
    </>
  );
}
