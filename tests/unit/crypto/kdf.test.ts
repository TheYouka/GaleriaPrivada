// Argon2id y calibración por máquina (docs/DESIGN.md §6.1).
import { hash as argon2Phc, hashRaw } from '@node-rs/argon2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KDF_FALLBACKS,
  KDF_FAST_TEST,
  KDF_TARGET,
  argon2idHash,
  calibrateKdf,
  chooseKdfParams,
  deriveKek,
  fastKdfAllowed,
  newSalt,
  type Argon2Hash,
  type KdfParams,
} from '../../../src/main/crypto/kdf';
import { log } from '../../../src/main/log';
import { appErrorOf } from '../helpers/crypto';

const SLOW = process.env.GALERIA_SLOW_TESTS === '1';
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const key = (p: KdfParams): string => `${p.memoryKiB}/${p.iterations}/${p.parallelism}`;

/**
 * Hash falso con reloj simulado: cada llamada "tarda" lo que diga `durations` para esos parámetros
 * (o lanza si el valor es 'fail'). Registra el orden de los candidatos probados.
 */
function fakeArgon2(durations: Record<string, number | 'fail'>): {
  hash: Argon2Hash;
  now: () => number;
  tried: string[];
} {
  let clock = 0;
  const tried: string[] = [];
  const hash: Argon2Hash = async (_pw, _salt, params) => {
    const k = key(params);
    tried.push(k);
    const d = durations[k];
    if (d === undefined) throw new Error(`candidato inesperado ${k}`);
    if (d === 'fail') throw new Error('memory allocation failed');
    clock += d;
    return Buffer.alloc(32, 1);
  };
  return { hash, now: () => clock, tried };
}

const T = key(KDF_TARGET); // 262144/3/4
const [F1, F2, F3, FLOOR] = KDF_FALLBACKS.map(key) as [string, string, string, string];

afterEach(() => {
  vi.restoreAllMocks();
});

describe.runIf(SLOW)('parámetros de producción (lento)', () => {
  it('delta de maxRSS ≤ 1,5 × m con (256 MiB, t=3, p=4)', { timeout: 60_000 }, async () => {
    // Este bloque va el primero del archivo: con pool 'forks' el proceso es nuevo y ningún Argon2
    // anterior ha dejado memoria reutilizable que ocultaría parte del delta. maxRSS va en KiB.
    const beforeKiB = process.resourceUsage().maxRSS;
    const kek = await deriveKek(utf8('contraseña de prueba'), newSalt(), KDF_TARGET);
    const deltaKiB = process.resourceUsage().maxRSS - beforeKiB;
    expect(kek).toHaveLength(32);
    console.log(
      `[slow] Argon2id 256 MiB/t=3/p=4: delta maxRSS = ${Math.round(deltaKiB / 1024)} MiB`,
    );
    expect(deltaKiB).toBeLessThanOrEqual(1.5 * KDF_TARGET.memoryKiB);
  });

  it('la calibración real elige parámetros dentro de §6.1', { timeout: 60_000 }, async () => {
    const start = performance.now();
    const chosen = await calibrateKdf();
    console.log(
      `[slow] calibración: ${JSON.stringify(chosen)} en ${Math.round(performance.now() - start)} ms`,
    );
    const valid = [KDF_TARGET, ...KDF_FALLBACKS].some(
      (c) => c.memoryKiB === chosen.memoryKiB && c.parallelism === chosen.parallelism,
    );
    expect(valid).toBe(true);
    expect(chosen.memoryKiB).toBeGreaterThanOrEqual(65536);
    expect(chosen.iterations).toBeGreaterThanOrEqual(2);
    expect(chosen.iterations).toBeLessThanOrEqual(8);
    expect(chosen.parallelism).toBe(4);
  });
});

describe('candidatos de §6.1', () => {
  it('objetivo, orden de los más ligeros y suelo', () => {
    expect(KDF_TARGET).toEqual({ memoryKiB: 262144, iterations: 3, parallelism: 4 });
    expect(KDF_FALLBACKS.map(key)).toEqual(['262144/2/4', '131072/3/4', '131072/2/4', '65536/3/4']);
    expect(KDF_FAST_TEST).toEqual({ memoryKiB: 8192, iterations: 1, parallelism: 1 });
  });
});

