// Monta el fondo del tema detrás del shell (docs/DESIGN.md §15.7) [H3-10] y le pasa `paused`, que es
// verdadero con el documento oculto, la ventana minimizada o no visible, una presentación activa o un
// vídeo reproduciéndose (F3–F5 lo indican con las props).
import { useDocumentHidden } from '../lib/use-media';
import { useThemeStore } from '../stores/theme-store';
import { isBackgroundPaused } from './background-paused';
import { GradientBackground } from './backgrounds/GradientBackground';
import { MicaBackground } from './backgrounds/MicaBackground';
import { SolidBackground } from './backgrounds/SolidBackground';
import { WallpaperBackground } from './backgrounds/WallpaperBackground';
import { WavesBackground } from './backgrounds/WavesBackground';
import type { BackgroundKind } from './theme-types';

export interface BackgroundHostProps {
  kind: BackgroundKind;
  presentationActive?: boolean;
  videoPlaying?: boolean;
}

export function BackgroundHost({
  kind,
  presentationActive = false,
  videoPlaying = false,
}: BackgroundHostProps) {
  const documentHidden = useDocumentHidden();
  const minimized = useThemeStore((s) => s.windowState.minimized);
  const visible = useThemeStore((s) => s.windowState.visible);
  const reducedMotion = useThemeStore((s) => s.reducedMotion);
  const paused = isBackgroundPaused({
    documentHidden,
    minimized,
    visible,
    presentationActive,
    videoPlaying,
  });
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
      data-background={kind}
      data-paused={paused ? 'true' : 'false'}
    >
      {kind === 'waves' ? (
        <WavesBackground paused={paused} reducedMotion={reducedMotion} />
      ) : kind === 'solid' ? (
        <SolidBackground />
      ) : kind === 'wallpaper' ? (
        <WallpaperBackground />
      ) : kind === 'gradient' ? (
        <GradientBackground />
      ) : (
        <MicaBackground />
      )}
    </div>
  );
}
