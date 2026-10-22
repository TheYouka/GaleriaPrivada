import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@shared/errors';

// Trivial: comprueba de paso que el alias @shared resuelve en Vitest ([H3-10]).
describe('smoke', () => {
  it('expone los 20 códigos de error, incluido INTERNAL', () => {
    expect(ERROR_CODES).toHaveLength(20);
    expect(ERROR_CODES).toContain('INTERNAL');
  });
});
