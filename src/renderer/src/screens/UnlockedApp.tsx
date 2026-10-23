// Con la bóveda abierta (docs/DESIGN.md §14.5): el shell del tema con el NavModel común, la pantalla
// activa, los atajos globales (Ctrl+L bloquea, Ctrl+, abre Ajustes) y el aviso de actividad para el
// bloqueo por inactividad (session:activity, como mucho cada 10 s).
import { useEffect } from 'react';
import { installActivityReporter } from '../lib/activity';
import { isCtrlKey, isTextInputTarget } from '../lib/keyboard';
import { useNavStore } from '../stores/nav-store';
import { lockSession } from '../stores/session-store';
import { NAV_MODEL, navLabel, type NavKey } from '../themes/shells/nav-model';
import { SidebarShell } from '../themes/shells/SidebarShell';
import { XmbShell } from '../themes/shells/XmbShell';
import { useTheme } from '../themes/use-theme';
import { PlaceholderScreen } from './PlaceholderScreen';
import { SettingsScreen } from './settings/SettingsScreen';

function Screen({ active }: { active: NavKey }) {
  switch (active) {
    case 'settings':
      return <SettingsScreen />;
    case 'playlists':
      return (
        <PlaceholderScreen title="Playlists">
          Las playlists llegan en una fase posterior.
        </PlaceholderScreen>
      );
    case 'dual':
      return (
        <PlaceholderScreen title="Vídeo dual">
          El vídeo dual llega en una fase posterior.
        </PlaceholderScreen>
      );
    case 'help':
      return (
        <PlaceholderScreen title="Ayuda">
          <p>La ayuda completa llega en la siguiente fase. Atajos disponibles:</p>
          <ul className="mt-3 list-disc pl-6">
            <li>Ctrl+L: bloquear</li>
            <li>Ctrl+, : ajustes</li>
          </ul>
        </PlaceholderScreen>
      );
    default:
      return (
        <PlaceholderScreen title={navLabel(NAV_MODEL, active)}>
          Tu bóveda está lista. La importación llega en la siguiente fase.
        </PlaceholderScreen>
      );
  }
}

export function UnlockedApp() {
  const active = useNavStore((s) => s.active);
  const { def } = useTheme();

  useEffect(() => installActivityReporter(), []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // Bloquear funciona también desde un campo de texto: es la acción más segura.
      if (isCtrlKey(e, 'l')) {
        e.preventDefault();
        lockSession();
        return;
      }
      if (isCtrlKey(e, ',') && !isTextInputTarget(e.target)) {
        e.preventDefault();
        useNavStore.getState().navigate('settings');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const navigate = (key: NavKey): void => useNavStore.getState().navigate(key);
  const screen = <Screen active={active} />;
  return def.shell === 'xmb' ? (
    <XmbShell nav={NAV_MODEL} active={active} onNavigate={navigate} commandBar={null}>
      {screen}
    </XmbShell>
  ) : (
    <SidebarShell nav={NAV_MODEL} active={active} onNavigate={navigate} commandBar={null}>
      {screen}
    </SidebarShell>
  );
}
