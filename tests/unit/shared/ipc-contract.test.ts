// Contrato IPC de F1 (docs/DESIGN.md §10.2, §5.6 y §22) y [H3-8].
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  PRIVATE_INVOKE_CHANNELS,
  type EventChannel,
  type InvokeChannel,
  type PayloadOf,
  type ReqOf,
  type ResOf,
} from '@shared/ipc-contract';
import {
  AUTO_LOCK_MINUTES,
  AVATAR_DIALOG_EXTENSIONS,
  BUILTIN_AVATAR_IDS,
  IMPORT_DIALOG_EXTENSIONS,
} from '@shared/constants';
import type { AutoLockMinutes, BuiltinAvatarId, EditOp, LockReason } from '@shared/types';

/**
 * true si T contiene bytes en algún nivel (Buffer es un Uint8Array). Se distribuye sobre las
 * uniones, así que una respuesta con un miembro binario da `boolean`, no `false`; `any` también.
 */
type HasBinary<T> = T extends ArrayBufferLike | ArrayBufferView
  ? true
  : T extends readonly (infer U)[]
    ? HasBinary<U>
    : T extends (...args: never[]) => unknown
      ? false
      : T extends object
        ? true extends { [K in keyof T]-?: HasBinary<T[K]> }[keyof T]
          ? true
          : false
        : false;

describe('allowlists', () => {
  it('INVOKE_CHANNELS no tiene duplicados', () => {
    expect(new Set(INVOKE_CHANNELS).size).toBe(INVOKE_CHANNELS.length);
  });

  it('EVENT_CHANNELS no tiene duplicados', () => {
    expect(new Set(EVENT_CHANNELS).size).toBe(EVENT_CHANNELS.length);
  });

  it('import:paths no está en la allowlist genérica (§5.6): es un canal privado del preload', () => {
    expect(INVOKE_CHANNELS as readonly string[]).not.toContain('import:paths');
    expect(PRIVATE_INVOKE_CHANNELS).toEqual(['import:paths']);
  });

  it('incluye los canales y eventos de F1 y los de medios e importación de F2', () => {
    for (const prefix of [
      'app:',
      'window:',
      'settings:',
      'profiles:',
      'session:',
      'prefs:',
      'media:',
      'import:',
    ]) {
      expect(INVOKE_CHANNELS.some((c) => c.startsWith(prefix))).toBe(true);
    }
    expect(INVOKE_CHANNELS.filter((c) => c.startsWith('import:')).sort()).toEqual([
      'import:cancel',
      'import:chooseFiles',
      'import:chooseFolder',
      'import:confirm',
    ]);
    expect([...EVENT_CHANNELS].sort()).toEqual([
      'import:confirmNeeded',
      'import:done',
      'import:progress',
      'library:changed',
      'relocate:done',
      'relocate:progress',
      'session:locked',
      'session:locking',
      'window:state',
    ]);
    expect(INVOKE_CHANNELS.filter((c) => c.startsWith('vault:')).sort()).toEqual([
      'vault:getInfo',
      'vault:locate',
      'vault:relocate',
      'vault:relocateCancel',
    ]);
  });

  it('F3: edits:save sustituye la lista de operaciones y devuelve las guardadas y el thumbRev', () => {
    expect(INVOKE_CHANNELS).toContain('edits:save');
    expectTypeOf<ReqOf<'edits:save'>>().toEqualTypeOf<{ mediaId: string; ops: EditOp[] }>();
    expectTypeOf<ResOf<'edits:save'>>().toEqualTypeOf<{ edits: EditOp[]; thumbRev: number }>();
    // El renderer lee las operaciones actuales y el thumbRev con media:get.
    expectTypeOf<ResOf<'media:get'>['edits']>().toEqualTypeOf<EditOp[]>();
    expectTypeOf<ResOf<'media:get'>['thumbRev']>().toEqualTypeOf<number>();
  });

  it('[H3-8] los canales de la bóveda no aceptan rutas del renderer', () => {
    expectTypeOf<ReqOf<'vault:relocate'>>().toEqualTypeOf<{ target: 'choose' | 'default' }>();
    expectTypeOf<ReqOf<'vault:locate'>>().toEqualTypeOf<{ profileId: string }>();
    expectTypeOf<ReqOf<'vault:relocateCancel'>>().toEqualTypeOf<{ jobId: string }>();
  });
});

