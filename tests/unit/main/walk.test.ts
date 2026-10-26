// walk.ts (docs/DESIGN.md §12.3, punto 1): recursivo, sin seguir enlaces ni junctions, 32 niveles y
// cupo de archivos por trabajo; snapshot bigint exacto.
import { lstatSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { newWalkBudget, sameSnapshot, snapshotOf, walk } from '../../../src/main/import/walk';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const tmp = makeTmpDir('walk');
afterAll(() => removeTmpDir(tmp));

function tree(name: string): string {
  const root = join(tmp, name);
  mkdirSync(join(root, 'sub', 'subsub'), { recursive: true });
  writeFileSync(join(root, 'b.jpg'), 'b');
  writeFileSync(join(root, 'a.jpg'), 'a');
  writeFileSync(join(root, 'sub', 'c.jpg'), 'c');
  writeFileSync(join(root, 'sub', 'subsub', 'd.jpg'), 'd');
  return root;
}

/** Enlace simbólico a un archivo: en Windows sin privilegios da EPERM y el caso se omite. */
function trySymlink(target: string, path: string, type?: 'file' | 'dir' | 'junction'): boolean {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch {
    return false;
  }
}

describe('walk', () => {
  it('recorre de forma recursiva, en orden estable, con snapshot bigint', async () => {
    const root = tree('basico');
    const { files, skipped, truncated } = await walk(root);
    expect(files.map((f) => f.path)).toEqual([
      join(root, 'a.jpg'),
      join(root, 'b.jpg'),
      join(root, 'sub', 'c.jpg'),
      join(root, 'sub', 'subsub', 'd.jpg'),
    ]);
    expect(skipped).toBe(0);
    expect(truncated).toBe(false);
    const first = files[0];
    expect(typeof first?.snapshot.ino).toBe('bigint');
    expect(typeof first?.snapshot.mtimeNs).toBe('bigint');
    expect(
      sameSnapshot(first!.snapshot, snapshotOf(lstatSync(join(root, 'a.jpg'), { bigint: true }))),
    ).toBe(true);
  });

  it('omite junctions y enlaces simbólicos (nunca sigue su destino)', async () => {
    const outside = tree('destino');
    const root = join(tmp, 'con-enlaces');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'propio.jpg'), 'x');
    expect(trySymlink(outside, join(root, 'junction'), 'junction')).toBe(true);
    const fileLink = trySymlink(join(outside, 'a.jpg'), join(root, 'enlace.jpg'), 'file');
    const { files, skipped } = await walk(root);
    expect(files.map((f) => f.path)).toEqual([join(root, 'propio.jpg')]);
    expect(skipped).toBe(fileLink ? 2 : 1);
  });

  it('no baja de 32 niveles por debajo de la raíz', async () => {
    const root = join(tmp, 'profundo');
    let dir = root;
    for (let i = 0; i <= 33; i += 1) {
      dir = join(dir, `n${i}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'f.jpg'), String(i));
    }
    const { files, skipped } = await walk(root);
    // n0 está en el nivel 1, …, n31 en el 32: entran 32 carpetas; n32 se omite.
    expect(files).toHaveLength(32);
    expect(skipped).toBe(1);
    const shallow = await walk(root, { maxDepth: 2 });
    expect(shallow.files).toHaveLength(2);
  });

  it('el cupo es del trabajo, compartido entre carpetas', async () => {
    const a = tree('cupo-a');
    const b = tree('cupo-b');
    const budget = newWalkBudget(6);
    const first = await walk(a, { budget });
    expect(first.files).toHaveLength(4);
    expect(first.truncated).toBe(false);
    const second = await walk(b, { budget });
    expect(second.files).toHaveLength(2);
    expect(second.truncated).toBe(true);
    expect(budget.remaining).toBe(0);
  });

  it('enterDir puede excluir carpetas y la señal detiene el recorrido', async () => {
    const root = tree('filtro');
    const { files } = await walk(root, { enterDir: async (p) => !p.endsWith('sub') });
    expect(files).toHaveLength(2);
    const ac = new AbortController();
    ac.abort();
    expect((await walk(root, { signal: ac.signal })).files).toHaveLength(0);
  });

  it('una carpeta que no existe cuenta como omitida, sin lanzar', async () => {
    expect(await walk(join(tmp, 'no-existe'))).toEqual({ files: [], skipped: 1, truncated: false });
  });
});