describe('calibración con tiempos simulados', () => {
  it('> 1,5 s: prueba los candidatos en orden y se queda con el primero que baja', async () => {
    const f = fakeArgon2({ [T]: 2000, [F1]: 1600, [F2]: 1400, [F3]: 900, [FLOOR]: 500 });
    const chosen = await calibrateKdf(f);
    expect(f.tried).toEqual([T, F1, F2]);
    expect(chosen).toEqual({ memoryKiB: 131072, iterations: 3, parallelism: 4 });
  });

  it('< 0,5 s: sube t con la fórmula sin cambiar m (0,255 s → 8)', async () => {
    const f = fakeArgon2({ [T]: 255 });
    expect(await calibrateKdf(f)).toEqual({ memoryKiB: 262144, iterations: 8, parallelism: 4 });
    expect(f.tried).toEqual([T]);
  });

  it('< 0,5 s: t = ceil(3 × 0,75 / medido_s) (0,45 s → 5; 0,3 s → 8)', async () => {
    expect((await calibrateKdf(fakeArgon2({ [T]: 450 }))).iterations).toBe(5);
    expect((await calibrateKdf(fakeArgon2({ [T]: 300 }))).iterations).toBe(8);
  });

  it('entre 0,5 y 1,5 s: el objetivo tal cual', async () => {
    expect(await calibrateKdf(fakeArgon2({ [T]: 500 }))).toEqual(KDF_TARGET);
    expect(await calibrateKdf(fakeArgon2({ [T]: 1000 }))).toEqual(KDF_TARGET);
    expect(await calibrateKdf(fakeArgon2({ [T]: 1500 }))).toEqual(KDF_TARGET);
  });

  it('un fallo de memoria pasa al siguiente candidato', async () => {
    const f = fakeArgon2({ [T]: 'fail', [F1]: 'fail', [F2]: 800 });
    expect(await calibrateKdf(f)).toEqual({ memoryKiB: 131072, iterations: 3, parallelism: 4 });
    expect(f.tried).toEqual([T, F1, F2]);
  });

  it('el suelo (64 MiB, t=3) se usa aunque tarde', async () => {
    const f = fakeArgon2({ [T]: 5000, [F1]: 4000, [F2]: 3000, [F3]: 2500, [FLOOR]: 2000 });
    expect(await calibrateKdf(f)).toEqual({ memoryKiB: 65536, iterations: 3, parallelism: 4 });
    expect(f.tried).toEqual([T, F1, F2, F3, FLOOR]);
  });

  it("sin candidatos → INTERNAL { reason: 'kdf-memory' } y un error en el log", async () => {
    const errorSpy = vi.spyOn(log, 'error');
    const f = fakeArgon2({
      [T]: 'fail',
      [F1]: 'fail',
      [F2]: 'fail',
      [F3]: 'fail',
      [FLOOR]: 'fail',
    });
    expect(await appErrorOf(() => calibrateKdf(f))).toEqual({
      code: 'INTERNAL',
      reason: 'kdf-memory',
    });
    expect(errorSpy).toHaveBeenCalledWith('kdf.memory', { stage: 'calibrate' });
  });
});

describe('parámetros rápidos de test', () => {
  it('solo con GALERIA_TEST_FAST_KDF=1 y sin empaquetar', () => {
    expect(fastKdfAllowed(false, { GALERIA_TEST_FAST_KDF: '1' })).toBe(true);
    expect(fastKdfAllowed(true, { GALERIA_TEST_FAST_KDF: '1' })).toBe(false);
    expect(fastKdfAllowed(false, {})).toBe(false);
    expect(fastKdfAllowed(false, { GALERIA_TEST_FAST_KDF: 'true' })).toBe(false);
  });

  it('chooseKdfParams los usa con un warn; empaquetado calibra', async () => {
    const warnSpy = vi.spyOn(log, 'warn');
    const f = fakeArgon2({ [T]: 1000 });
    const env = { GALERIA_TEST_FAST_KDF: '1' };
    expect(await chooseKdfParams({ isPackaged: false, env, ...f })).toEqual(KDF_FAST_TEST);
    expect(warnSpy).toHaveBeenCalledWith('kdf.fast-params');
    expect(f.tried).toEqual([]);
    expect(await chooseKdfParams({ isPackaged: true, env, ...f })).toEqual(KDF_TARGET);
    expect(f.tried).toEqual([T]);
  });
});

describe('deriveKek con Argon2id real', () => {
  it('32 bytes, determinista con la misma sal y distinto con otra contraseña o sal', async () => {
    const salt = newSalt();
    const a = await deriveKek(utf8('contraseña'), salt, KDF_FAST_TEST);
    const b = await deriveKek(utf8('contraseña'), salt, KDF_FAST_TEST);
    const c = await deriveKek(utf8('contraseñA'), salt, KDF_FAST_TEST);
    const d = await deriveKek(utf8('contraseña'), newSalt(), KDF_FAST_TEST);
    expect(a).toHaveLength(32);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    expect(a.equals(d)).toBe(false);
  });

  it('usa Argon2id v=19 (literales algorithm: 2, version: 1)', async () => {
    const salt = Buffer.from('somesaltsomesalt', 'latin1');
    const params = { memoryKiB: 8192, iterations: 2, parallelism: 1 };
    const raw = await argon2idHash(utf8('password'), salt, params);
    const phc = await argon2Phc(utf8('password'), {
      algorithm: 2,
      version: 1,
      memoryCost: 8192,
      timeCost: 2,
      parallelism: 1,
      outputLen: 32,
      salt,
    });
    expect(phc.startsWith('$argon2id$v=19$m=8192,t=2,p=1$')).toBe(true);
    expect(phc.split('$').at(-1)).toBe(raw.toString('base64').replace(/=+$/, ''));
    const argon2i = await hashRaw(utf8('password'), {
      algorithm: 1,
      version: 1,
      memoryCost: 8192,
      timeCost: 2,
      parallelism: 1,
      outputLen: 32,
      salt,
    });
    expect(raw.equals(argon2i)).toBe(false);
  });

  it('vector de la implementación de referencia (Argon2id v=19, m=64 MiB, t=2, p=1)', async () => {
    const raw = await argon2idHash(utf8('password'), Buffer.from('somesalt', 'latin1'), {
      memoryKiB: 65536,
      iterations: 2,
      parallelism: 1,
    });
    expect(raw.toString('hex')).toBe(
      '09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7',
    );
  });

  it("si Argon2 falla → INTERNAL { reason: 'kdf-memory' }", async () => {
    const failing: Argon2Hash = () => Promise.reject(new Error('alloc'));
    expect(
      await appErrorOf(() => deriveKek(utf8('x'.repeat(8)), newSalt(), KDF_TARGET, failing)),
    ).toEqual({
      code: 'INTERNAL',
      reason: 'kdf-memory',
    });
  });
});