describe('tipos del contrato', () => {
  it('ninguna respuesta lleva Buffer ni Uint8Array (§22: el renderer nunca recibe claves)', () => {
    expectTypeOf<{ [C in InvokeChannel]: HasBinary<ResOf<C>> }>().toEqualTypeOf<{
      [C in InvokeChannel]: false;
    }>();
  });

  it('ningún evento lleva Buffer ni Uint8Array', () => {
    expectTypeOf<{ [E in EventChannel]: HasBinary<PayloadOf<E>> }>().toEqualTypeOf<{
      [E in EventChannel]: false;
    }>();
  });

  it('el detector de bytes funciona (control positivo)', () => {
    expectTypeOf<HasBinary<{ a: { b: Buffer } }>>().toEqualTypeOf<true>();
    expectTypeOf<HasBinary<{ a: Uint8Array[] }>>().toEqualTypeOf<true>();
    expectTypeOf<HasBinary<{ a: string } | { b: ArrayBuffer }>>().toEqualTypeOf<boolean>();
    // Las contraseñas viajan como Uint8Array del renderer a main, nunca al revés.
    expectTypeOf<HasBinary<ReqOf<'profiles:create'>>>().toEqualTypeOf<true>();
    expectTypeOf<HasBinary<ReqOf<'session:unlock'>>>().toEqualTypeOf<true>();
  });

  it('[H3-8] profiles:delete devuelve { leftoverPath: string | null }', () => {
    expectTypeOf<ResOf<'profiles:delete'>>().toEqualTypeOf<{ leftoverPath: string | null }>();
  });

  it('borrar un perfil exige contraseña y nombre', () => {
    expectTypeOf<ReqOf<'profiles:delete'>>().toEqualTypeOf<{
      profileId: string;
      password: Uint8Array;
      confirmName: string;
    }>();
  });

  it('crear un perfil exige aceptar que no hay recuperación', () => {
    expectTypeOf<ReqOf<'profiles:create'>['acknowledgeNoRecovery']>().toEqualTypeOf<true>();
  });

  it('los eventos de bloqueo llevan el motivo', () => {
    expectTypeOf<PayloadOf<'session:locking'>>().toEqualTypeOf<{ reason: LockReason }>();
    expectTypeOf<PayloadOf<'session:locked'>>().toEqualTypeOf<{ reason: LockReason }>();
  });
});

describe('constantes', () => {
  it('BUILTIN_AVATAR_IDS cubre exactamente BuiltinAvatarId (12 ids)', () => {
    expectTypeOf<(typeof BUILTIN_AVATAR_IDS)[number]>().toEqualTypeOf<BuiltinAvatarId>();
    expect(BUILTIN_AVATAR_IDS).toHaveLength(12);
    expect(new Set(BUILTIN_AVATAR_IDS).size).toBe(12);
  });

  it('AUTO_LOCK_MINUTES cubre exactamente AutoLockMinutes', () => {
    expectTypeOf<(typeof AUTO_LOCK_MINUTES)[number]>().toEqualTypeOf<AutoLockMinutes>();
  });

  it('los diálogos no ofrecen BMP, HEIC ni RAW', () => {
    for (const ext of ['bmp', 'heic', 'heif', 'cr2', 'cr3', 'nef', 'dng']) {
      expect(IMPORT_DIALOG_EXTENSIONS).not.toContain(ext);
      expect(AVATAR_DIALOG_EXTENSIONS).not.toContain(ext);
    }
    expect(AVATAR_DIALOG_EXTENSIONS).not.toContain('mp4');
  });
});
