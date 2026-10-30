// Tema "Cine" (`cine`, anexo §8 y §10): estilo de plataforma de streaming, solo oscuro, casi negro
// con un resplandor violeta-índigo arriba, Plus Jakarta Sans (OFL), tarjetas de póster redondeadas y
// anillo de foco blanco. Colores propios; sin logotipos, nombres ni fuentes de ningún servicio.
//
// Paleta del anexo §10: fondo #09090F → #151030, violeta #7C5CFF, lavanda #B7A6FF, foco blanco. El
// texto blanco sobre #7C5CFF queda en 4,35:1 (< 4,5:1), así que el relleno `accent` es #7856FF
// (4,58:1, mismo tono); el #7C5CFF original se conserva en los velos (`accent-muted`, `selection`) y
// la lavanda es el color de acento para texto y bordes de selección (`selection-border`).
import {
  motionTokens,
  type ColorTokens,
  type MotionPreset,
  type SharedTokens,
  type ThemeTokens,
} from '../theme-types';

export const CINE_PALETTE = Object.freeze({
  bgTop: '#09090F',
  /** Fondo en el punto más claro del resplandor superior. */
  glow: '#151030',
  violet: '#7C5CFF',
  lavender: '#B7A6FF',
});

export const CINE_MOTION: MotionPreset = {
  fastMs: 120,
  normalMs: 220,
  slowMs: 320,
  ease: {
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
    emphasized: 'cubic-bezier(0.3, 0, 0, 1)',
    decelerate: 'cubic-bezier(0, 0, 0.2, 1)',
  },
  focusScale: 1.06,
  hoverScale: 1.03,
  staggerMs: 30,
};

const SHARED: SharedTokens = {
  'font-sans': "'Plus Jakarta Sans Variable', sans-serif",
  'font-display': "'Plus Jakarta Sans Variable', sans-serif",
  'font-hand': "'Plus Jakarta Sans Variable', sans-serif",
  'text-xs': '0.75rem',
  'text-sm': '0.875rem',
  'text-base': '1rem',
  'text-lg': '1.125rem',
  'text-xl': '1.3rem',
  'text-2xl': '1.85rem',
  'text-3xl': '2.75rem',
  'weight-regular': '400',
  'weight-strong': '700',
  'tracking-display': '-0.02em',
  'radius-sm': '8px',
  'radius-md': '12px',
  'radius-lg': '18px',
  'radius-tile': '14px',
  'radius-avatar': '28px',
  'border-width': '1px',
  'shadow-sm': '0 1px 3px rgba(0, 0, 0, 0.45)',
  'shadow-md': '0 8px 22px rgba(0, 0, 0, 0.5)',
  'shadow-lg': '0 22px 56px rgba(0, 0, 0, 0.6)',
  'blur-surface': '0px',
  'saturate-surface': '1',
  'space-unit': '4px',
  'tile-gap': '12px',
  'nav-width': '280px',
  ...motionTokens(CINE_MOTION),
};

const DARK: ColorTokens = {
  bg: CINE_PALETTE.bgTop,
  'bg-elevated': '#17172A',
  surface: '#15151F',
  'surface-2': '#1D1D2C',
  'surface-hover': '#272739',
  'surface-pressed': '#101018',
  'surface-alpha': 'rgba(14, 14, 24, 0.82)',
  border: '#2C2C42',
  'border-strong': '#8E8CAB',
  text: '#FFFFFF',
  'text-muted': '#BAB7D0',
  'text-on-accent': '#FFFFFF',
  accent: '#7856FF',
  'accent-hover': '#6A47F2',
  'accent-pressed': '#5B38DC',
  'accent-muted': 'rgba(124, 92, 255, 0.2)',
  'focus-ring': '#FFFFFF',
  selection: 'rgba(124, 92, 255, 0.32)',
  'selection-border': CINE_PALETTE.lavender,
  danger: '#C7283F',
  'danger-text': '#FF8A9B',
  warning: '#FFC247',
  success: '#5EDC9A',
  scrim: 'rgba(0, 0, 0, 0.88)',
  'tile-placeholder': '#1F1F32',
};

export const CINE_TOKENS: Readonly<Record<'dark', ThemeTokens>> = {
  dark: { ...DARK, ...SHARED },
};

/** Fondo `gradient`: CSS estático entre estos dos colores (el resplandor arriba, el casi negro abajo). */
export const CINE_BG_EXTREMES = {
  dark: [CINE_PALETTE.bgTop, CINE_PALETTE.glow],
} as const satisfies Record<'dark', readonly [string, string]>;
