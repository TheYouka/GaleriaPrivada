// Tema "Cristal" (`macos`, docs/DESIGN.md §15.2): inspirado en un escritorio con materiales
// translúcidos (barra lateral con vibrancy), claro y oscuro, Inter (OFL), radio 10 px y acento azul
// (#2F7CF6 en oscuro; en claro #1F6FEB, que con texto blanco llega a 4,5:1). Colores propios; sin
// fuentes ni recursos de Apple.
import {
  motionTokens,
  type ColorTokens,
  type MotionPreset,
  type SharedTokens,
  type ThemeTokens,
} from '../theme-types';

export const MACOS_MOTION: MotionPreset = {
  fastMs: 120,
  normalMs: 220,
  slowMs: 350,
  ease: {
    standard: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
    emphasized: 'cubic-bezier(0.2, 0, 0, 1)',
    decelerate: 'cubic-bezier(0, 0, 0.2, 1)',
  },
  focusScale: 1.04,
  hoverScale: 1.02,
  staggerMs: 35,
};

const SHARED: SharedTokens = {
  'font-sans': "'Inter Variable', sans-serif",
  'font-display': "'Inter Variable', sans-serif",
  'font-hand': "'Inter Variable', sans-serif",
  'text-xs': '0.75rem',
  'text-sm': '0.875rem',
  'text-base': '1rem',
  'text-lg': '1.125rem',
  'text-xl': '1.25rem',
  'text-2xl': '1.75rem',
  'text-3xl': '2.5rem',
  'weight-regular': '400',
  'weight-strong': '600',
  'tracking-display': '-0.02em',
  'radius-sm': '6px',
  'radius-md': '10px',
  'radius-lg': '14px',
  'radius-tile': '10px',
  'radius-avatar': '9999px',
  'border-width': '1px',
  'shadow-sm': '0 1px 3px rgba(0, 0, 0, 0.12)',
  'shadow-md': '0 6px 20px rgba(0, 0, 0, 0.16)',
  'shadow-lg': '0 20px 50px rgba(0, 0, 0, 0.26)',
  'blur-surface': '24px',
  'saturate-surface': '1.6',
  'space-unit': '4px',
  'tile-gap': '6px',
  'nav-width': '240px',
  ...motionTokens(MACOS_MOTION),
};

const LIGHT: ColorTokens = {
  bg: '#EDF0F7',
  'bg-elevated': '#FFFFFF',
  surface: '#FFFFFF',
  'surface-2': '#F5F6FA',
  'surface-hover': '#E9EBF2',
  'surface-pressed': '#DDE0EA',
  'surface-alpha': 'rgba(246, 247, 251, 0.72)',
  border: '#D6D9E3',
  'border-strong': '#767A88',
  text: '#1D1D1F',
  'text-muted': '#52545C',
  'text-on-accent': '#FFFFFF',
  accent: '#1F6FEB',
  'accent-hover': '#1A64DA',
  'accent-pressed': '#1456C0',
  'accent-muted': 'rgba(31, 111, 235, 0.14)',
  'focus-ring': '#0B5FD9',
  selection: 'rgba(31, 111, 235, 0.2)',
  'selection-border': '#1F6FEB',
  danger: '#C62828',
  'danger-text': '#B3261E',
  warning: '#8A5300',
  success: '#1E7B34',
  scrim: 'rgba(0, 0, 0, 0.88)',
  'tile-placeholder': '#E1E4EE',
};

const DARK: ColorTokens = {
  bg: '#1C1C20',
  'bg-elevated': '#2C2C31',
  surface: '#2A2A2F',
  'surface-2': '#34343A',
  'surface-hover': '#3E3E45',
  'surface-pressed': '#232327',
  'surface-alpha': 'rgba(40, 40, 46, 0.72)',
  border: '#46464E',
  'border-strong': '#9A9AA4',
  text: '#F5F5F7',
  'text-muted': '#B9B9C2',
  // Texto oscuro sobre el azul: el blanco sobre #2F7CF6 queda en 3,9:1 (< 4,5:1).
  'text-on-accent': '#000000',
  accent: '#3D88F7',
  'accent-hover': '#5B9AF9',
  'accent-pressed': '#2F7CF6',
  'accent-muted': 'rgba(61, 136, 247, 0.2)',
  'focus-ring': '#FFFFFF',
  selection: 'rgba(61, 136, 247, 0.3)',
  'selection-border': '#6AA5FA',
  danger: '#FF8A94',
  'danger-text': '#FF9AA3',
  warning: '#FFD060',
  success: '#6CD58A',
  scrim: 'rgba(0, 0, 0, 0.88)',
  'tile-placeholder': '#34343B',
};

export const MACOS_TOKENS: Readonly<Record<'light' | 'dark', ThemeTokens>> = {
  light: { ...LIGHT, ...SHARED },
  dark: { ...DARK, ...SHARED },
};

/**
 * Fondo `wallpaper` (§15.2): degradado SVG propio entre dos colores por esquema. Los extremos de
 * `bgExtremes` son estos mismos colores; WallpaperBackground de 6.3 no pinta nada fuera de ellos.
 */
export const MACOS_WALLPAPER = Object.freeze({
  light: { from: '#EAF0FC', to: '#CFD9F2' },
  dark: { from: '#0E1322', to: '#2A2457' },
} as const);

export const MACOS_BG_EXTREMES = {
  light: [MACOS_WALLPAPER.light.from, MACOS_WALLPAPER.light.to],
  dark: [MACOS_WALLPAPER.dark.from, MACOS_WALLPAPER.dark.to],
} as const satisfies Record<'light' | 'dark', readonly [string, string]>;
