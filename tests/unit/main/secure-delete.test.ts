// secure-delete.ts (docs/DESIGN.md §12.4 pasos 8–9): fstat del descriptor contra el snapshot,
// enlaces duros, original cambiado y sin permiso de escritura.
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  readFileSync,
  renameSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  defaultSecureDeleteIo,
  secureDeleteOriginal,
  ZERO_BLOCK_BYTES,
  type DeleteFileHandle,
  type SecureDeleteIo,
} from '../../../src/main/import/secure-delete';
import { snapshotOf, type Snapshot } from '../../../src/main/import/walk';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const tmp = makeTmpDir('secure-delete');
afterAll(() => removeTmpDir(tmp));

const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
const snap = (p: string): Snapshot => snapshotOf(lstatSync(p, { bigint: true }));

function original(name: string, bytes = 2.5 * ZERO_BLOCK_BYTES): string {
  const p = join(tmp, name);
  writeFileSync(p, randomBytes(Math.floor(bytes)));
  return p;
}

/** Espía de las escrituras del descriptor (ceros, truncado y fsync). */
function spyIo(): { io: SecureDeleteIo; writes: Buffer[]; calls: string[] } {
  const writes: Buffer[] = [];
  const calls: string[] = [];
  const io: SecureDeleteIo = {
    ...defaultSecureDeleteIo,
    open: async (p, flags) => {
      const fh = await defaultSecureDeleteIo.open(p, flags);
      const wrapped: DeleteFileHandle = {
        stat: ((opts: unknown) => fh.stat(opts as never)) as DeleteFileHandle['stat'],
        write: (async (buf: Buffer, off: number, len: number, pos: number) => {
          writes.push(Buffer.from(buf.subarray(off, off + len)));
          calls.push(`write@${pos}`);
          return fh.write(buf, off, len, pos);
        }) as DeleteFileHandle['write'],
        sync: async () => {
          calls.push('sync');
          return fh.sync();
        },
        truncate: async (len?: number) => {
          calls.push(`truncate(${len})`);
          return fh.truncate(len);
        },
        close: () => fh.close(),
      };
      return wrapped;
    },
  };
  return { io, writes, calls };
}

describe('caso normal (nlink = 1)', () => {
  it('ceros en bloques de 1 MiB, fsync, ftruncate(0), fsync y unlink', async () => {
    const p = original('normal.jpg');
    const size = lstatSync(p).size;
    const { io, writes, calls } = spyIo();
    expect(await secureDeleteOriginal(p, snap(p), io)).toEqual({
      outcome: 'deleted',
      mode: 'overwritten',
    });
    expect(existsSync(p)).toBe(false);
    expect(writes.reduce((n, w) => n + w.length, 0)).toBe(size);
    expect(writes.every((w) => w.length <= ZERO_BLOCK_BYTES && w.every((b) => b === 0))).toBe(true);
    expect(calls.slice(-3)).toEqual(['sync', 'truncate(0)', 'sync']);
    expect(calls.filter((c) => c.startsWith('write@'))).toEqual([
      'write@0',
      `write@${ZERO_BLOCK_BYTES}`,
      `write@${2 * ZERO_BLOCK_BYTES}`,
    ]);
  });

  it('archivo vacío: se borra', async () => {
    const p = original('vacio.jpg', 0);
    expect((await secureDeleteOriginal(p, snap(p))).outcome).toBe('deleted');
    expect(existsSync(p)).toBe(false);
  });
});

describe('enlace duro (nlink > 1)', () => {
  it('con fs.link, el segundo nombre conserva su SHA-256 y solo se quita el nombre importado', async () => {
    const p = original('con-enlace.jpg');
    const other = join(tmp, 'otro-nombre.jpg');
    linkSync(p, other);
    const before = sha(other);
    const { io, writes } = spyIo();
    expect(await secureDeleteOriginal(p, snap(p), io)).toEqual({
      outcome: 'deleted',
      mode: 'hardlink',
    });
    expect(writes).toEqual([]);
    expect(existsSync(p)).toBe(false);
    expect(sha(other)).toBe(before);
  });
});

