// session:activity como mucho cada 10 s (§13.2) y reglas de la UI para nombres y contraseñas
// (§10.3).
import { describe, expect, it } from 'vitest';
import { ACTIVITY_THROTTLE_MS, createActivityReporter } from '@renderer/lib/activity';
import {
  codePointLength,
  passwordBytes,
  passwordIssue,
  profileNameIssue,
} from '@renderer/lib/password';

describe('createActivityReporter', () => {
  it('envía el primero al momento y después como mucho uno cada 10 s', () => {
    let now = 0;
    let sent = 0;
    const report = createActivityReporter(
      () => (sent += 1),
      () => now,
    );
    report();
    expect(sent).toBe(1);
    for (now = 1; now < ACTIVITY_THROTTLE_MS; now += 500) report();
    expect(sent).toBe(1);
    now = ACTIVITY_THROTTLE_MS;
    report();
    expect(sent).toBe(2);
    now += 9_999;
    report();
    expect(sent).toBe(2);
    now += 1;
    report();
    expect(sent).toBe(3);
  });
});

describe('contraseñas y nombres en la UI', () => {
  it('mínimo 8 code points de NFC (no bytes ni unidades UTF-16)', () => {
    expect(passwordIssue('1234567')).toBe('short');
    expect(passwordIssue('12345678')).toBeNull();
    // 7 emojis = 14 unidades UTF-16 y 28 bytes, pero 7 code points.
    expect(passwordIssue('😀'.repeat(7))).toBe('short');
    // "a" + acento combinante = 1 code point tras NFC.
    expect(codePointLength('a\u0301'.repeat(8))).toBe(8);
    expect(passwordIssue('a\u0301'.repeat(7) + 'b')).toBeNull();
  });

  it('máximo 1024 bytes UTF-8, así que todo lo que acepta la UI lo acepta main', () => {
    expect(passwordIssue('a'.repeat(1024))).toBeNull();
    expect(passwordIssue('a'.repeat(1025))).toBe('long');
    expect(passwordIssue('ñ'.repeat(513))).toBe('long');
  });

  it('no recorta la contraseña y la envía en NFC', () => {
    expect([...passwordBytes(' clave1234 ')]).toEqual([...new TextEncoder().encode(' clave1234 ')]);
    expect([...passwordBytes('a\u0301')]).toEqual([...new TextEncoder().encode('á')]);
  });

  it('nombre: 1–40 code points tras NFC y trim, sin caracteres de control', () => {
    expect(profileNameIssue('   ')).toBe('empty');
    expect(profileNameIssue('Ana')).toBeNull();
    expect(profileNameIssue('x'.repeat(40))).toBeNull();
    expect(profileNameIssue('x'.repeat(41))).toBe('long');
    expect(profileNameIssue('a\u0007b')).toBe('control');
  });
});
