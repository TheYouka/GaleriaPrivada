// Maqueta ligera y estática del shell de un tema (docs/DESIGN.md §15.8): barra de título, navegación
// y 6 mosaicos de degradado, nunca contenido del usuario. Lleva su propio data-theme/data-scheme, así
// que los tokens del tema se aplican solo dentro. Una maqueta por shell: panel lateral (Clásico),
// pestañas y mosaicos planos (Mosaico), categorías XMB sobre ondas (Ondas), barra lateral de cristal
// y semáforo (Cristal) y barra superior con pósters sobre el degradado (Cine).
import type { ReactNode } from 'react';
import type { ColorScheme } from '@shared/themes';
import type { ShellKind, ThemeDefinition } from '../../themes/theme-types';
import { CINE_PALETTE } from '../../themes/tokens/cine';
import { MACOS_WALLPAPER } from '../../themes/tokens/macos';

const TILES = [0, 1, 2, 3, 4, 5];
const TILE_CLASS = 'block rounded-tile bg-linear-to-br from-accent-muted to-tile-placeholder';

function SidebarMock() {
  return (
    <>
      <span className="g-mica-glow absolute inset-0 block" />
      <span className="absolute inset-x-0 top-0 block h-3 bg-surface-alpha" />
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
          <span key={i} className={TILE_CLASS} />
        ))}
      </span>
    </>
  );
}

function XmbMock() {
  return (
    <>
      <span className="absolute inset-0 block bg-linear-to-b from-[#0A1A33] to-[#163460]">
        <span className="absolute inset-x-0 top-[58%] block h-6 -skew-y-3 bg-white/10" />
        <span className="absolute inset-x-0 top-[66%] block h-4 skew-y-2 bg-white/10" />
      </span>
      <span className="absolute inset-x-0 top-0 block h-3 bg-surface-alpha" />
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
          <span key={i} className={TILE_CLASS} />
        ))}
      </span>
    </>
  );
}

/** Mosaico: pestañas arriba (la activa con barra de acento) y mosaicos planos de 2×2, 2×1 y 1×1. */
function PivotMock() {
  return (
    <>
      <span className="absolute inset-x-0 top-0 block h-3 border-b border-border bg-bg" />
      <span className="absolute top-4 left-2 flex gap-3">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={`block h-1.5 w-8 ${i === 0 ? 'bg-text shadow-[0_3px_0_var(--g-accent)]' : 'bg-text-muted/60'}`}
          />
        ))}
      </span>
      <span className="absolute top-8 right-2 bottom-2 left-2 grid grid-cols-4 grid-rows-3 gap-0.5">
        <span className="col-span-2 row-span-2 block border-2 border-focus-ring bg-linear-to-br from-accent-muted to-tile-placeholder" />
        <span className="block bg-linear-to-br from-accent-muted to-tile-placeholder" />
        <span className="block bg-linear-to-br from-accent-muted to-tile-placeholder" />
        <span className="col-span-2 block bg-linear-to-br from-accent-muted to-tile-placeholder" />
        <span className="block bg-linear-to-br from-accent-muted to-tile-placeholder" />
        <span className="block bg-linear-to-br from-accent-muted to-tile-placeholder" />
        <span className="block bg-linear-to-br from-accent-muted to-tile-placeholder" />
      </span>
    </>
  );
}

/** Cristal: fondo degradado propio, barra lateral translúcida y semáforo a la izquierda. */
function VibrancyMock({ scheme }: { scheme: ColorScheme }) {
  const w = MACOS_WALLPAPER[scheme === 'dark' ? 'dark' : 'light'];
  return (
    <>
      <span
        className="absolute inset-0 block"
        style={{ backgroundImage: `linear-gradient(135deg, ${w.from}, ${w.to})` }}
      />
      <span className="absolute top-1.5 left-2 flex gap-1">
        <span className="block size-2 rounded-full bg-[#EE6A5F]" />
        <span className="block size-2 rounded-full bg-[#F5BE4F]" />
        <span className="block size-2 rounded-full bg-[#62C554]" />
      </span>
      <span className="absolute top-5 bottom-0 left-0 flex w-14 flex-col gap-1.5 border-r border-border bg-surface-alpha p-2">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={`block h-1.5 rounded-full ${i === 0 ? 'bg-accent' : 'bg-text-muted/60'}`}
          />
        ))}
      </span>
      <span className="absolute top-6 right-2 bottom-2 left-16 grid grid-cols-3 gap-1.5">
        {TILES.map((i) => (
          <span key={i} className={`${TILE_CLASS} shadow-sm`} />
        ))}
      </span>
    </>
  );
}

/** Cine: degradado violeta sobre casi negro, barra superior y tarjetas de póster. */
function TopbarMock() {
  return (
    <>
      <span
        className="absolute inset-0 block"
        style={{
          backgroundColor: CINE_PALETTE.bgTop,
          backgroundImage: `radial-gradient(ellipse 95% 62% at 50% 0%, ${CINE_PALETTE.glow} 0%, ${CINE_PALETTE.bgTop} 100%)`,
        }}
      />
      <span className="absolute top-3 right-3 left-3 flex items-center gap-3">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={`block h-1.5 w-8 rounded-full ${i === 0 ? 'bg-text' : 'bg-text-muted/60'}`}
          />
        ))}
        <span className="ml-auto block size-3 rounded-full bg-accent" />
      </span>
      <span className="absolute top-9 right-3 bottom-2 left-3 grid grid-cols-5 gap-1.5">
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={`${TILE_CLASS} ${i === 1 ? 'outline-2 outline-focus-ring' : ''} relative overflow-hidden`}
          >
            <span className="absolute inset-x-0 bottom-0 block h-1.5 bg-surface" />
          </span>
        ))}
      </span>
    </>
  );
}

function mockFor(shell: ShellKind, scheme: ColorScheme): ReactNode {
  switch (shell) {
    case 'xmb':
      return <XmbMock />;
    case 'pivot':
      return <PivotMock />;
    case 'vibrancy':
      return <VibrancyMock scheme={scheme} />;
    case 'topbar':
      return <TopbarMock />;
    case 'sidebar':
      return <SidebarMock />;
  }
}

export function ThemePreview({ theme, scheme }: { theme: ThemeDefinition; scheme: ColorScheme }) {
  const resolved = theme.schemes.includes(scheme) ? scheme : (theme.schemes[0] as ColorScheme);
  return (
    <span
      aria-hidden="true"
      data-theme={theme.id}
      data-scheme={resolved}
      data-preview-shell={theme.shell}
      className="relative block h-28 w-full overflow-hidden rounded-md border border-border bg-bg font-sans"
    >
      {mockFor(theme.shell, resolved)}
    </span>
  );
}
