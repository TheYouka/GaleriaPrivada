// Tema "Ondas" (`ps3`, docs/DESIGN.md §15.2), stub de F1: solo oscuro, Nunito (OFL), texto y acento
// blancos sobre el azul de las ondas. F6 lo completa (color del mes, brillo por hora). Colores
// propios; sin recursos de Sony.
import { wavesExtremes, WAVES_PALETTE } from '../backgrounds/waves';
import {
  motionTokens,
  type ColorTokens,
  type MotionPreset,
  type SharedTokens,
  type ThemeTokens,
} from '../theme-types';

export const PS3_MOTION: MotionPreset = {
  fastMs: 150,
  normalMs: 250,
  slowMs: 400,
  ease: {
    standard: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
    emphasized: 'cubic-bezier(0.2, 0, 0, 1)',
    decelerate: 'cubic-bezier(0, 0, 0.2, 1)',
  },
  focusScale: 1.2,
  hoverScale: 1.08,
  staggerMs: 40,
};

const SHARED: SharedTokens = {
  'font-sans': "'Nunito Variable', sans-serif",
  'font-display': "'Nunito Variable', sans-serif",
  'font-hand': "'Nunito Variable', sans-serif",
  'text-xs': '0.75rem',
  'text-sm': '0.875rem',
  'text-base': '1rem',
  'text-lg': '1.125rem',
  'text-xl': '1.3rem',
  'text-2xl': '1.8rem',
  'text-3xl': '2.6rem',
  'weight-regular': '400',
  'weight-strong': '700',
  'tracking-display': '0',
  'radius-sm': '6px',
  'radius-md': '10px',
  'radius-lg': '16px',
  'radius-tile': '12px',
  'radius-avatar': '16px',
  'border-width': '1px',
  'shadow-sm': '0 1px 3px rgba(0, 0, 0, 0.3)',
  'shadow-md': '0 6px 18px rgba(0, 0, 0, 0.35)',
  'shadow-lg': '0 18px 48px rgba(0, 0, 0, 0.45)',
  'blur-surface': '0px',
  'saturate-surface': '1',
  'space-unit': '4px',
  'tile-gap': '8px',
  'nav-width': '280px',
  ...motionTokens(PS3_MOTION),
};

const DARK: ColorTokens = {
  bg: WAVES_PALETTE.top,
  'bg-elevated': '#13284A',
  surface: '#152B4E',
  'surface-2': '#1B355D',
  'surface-hover': '#22406B',
  'surface-pressed': '#10233F',
  'surface-alpha': 'rgba(6, 16, 34, 0.6)',
  border: '#2E4A73',
  'border-strong': '#8EA5C7',
  text: '#FFFFFF',
  'text-muted': '#D3DEEE',
  'text-on-accent': '#0A1A33',
  accent: '#FFFFFF',
  'accent-hover': '#E8EFF9',
  'accent-pressed': '#CFDCEE',
  'accent-muted': 'rgba(255, 255, 255, 0.16)',
  'focus-ring': '#FFFFFF',
  selection: 'rgba(255, 255, 255, 0.18)',
  'selection-border': '#FFFFFF',
  danger: '#FF9A9A',
  'danger-text': '#FFB4B4',
  warning: '#FFD166',
  success: '#7EE0A1',
  scrim: 'rgba(0, 0, 0, 0.88)',
  'tile-placeholder': '#1D3760',
};

export const PS3_TOKENS: Readonly<Record<'dark', ThemeTokens>> = {
  dark: { ...DARK, ...SHARED },
};

/** Las ondas pintan entre el azul de arriba y el de abajo con las tres cintas solapadas. */
export const PS3_BG_EXTREMES = { dark: wavesExtremes() } as const;