describe('CHANGED_DURING_IMPORT: el original no se toca', () => {
  it('modificado después del escaneo (tamaño)', async () => {
    const p = original('crece.jpg', 1000);
    const scanned = snap(p);
    appendFileSync(p, 'más');
    const before = sha(p);
    expect(await secureDeleteOriginal(p, scanned)).toEqual({ outcome: 'changed' });
    expect(sha(p)).toBe(before);
  });

  it('mismo tamaño y otro mtime', async () => {
    const p = original('retocado.jpg', 1000);
    const scanned = snap(p);
    writeFileSync(p, randomBytes(1000));
    utimesSync(p, new Date(2020, 0, 1), new Date(2020, 0, 1));
    const before = sha(p);
    expect(await secureDeleteOriginal(p, scanned)).toEqual({ outcome: 'changed' });
    expect(sha(p)).toBe(before);
  });

  it('sustituido por otro archivo con el mismo nombre (otro ino)', async () => {
    const p = original('sustituido.jpg', 1000);
    const when = new Date(2024, 4, 17, 10, 30, 0);
    utimesSync(p, when, when);
    const scanned = snap(p);
    // Mismo tamaño y mismo mtime, pero otro archivo (otro ino).
    const content = randomBytes(1000);
    writeFileSync(`${p}.tmp`, content);
    utimesSync(`${p}.tmp`, when, when);
    await defaultSecureDeleteIo.unlink(p);
    renameSync(`${p}.tmp`, p);
    const now = snap(p);
    expect(now.size).toBe(scanned.size);
    expect(now.mtimeNs).toBe(scanned.mtimeNs);
    expect(now.ino).not.toBe(scanned.ino);
    expect(await secureDeleteOriginal(p, scanned)).toEqual({ outcome: 'changed' });
    expect(readFileSync(p).equals(content)).toBe(true);
  });

  it('ya no existe', async () => {
    const p = original('borrado.jpg', 10);
    const scanned = snap(p);
    await defaultSecureDeleteIo.unlink(p);
    expect(await secureDeleteOriginal(p, scanned)).toEqual({ outcome: 'changed' });
  });

  it('la ruta pasó a ser un enlace simbólico (si el sistema permite crearlo)', async () => {
    const p = original('enlace.jpg', 1000);
    const scanned = snap(p);
    const target = original('destino.jpg', 1000);
    const before = sha(target);
    await defaultSecureDeleteIo.unlink(p);
    try {
      symlinkSync(target, p, 'file');
    } catch {
      return; // Windows sin privilegio de enlaces simbólicos
    }
    expect(await secureDeleteOriginal(p, scanned)).toEqual({ outcome: 'changed' });
    expect(sha(target)).toBe(before);
  });
});

describe('sin permiso de escritura', () => {
  it('lstat + misma comparación + unlink (sin sobrescribir)', async () => {
    const p = original('solo-lectura.jpg', 1000);
    chmodSync(p, 0o444);
    const scanned = snap(p);
    const { io, writes } = spyIo();
    const opened: string[] = [];
    const denied: SecureDeleteIo = {
      ...io,
      open: async (path) => {
        opened.push(path);
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
    };
    expect(await secureDeleteOriginal(p, scanned, denied)).toEqual({
      outcome: 'deleted',
      mode: 'unlink-only',
    });
    expect(opened).toEqual([p]);
    expect(writes).toEqual([]);
    expect(existsSync(p)).toBe(false);
  });

  it('sin permiso y cambiado → no se toca', async () => {
    const p = original('solo-lectura-cambiado.jpg', 1000);
    const scanned = snap(p);
    appendFileSync(p, 'x');
    const denied: SecureDeleteIo = {
      ...defaultSecureDeleteIo,
      open: async () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      },
    };
    expect(await secureDeleteOriginal(p, scanned, denied)).toEqual({ outcome: 'changed' });
    expect(existsSync(p)).toBe(true);
  });
});

describe('unlink que falla', () => {
  it('→ failed (originalsNotDeleted IO)', async () => {
    const p = original('bloqueado.jpg', 100);
    const io: SecureDeleteIo = {
      ...defaultSecureDeleteIo,
      unlink: async () => {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      },
    };
    expect(await secureDeleteOriginal(p, snap(p), io)).toEqual({ outcome: 'failed' });
  });
});
