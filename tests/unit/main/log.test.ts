// Log tipado (docs/DESIGN.md §21.2).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOG_FILES,
  LOG_FILE_NAME,
  LOG_MAX_BYTES,
  closeLog,
  initLog,
  log,
  type LogFields,
} from '../../../src/main/log';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

let root: string;
let dir: string;

function lines(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  root = makeTmpDir('log');
  dir = join(root, 'logs');
});

afterEach(() => {
  closeLog();
  removeTmpDir(root);
});

describe('log', () => {
  it('rotación por defecto: 1 MiB × 3', () => {
    expect(LOG_MAX_BYTES).toBe(1024 * 1024);
    expect(LOG_FILES).toBe(3);
  });

  it('escribe JSON por línea en logs/main.log con los campos permitidos', () => {
    initLog({ dir, isPackaged: true, now: () => new Date('2026-10-22T10:00:00.000Z') });
    log.warn('kdf.fast-params', { ms: 12, code: 'INTERNAL', stage: 'calibrate' });
    log.info('paths.override-active');
    const out = lines(join(dir, LOG_FILE_NAME));
    expect(out).toEqual([
      {
        ts: '2026-10-22T10:00:00.000Z',
        level: 'warn',
        event: 'kdf.fast-params',
        code: 'INTERNAL',
        ms: 12,
        stage: 'calibrate',
      },
      { ts: '2026-10-22T10:00:00.000Z', level: 'info', event: 'paths.override-active' },
    ]);
  });

  it('rota a .1 y .2 y descarta el cuarto archivo', () => {
    initLog({ dir, isPackaged: false, maxBytes: 1024 });
    // Cada línea ~90 bytes: ~11 por archivo. 4 archivos llenos + algo más.
    for (let i = 0; i < 60; i += 1) log.info('app.start', { count: i });
    const base = join(dir, LOG_FILE_NAME);
    expect(existsSync(base)).toBe(true);
    expect(existsSync(`${base}.1`)).toBe(true);
    expect(existsSync(`${base}.2`)).toBe(true);
    expect(existsSync(`${base}.3`)).toBe(false);
    for (const f of [base, `${base}.1`, `${base}.2`]) {
      expect(readFileSync(f).length).toBeLessThanOrEqual(1024);
    }
    // Orden: .2 es el más antiguo que queda, main.log el más reciente; los primeros se perdieron.
    const counts = [`${base}.2`, `${base}.1`, base].flatMap((f) =>
      lines(f).map((l) => l.count as number),
    );
    expect(counts.at(-1)).toBe(59);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(counts[0]).toBeGreaterThan(0); // el primer archivo (count 0…) se descartó
    expect(counts).toEqual(Array.from({ length: counts.length }, (_, k) => counts[0]! + k));
  });

  it('debug solo sin empaquetar', () => {
    initLog({ dir, isPackaged: true });
    log.debug('ipc.validation');
    log.info('app.start');
    expect(lines(join(dir, LOG_FILE_NAME)).map((l) => l.level)).toEqual(['info']);
    closeLog();
    initLog({ dir, isPackaged: false });
    log.debug('ipc.validation');
    expect(lines(join(dir, LOG_FILE_NAME)).map((l) => l.level)).toEqual(['info', 'debug']);
  });

  it('descarta en ejecución campos y valores no permitidos (defensa ante casts)', () => {
    initLog({ dir, isPackaged: false });
    const sneaky = {
      count: 1,
      path: 'C:\\Users\\x\\foto.jpg',
      message: 'texto',
      mediaId: 'no-es-un-id',
      jobId: '0123456789abcdef0123456789abcdef',
      errno: 'ENOENT',
      stage: 'C:\\ruta con espacios',
      code: 'NO_EXISTE',
      ms: Number.NaN,
    } as unknown as LogFields;
    log.error('ipc.internal', sneaky);
    log.warn('texto libre' as unknown as 'app.start');
    const [entry, ...rest] = lines(join(dir, LOG_FILE_NAME));
    expect(rest).toEqual([]);
    expect(entry).toEqual({
      ts: expect.any(String),
      level: 'error',
      event: 'ipc.internal',
      count: 1,
      jobId: '0123456789abcdef0123456789abcdef',
      errno: 'ENOENT',
    });
  });

  it('antes de initLog() y tras closeLog() no escribe nada ni lanza', () => {
    closeLog();
    expect(() => log.error('ipc.internal')).not.toThrow();
    initLog({ dir, isPackaged: false });
    closeLog();
    log.info('app.start');
    expect(readFileSync(join(dir, LOG_FILE_NAME), 'utf8')).toBe('');
  });

  it('la API no acepta texto libre ni campos fuera de la lista (comprobación de tipos)', () => {
    // Estas líneas no se ejecutan: solo las comprueba `npm run typecheck`.
    const typeOnly = (): void => {
      // @ts-expect-error: LogEvent es una unión cerrada de literales
      log.warn('texto libre');
      // @ts-expect-error: `path` no es un campo permitido (§21.2)
      log.warn('app.start', { path: 'C:\\foto.jpg' });
      // @ts-expect-error: `code` solo admite un ErrorCode
      log.error('ipc.internal', { code: 'cualquier cosa' });
    };
    expect(typeof typeOnly).toBe('function');
  });
});
