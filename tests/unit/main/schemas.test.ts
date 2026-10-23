// Esquemas del IPC (docs/DESIGN.md §10.3): text() normaliza, rawPath() no [H3-3].
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SCHEMAS, rawPath, text } from '../../../src/main/ipc/schemas';
import { INVOKE_CHANNELS } from '../../../src/shared/ipc-contract';

const id = (): string => randomBytes(16).toString('hex');
const bytes = (n: number): Uint8Array => new Uint8Array(n).fill(0x61);
const ABS = process.platform === 'win32' ? 'C:\\Users\\x\\Descargas\\' : '/home/x/Descargas/';

describe('text(min, max)', () => {
  const schema = text(1, 40);

  it('normaliza a NFC y recorta: "  A\\u0301lbum " → "Álbum"', () => {
    expect(schema.parse('  A\u0301lbum ')).toBe('Álbum');
  });

  it('cuenta code points, no unidades UTF-16', () => {
    expect(schema.safeParse('😀'.repeat(40)).success).toBe(true);
    expect(schema.safeParse('😀'.repeat(41)).success).toBe(false);
  });

  it('rechaza vacíos tras recortar y caracteres de control', () => {
    expect(schema.safeParse('   ').success).toBe(false);
    expect(schema.safeParse('a\u0000b').success).toBe(false);
    expect(schema.safeParse('a\nb').success).toBe(false);
    expect(schema.safeParse(5).success).toBe(false);
  });
});

describe('rawPath() [H3-3]', () => {
  const schema = rawPath();

  it('deja intactos "a\\u0301.jpg" (NFD) y "foto.jpg " (espacio final)', () => {
    const nfd = `${ABS}a\u0301.jpg`;
    const spaced = `${ABS}foto.jpg `;
    expect(schema.parse(nfd)).toBe(nfd);
    expect(schema.parse(nfd)).not.toBe(nfd.normalize('NFC'));
    expect(schema.parse(spaced)).toBe(spaced);
  });

  it('exige ruta absoluta, sin NUL, de 1–32 767 unidades UTF-16', () => {
    expect(schema.safeParse('a\u0301.jpg').success).toBe(false); // relativa
    expect(schema.safeParse('').success).toBe(false);
    expect(schema.safeParse(`${ABS}a\0b.jpg`).success).toBe(false);
    expect(schema.safeParse(ABS + 'x'.repeat(32_767)).success).toBe(false);
    expect(schema.safeParse(ABS + 'x'.repeat(32_767 - ABS.length)).success).toBe(true);
  });
});

describe('SCHEMAS', () => {
  it('hay un esquema por canal de INVOKE_CHANNELS', () => {
    expect(Object.keys(SCHEMAS).sort()).toEqual([...INVOKE_CHANNELS].sort());
  });

  it('profiles:create: contraseña de 8–1024 bytes, aviso obligatorio, estricto', () => {
    const ok = {
      name: ' Ana ',
      avatar: { type: 'builtin', id: 'aurora' },
      password: bytes(8),
      acknowledgeNoRecovery: true,
    };
    expect(SCHEMAS['profiles:create'].parse(ok)).toMatchObject({ name: 'Ana' });
    for (const bad of [
      { ...ok, password: bytes(7) },
      { ...ok, password: bytes(1025) },
      { ...ok, password: 'texto' },
      { ...ok, acknowledgeNoRecovery: false },
      { ...ok, extra: 1 },
      { ...ok, avatar: { type: 'builtin', id: 'otro' } },
      { ...ok, avatar: { type: 'custom', token: 'corto' } },
      { ...ok, avatar: { type: 'custom', token: 'a'.repeat(43), path: 'C:\\x' } },
    ]) {
      expect(SCHEMAS['profiles:create'].safeParse(bad).success).toBe(false);
    }
    expect(
      SCHEMAS['profiles:create'].safeParse({ ...ok, password: Buffer.alloc(1024) }).success,
    ).toBe(true);
  });

  it('profiles:delete exige la contraseña y el nombre', () => {
    const schema = SCHEMAS['profiles:delete'];
    expect(
      schema.safeParse({ profileId: id(), password: bytes(8), confirmName: 'Ana' }).success,
    ).toBe(true);
    expect(schema.safeParse({ profileId: id(), confirmName: 'Ana' }).success).toBe(false);
    expect(schema.safeParse({ profileId: id(), password: bytes(8) }).success).toBe(false);
    expect(
      schema.safeParse({ profileId: 'x', password: bytes(8), confirmName: 'Ana' }).success,
    ).toBe(false);
  });

  it('prefs:set: enums cerrados, temas implementados y autoLockMinutes de la lista', () => {
    const schema = SCHEMAS['prefs:set'];
    expect(schema.safeParse({ themeId: 'ps3', autoLockMinutes: 1 }).success).toBe(true);
    expect(schema.safeParse({ themeId: null, colorScheme: null }).success).toBe(true);
    expect(schema.safeParse({ themeId: 'xbox' }).success).toBe(false); // aún no disponible (F6)
    expect(schema.safeParse({ autoLockMinutes: 3 }).success).toBe(false);
    expect(schema.safeParse({ gallerySort: { field: 'position', dir: 'asc' } }).success).toBe(
      false,
    );
    expect(schema.safeParse({ contentProtection: 'sí' }).success).toBe(false);
  });

  it('settings:set y session:*', () => {
    expect(SCHEMAS['settings:set'].safeParse({ pickerThemeId: 'ps3' }).success).toBe(true);
    expect(SCHEMAS['settings:set'].safeParse({ pickerThemeId: 'otro' }).success).toBe(false);
    expect(
      SCHEMAS['session:unlock'].safeParse({ profileId: id(), password: bytes(8) }).success,
    ).toBe(true);
    expect(SCHEMAS['session:setPlayback'].safeParse({ active: true }).success).toBe(true);
    expect(SCHEMAS['session:lock'].safeParse(undefined).success).toBe(true);
    expect(SCHEMAS['session:lock'].safeParse({}).success).toBe(false);
  });
});
