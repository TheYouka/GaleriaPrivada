// lib/errors-es.ts [H3-10]: cada ErrorCode tiene un mensaje en español no vacío.
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@shared/errors';
import { ERROR_MESSAGES, errorMessage, GENERIC_ERROR_MESSAGE } from '@renderer/lib/errors-es';

describe('errors-es', () => {
  it.each(ERROR_CODES)('%s tiene un mensaje no vacío', (code) => {
    expect(ERROR_MESSAGES[code].trim().length).toBeGreaterThan(0);
    expect(errorMessage(code)).toBe(ERROR_MESSAGES[code]);
    expect(errorMessage({ code })).toBe(ERROR_MESSAGES[code]);
  });

  it('no hay mensajes para códigos que no existen', () => {
    expect(Object.keys(ERROR_MESSAGES).sort()).toEqual([...ERROR_CODES].sort());
  });

  it('un código desconocido da el mensaje genérico', () => {
    expect(errorMessage('NO_EXISTE')).toBe(GENERIC_ERROR_MESSAGE);
    expect(errorMessage({ code: 'NO_EXISTE' as never })).toBe(GENERIC_ERROR_MESSAGE);
    expect(errorMessage('toString')).toBe(GENERIC_ERROR_MESSAGE);
    expect(errorMessage(undefined)).toBe(GENERIC_ERROR_MESSAGE);
    expect(errorMessage(null)).toBe(GENERIC_ERROR_MESSAGE);
  });

  it('usa details.reason cuando hay un mensaje más concreto', () => {
    expect(errorMessage({ code: 'INTERNAL', details: { reason: 'kdf-memory' } })).toMatch(
      /memoria/,
    );
    expect(errorMessage({ code: 'VALIDATION', details: { reason: 'confirm-name' } })).toMatch(
      /nombre no coincide/,
    );
    expect(errorMessage({ code: 'VALIDATION', details: { reason: 'otra' } })).toBe(
      ERROR_MESSAGES.VALIDATION,
    );
  });

  it('WRONG_PASSWORD dice "Contraseña incorrecta" (§14.3)', () => {
    expect(errorMessage('WRONG_PASSWORD')).toBe('Contraseña incorrecta');
  });

  it('ningún mensaje ofrece recuperar la contraseña', () => {
    for (const message of Object.values(ERROR_MESSAGES)) {
      expect(message).not.toMatch(/olvidaste|recuperar|restablecer/i);
    }
  });
});
