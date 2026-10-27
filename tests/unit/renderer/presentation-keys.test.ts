// Modelo de teclado de la presentación (docs/DESIGN.md §17.9).
import { describe, expect, it } from 'vitest';
import {
  presentationCommand,
  type PresentationKeyContext,
} from '../../../src/renderer/src/screens/presentation/presentation-keys';

const ctx: PresentationKeyContext = { settingsOpen: false, finished: false, focus: 'none' };
const cmd = (key: string, c: Partial<PresentationKeyContext> = {}, mods = {}) =>
  presentationCommand({ key, ...mods }, { ...ctx, ...c });

describe('presentationCommand', () => {
  it('Espacio pausa/reanuda; ←/→ van a la anterior/siguiente; F y M conmutan', () => {
    expect(cmd(' ')).toBe('toggle-pause');
    expect(cmd('ArrowLeft')).toBe('prev');
    expect(cmd('ArrowRight')).toBe('next');
    expect(cmd('f')).toBe('toggle-fullscreen');
    expect(cmd('F')).toBe('toggle-fullscreen');
    expect(cmd('m')).toBe('toggle-music');
    expect(cmd('M')).toBe('toggle-music');
  });

  it('Esc cierra el panel de ajustes si está abierto y, si no, sale', () => {
    expect(cmd('Escape', { settingsOpen: true })).toBe('close-settings');
    expect(cmd('Escape')).toBe('exit');
    expect(cmd('Escape', { finished: true })).toBe('exit');
  });

  it('Esc funciona aunque el foco esté en un campo de texto', () => {
    expect(cmd('Escape', { focus: 'text' })).toBe('exit');
    expect(cmd('Escape', { focus: 'text', settingsOpen: true })).toBe('close-settings');
  });

  it('en un campo de texto el resto de teclas no se roban', () => {
    for (const key of [' ', 'f', 'm', 'ArrowLeft', 'ArrowRight', 'Enter']) {
      expect(cmd(key, { focus: 'text' })).toBeNull();
    }
  });

  it('en un deslizador las flechas y Espacio son suyas, pero F y M siguen valiendo', () => {
    expect(cmd('ArrowRight', { focus: 'slider' })).toBeNull();
    expect(cmd(' ', { focus: 'slider' })).toBeNull();
    expect(cmd('m', { focus: 'slider' })).toBe('toggle-music');
  });

  it('en un botón, Espacio e Intro lo activan a él, no a la orden global', () => {
    expect(cmd(' ', { focus: 'button' })).toBeNull();
    expect(cmd('Enter', { focus: 'button', finished: true })).toBeNull();
    expect(cmd('ArrowRight', { focus: 'button' })).toBe('next');
  });

  it('Intro reinicia solo en la capa final', () => {
    expect(cmd('Enter')).toBeNull();
    expect(cmd('Enter', { finished: true })).toBe('restart');
  });

  it('en la capa final no hay pausa ni navegación, pero sí F, M y Esc', () => {
    expect(cmd(' ', { finished: true })).toBeNull();
    expect(cmd('ArrowRight', { finished: true })).toBeNull();
    expect(cmd('f', { finished: true })).toBe('toggle-fullscreen');
    expect(cmd('m', { finished: true })).toBe('toggle-music');
  });

  it('Ctrl, Alt y Meta no disparan nada (ni Esc)', () => {
    for (const mods of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      expect(cmd('ArrowRight', {}, mods)).toBeNull();
      expect(cmd('f', {}, mods)).toBeNull();
      expect(cmd('Escape', {}, mods)).toBeNull();
    }
  });

  it('mantener una tecla pulsada (repeat) se ignora', () => {
    expect(cmd('ArrowRight', {}, { repeat: true })).toBeNull();
    expect(cmd(' ', {}, { repeat: true })).toBeNull();
  });

  it('otras teclas no hacen nada', () => {
    expect(cmd('a')).toBeNull();
    expect(cmd('ArrowUp')).toBeNull();
    expect(cmd('Tab')).toBeNull();
  });
});
