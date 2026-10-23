// Tema "Clásico" (`fotos`, docs/DESIGN.md §15.2): inspirado en Fotos de Windows 11 (Fluent), claro
// y oscuro, Inter (OFL), radio 8 px, acento claro #005FB8 y oscuro #60CDFF. Colores propios; sin
// fuentes ni recursos de Microsoft.
import { mix } from '../contrast';
import {
  motionTokens,
  type ColorTokens,
  type MotionPreset,
  type SharedTokens,
  type ThemeTokens,
} from '../theme-types';

export const FOTOS_MOTION: MotionPreset = {
  fastMs: 120,
  normalMs: 200,
  slowMs: 320,
  ease: {
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
    emphasized: 'cubic-bezier(0.3, 0, 0, 1)',
    decelerate: 'cubic-bezier(0, 0, 0, 1)',
  },
  focusScale: 1.08,
  hoverScale: 1.04,
  staggerMs: 40,
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
  'tracking-display': '-0.01em',
  'radius-sm': '4px',
  'radius-md': '8px',
  'radius-lg': '12px',
  'radius-tile': '8px',
  'radius-avatar': '8px',
  'border-width': '1px',
  'shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.14)',
  'shadow-md': '0 4px 12px rgba(0, 0, 0, 0.18)',
  'shadow-lg': '0 16px 40px rgba(0, 0, 0, 0.28)',
  'blur-surface': '0px',
  'saturate-surface': '1',
  'space-unit': '4px',
  'tile-gap': '4px',
  'nav-width': '280px',
  ...motionTokens(FOTOS_MOTION),
};

const LIGHT: ColorTokens = {
  bg: '#F3F3F3',
  'bg-elevated': '#FFFFFF',
  surface: '#FFFFFF',
  'surface-2': '#F9F9F9',
  'surface-hover': '#EDEDED',
  'surface-pressed': '#E3E3E3',
  'surface-alpha': 'rgba(255, 255, 255, 0.72)',
  border: '#E0E0E0',
  'border-strong': '#767676',
  text: '#1A1A1A',
  'text-muted': '#595959',
  'text-on-accent': '#FFFFFF',
  accent: '#005FB8',
  'accent-hover': '#1A6CBC',
  'accent-pressed': '#004C94',
  'accent-muted': 'rgba(0, 95, 184, 0.12)',
  'focus-ring': '#1A1A1A',
  selection: 'rgba(0, 95, 184, 0.18)',
  'selection-border': '#005FB8',
  danger: '#C42B1C',
  'danger-text': '#B3261E',
  warning: '#9D5D00',
  success: '#0F7B0F',
  scrim: 'rgba(0, 0, 0, 0.88)',
  'tile-placeholder': '#E3E3E3',
};

const DARK: ColorTokens = {
  bg: '#1B1B1F',
  'bg-elevated': '#2B2B30',
  surface: '#2C2C31',
  'surface-2': '#323237',
  'surface-hover': '#3A3A40',
  'surface-pressed': '#26262B',
  'surface-alpha': 'rgba(44, 44, 49, 0.72)',
  border: '#3D3D44',
  'border-strong': '#9A9AA2',
  text: '#F2F2F2',
  'text-muted': '#C8C8CE',
  'text-on-accent': '#000000',
  accent: '#60CDFF',
  'accent-hover': '#7AD5FF',
  'accent-pressed': '#4CB6E6',
  'accent-muted': 'rgba(96, 205, 255, 0.16)',
  'focus-ring': '#FFFFFF',
  selection: 'rgba(96, 205, 255, 0.24)',
  'selection-border': '#60CDFF',
  danger: '#FF99A4',
  'danger-text': '#FF99A4',
  warning: '#FCE100',
  success: '#6CCB5F',
  scrim: 'rgba(0, 0, 0, 0.88)',
  'tile-placeholder': '#333339',
};

export const FOTOS_TOKENS: Readonly<Record<'light' | 'dark', ThemeTokens>> = {
  light: { ...LIGHT, ...SHARED },
  dark: { ...DARK, ...SHARED },
};

/**
 * Fondo `mica`: degradado radial del acento al 15 % sobre `bg` (MicaBackground). Los extremos son
 * `bg` y `bg` con el acento al 15 %.
 */
export const FOTOS_BG_EXTREMES = {
  light: [LIGHT.bg, mix(LIGHT.bg, LIGHT.accent, 0.15)],
  dark: [DARK.bg, mix(DARK.bg, DARK.accent, 0.15)],
} as const satisfies Record<'light' | 'dark', readonly [string, string]>;
