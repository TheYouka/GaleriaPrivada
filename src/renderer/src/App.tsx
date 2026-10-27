// Raíz del renderer: movimiento según el sistema (<MotionConfig reducedMotion="user">, §14.1), tema
// (§15), fondo, barra de título propia y, según la sesión, las pantallas de perfiles o el shell.
// La barra de título va al final del DOM (sus botones quedan al final del orden de Tab, §15.6) y se
// coloca arriba con la rejilla.
import { useEffect } from 'react';
import { MotionConfig } from 'motion/react';
import { LiveRegion } from './components/LiveRegion';
import { Toaster } from './components/Toast';
import { ProfilesFlow } from './screens/profiles/ProfilesFlow';
import { UnlockedApp } from './screens/UnlockedApp';
import { usePlayerStore } from './stores/player-store';
import { usePresentationStore } from './stores/presentation-store';
import {
  bootstrapSession,
  lockSession,
  subscribeWindowState,
  useSessionStore,
} from './stores/session-store';
import { BackgroundHost } from './themes/BackgroundHost';
import { ThemeProvider } from './themes/ThemeProvider';
import { Titlebar } from './themes/titlebars/Titlebar';
import { useTheme } from './themes/use-theme';

function Frame() {
  const status = useSessionStore((s) => s.status);
  const { def } = useTheme();
  const videoPlaying = usePlayerStore((s) => s.playing);
  // Los fondos animados se pausan mientras hay una presentación en pantalla (§15.7, §17.7).
  const presentationActive = usePresentationStore((s) => s.active !== null);
  const titlebar = def.titlebar === 'xmb' ? 'xmb' : 'fluent';

  return (
    <div className="grid h-full grid-rows-[2rem_minmax(0,1fr)] font-sans text-text">
      <BackgroundHost
        kind={def.background}
        videoPlaying={videoPlaying}
        presentationActive={presentationActive}
      />
      <div className="relative z-10 row-start-2 min-h-0">
        {status === 'unlocked' ? <UnlockedApp /> : status === 'locked' ? <ProfilesFlow /> : null}
      </div>
      <Titlebar
        variant={titlebar}
        onLock={status === 'unlocked' ? lockSession : undefined}
        className="row-start-1"
      />
    </div>
  );
}

export function App() {
  useEffect(() => {
    void bootstrapSession();
    return subscribeWindowState();
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      <ThemeProvider>
        <Frame />
        <LiveRegion />
        <Toaster />
      </ThemeProvider>
    </MotionConfig>
  );
}
