import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_SWITCHES,
  forbiddenDebugSwitch,
} from '../../../src/main/security/startup-checks';

const has =
  (...present: string[]) =>
  (s: string): boolean =>
    present.includes(s);

describe('forbiddenDebugSwitch', () => {
  it('sin empaquetar nunca devuelve un switch', () => {
    expect(forbiddenDebugSwitch(false, has(...FORBIDDEN_SWITCHES))).toBeNull();
    expect(forbiddenDebugSwitch(false, has('remote-debugging-port'))).toBeNull();
  });

  it('empaquetado devuelve el primero de FORBIDDEN_SWITCHES que esté presente', () => {
    expect(forbiddenDebugSwitch(true, has('js-flags', 'inspect'))).toBe('inspect');
    expect(forbiddenDebugSwitch(true, has(...FORBIDDEN_SWITCHES))).toBe(FORBIDDEN_SWITCHES[0]);
    for (const s of FORBIDDEN_SWITCHES) {
      expect(forbiddenDebugSwitch(true, has(s))).toBe(s);
    }
  });

  it('empaquetado devuelve null si no hay ninguno', () => {
    expect(forbiddenDebugSwitch(true, has())).toBeNull();
    expect(forbiddenDebugSwitch(true, has('enable-logging', 'lang'))).toBeNull();
  });
});
