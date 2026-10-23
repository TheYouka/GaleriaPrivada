// Maqueta ligera y estática del shell de un tema (docs/DESIGN.md §15.8): barra de título, navegación
// y 6 mosaicos de degradado, nunca contenido del usuario. Lleva su propio data-theme/data-scheme, así
// que los tokens del tema se aplican solo dentro.
import type { ColorScheme } from '@shared/themes';
import type { ThemeDefinition } from '../../themes/theme-types';

const TILES = [0, 1, 2, 3, 4, 5];

export function ThemePreview({ theme, scheme }: { theme: ThemeDefinition; scheme: ColorScheme }) {
  const resolved = theme.schemes.includes(scheme) ? scheme : (theme.schemes[0] as ColorScheme);
  const xmb = theme.shell === 'xmb';
  return (
    <span
      aria-hidden="true"
      data-theme={theme.id}
      data-scheme={resolved}
      className="relative block h-28 w-full overflow-hidden rounded-md border border-border bg-bg font-sans"
    >
      {xmb ? (
        <span className="absolute inset-0 block bg-linear-to-b from-[#0A1A33] to-[#163460]">
          <span className="absolute inset-x-0 top-[58%] block h-6 -skew-y-3 bg-white/10" />
          <span className="absolute inset-x-0 top-[66%] block h-4 skew-y-2 bg-white/10" />
        </span>
      ) : (
        <span className="g-mica-glow absolute inset-0 block" />
      )}
      <span className="absolute inset-x-0 top-0 block h-3 bg-surface-alpha" />
      {xmb ? (
        <>
          <span className="absolute top-5 left-3 flex gap-2">
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                className={`block size-3 rounded-full ${i === 1 ? 'bg-accent' : 'bg-text-muted/60'}`}
              />
            ))}
          </span>
          <span className="absolute top-11 left-8 flex flex-col gap-1">
            {[0, 1, 2].map((i) => (
              <span key={i} className="block h-1.5 w-8 rounded-full bg-text/70" />
            ))}
          </span>
          <span className="absolute top-10 right-2 bottom-2 left-20 grid grid-cols-3 gap-1 rounded-sm bg-surface-alpha p-1">
            {TILES.map((i) => (
              <span
                key={i}
                className="block rounded-tile bg-linear-to-br from-accent-muted to-tile-placeholder"
              />
            ))}
          </span>
        </>
      ) : (
        <>
          <span className="absolute top-5 bottom-2 left-2 flex w-12 flex-col gap-1.5">
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                className={`block h-1.5 rounded-full ${i === 0 ? 'bg-accent' : 'bg-text-muted/60'}`}
              />
            ))}
          </span>
          <span className="absolute top-5 right-2 bottom-2 left-16 grid grid-cols-3 gap-1 rounded-sm bg-surface-alpha p-1">
            {TILES.map((i) => (
              <span
                key={i}
                className="block rounded-tile bg-linear-to-br from-accent-muted to-tile-placeholder"
              />
            ))}
          </span>
        </>
      )}
    </span>
  );
}
