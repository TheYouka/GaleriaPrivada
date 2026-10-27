// Valores por defecto de la presentación (docs/DESIGN.md §8.4 y §17.2). Solo datos puros: main los
// usa en prefs (settings-store.ts) y en presentation:getConfig; el renderer, en Ajustes →
// Presentación. Las pistas (`trackIds`) nunca van aquí: viven en la DB cifrada (playlist_music y
// kv['presentation.defaultTracks'], §9.2).
import type { PresentationPlainSettings, PresentationSettings } from './types';

export const DEFAULT_PRESENTATION: Readonly<PresentationPlainSettings> =
  Object.freeze<PresentationPlainSettings>({
    transition: 'fade',
    // Object.freeze es superficial: el array también se congela, porque el renderer lo importa.
    randomPool: Object.freeze([
      'fade',
      'slide',
      'zoom',
      'kenburns',
    ] as const) as unknown as PresentationPlainSettings['randomPool'],
    transitionMs: 700,
    slideMs: 5000,
    loop: true,
    animations: true,
    startFullscreen: true,
    audioMode: 'video',
    musicEnabled: false,
    musicVolume: 0.7,
    videoVolume: 1.0,
    musicFadeMs: 1500,
  });

/** Separa la forma del IPC en la parte en claro (prefs / presentation_json) y las pistas (DB). */
export function splitPresentation(settings: PresentationSettings): {
  plain: PresentationPlainSettings;
  trackIds: PresentationSettings['trackIds'];
} {
  const { trackIds, ...plain } = settings;
  return { plain: { ...plain, randomPool: [...plain.randomPool] }, trackIds: [...trackIds] };
}
