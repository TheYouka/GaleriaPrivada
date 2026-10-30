// Tema "Mosaico" (`xbox`, docs/DESIGN.md §15.2): inspirado en el panel de una consola de sobremesa
// (mosaicos planos de distintos tamaños), solo oscuro, Noto Sans (OFL), sin radio, acento verde
// #2E9E44, foco con escala 1,06 y borde de 3 px. Colores propios; sin fuentes ni recursos de
// Microsoft.
import {
  motionTokens,
  type ColorTokens,
  type MotionPreset,
  type SharedTokens,
  type ThemeTokens,
} from '../theme-types';

export const XBOX_MOTION: MotionPreset = {
  fastMs: 100,
  normalMs: 180,
  slowMs: 280,
  ease: {
    standard: 'cubic-bezier(0.1, 0.9, 0.2, 1)',
    emphasized: 'cubic-bezier(0.2, 0, 0, 1)',
    decelerate: 'cubic-bezier(0, 0, 0.2, 1)',
  },
  focusScale: 1.06,
  hoverScale: 1.02,
  staggerMs: 30,
};

const SHARED: SharedTokens = {
  'font-sans': "'Noto Sans Variable', sans-serif",
  'font-display': "'Noto Sans Variable', sans-serif",
  'font-hand': "'Noto Sans Variable', sans-serif",
  'text-xs': '0.75rem',
  'text-sm': '0.875rem',
  'text-base': '1rem',
  'text-lg': '1.125rem',
  'text-xl': '1.375rem',
  'text-2xl': '1.875rem',
  'text-3xl': '2.75rem',
  'weight-regular': '400',
  'weight-strong': '600',
  'tracking-display': '0',
  'radius-sm': '0px',
  'radius-md': '0px',
  'radius-lg': '0px',
  'radius-tile': '0px',
  'radius-avatar': '0px',
  'border-width': '2px',
  'shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.5)',
  'shadow-md': '0 4px 12px rgba(0, 0, 0, 0.55)',
  'shadow-lg': '0 14px 36px rgba(0, 0, 0, 0.65)',
  'blur-surface': '0px',
  'saturate-surface': '1',
  'space-unit': '4px',
  'tile-gap': '4px',
  'nav-width': '280px',
  ...motionTokens(XBOX_MOTION),
};

const DARK: ColorTokens = {
  bg: '#0E0E0E',
  'bg-elevated': '#1F1F1F',
  surface: '#1C1C1C',
  'surface-2': '#262626',
  'surface-hover': '#303030',
  'surface-pressed': '#141414',
  'surface-alpha': 'rgba(24, 24, 24, 0.88)',
  border: '#383838',
  'border-strong': '#8C8C8C',
  text: '#FFFFFF',
  'text-muted': '#BEBEBE',
  // Texto oscuro sobre el verde: el blanco sobre #2E9E44 queda en 3,4:1 (< 4,5:1).
  'text-on-accent': '#000000',
  accent: '#2E9E44',
  'accent-hover': '#3FB555',
  'accent-pressed': '#2A9440',
  'accent-muted': 'rgba(46, 158, 68, 0.18)',
  'focus-ring': '#FFFFFF',
  selection: 'rgba(46, 158, 68, 0.3)',
  'selection-border': '#5FD375',
  danger: '#FF6B6B',
  'danger-text': '#FF8A8A',
  warning: '#FFC83D',
  success: '#5FD375',
  scrim: 'rgba(0, 0, 0, 0.88)',
  'tile-placeholder': '#2A2A2A',
};

export const XBOX_TOKENS: Readonly<Record<'dark', ThemeTokens>> = {
  dark: { ...DARK, ...SHARED },
};

/**
 * Fondo `solid` (§15.2): `bg` con una viñeta. Los extremos son el borde de la viñeta (más oscuro) y
 * su centro (más claro). BackgroundHost de 6.3 pinta exactamente entre estos dos colores.
 */
export const XBOX_VIGNETTE = Object.freeze({ edge: '#060606', center: '#171717' });

export const XBOX_BG_EXTREMES = {
  dark: [XBOX_VIGNETTE.edge, XBOX_VIGNETTE.center],
} as const satisfies Record<'dark', readonly [string, string]>;
