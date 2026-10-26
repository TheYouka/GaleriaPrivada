// Modo de ventana discreto de los tests (docs/PLAN.md, nota 135): solo sin empaquetar y con
// GALERIA_E2E=1; nada más lo activa ni lo desactiva.
import { describe, expect, it } from 'vitest';
import { isStealthWindowMode, STEALTH_WINDOW_POSITION } from '../../../src/main/window-mode';

describe('isStealthWindowMode', () => {
  it('se activa solo sin empaquetar y con GALERIA_E2E=1', () => {
    expect(isStealthWindowMode(false, { GALERIA_E2E: '1' })).toBe(true);
  });

  it('un build empaquetado nunca lo activa, ni con GALERIA_E2E=1', () => {
    expect(isStealthWindowMode(true, { GALERIA_E2E: '1' })).toBe(false);
  });

  it('el uso normal (sin GALERIA_E2E o con otro valor) no lo activa', () => {
    expect(isStealthWindowMode(false, {})).toBe(false);
    expect(isStealthWindowMode(false, { GALERIA_E2E: '0' })).toBe(false);
    expect(isStealthWindowMode(false, { GALERIA_E2E: 'true' })).toBe(false);
  });

  it('otra variable no lo desactiva', () => {
    expect(
      isStealthWindowMode(false, {
        GALERIA_E2E: '1',
        GALERIA_STEALTH: '0',
        GALERIA_E2E_VISIBLE: '1',
      }),
    ).toBe(true);
  });

  it('la posición está fuera de cualquier pantalla', () => {
    expect(STEALTH_WINDOW_POSITION).toBeLessThanOrEqual(-30000);
  });
});
