// Recorrido de carpetas de la importación (docs/DESIGN.md §12.3, punto 1): recursivo, sin seguir
// enlaces (los enlaces simbólicos y las junctions se omiten, así nunca se borra el destino de un
// enlace), hasta 32 niveles de profundidad y 100 000 archivos por trabajo. Lo que no es un archivo
// regular se omite. De cada archivo se guarda `snapshot = { dev, ino, size, mtimeNs }` como bigint
// (en Windows `ino` es el file index de NTFS, que puede pasar de 2^53); todas las comparaciones
// posteriores son exactas sobre los cuatro campos.
//
// Cada entrada se mira con lstat (no con el tipo de Dirent): en Windows las junctions salen como
// enlaces en lstat. Las rutas se construyen con join(dir, nombre) a partir de la ruta recibida, sin
// normalizar el nombre [H3-3].
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BigIntStats } from 'node:fs';
import { WALK_MAX_DEPTH, WALK_MAX_FILES } from '@shared/constants';

/** Identidad y versión de un archivo en el escaneo (§12.3, punto 1). */
export interface Snapshot {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

export function snapshotOf(st: BigIntStats): Snapshot {
  return { dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs };
}

/** Comparación exacta de los cuatro campos. */
export function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

export interface WalkFile {
  path: string;
  snapshot: Snapshot;
}

/** Cupo de archivos compartido por todas las carpetas de un mismo trabajo. */
export interface WalkBudget {
  remaining: number;
}

export function newWalkBudget(max = WALK_MAX_FILES): WalkBudget {
  return { remaining: max };
}

export interface WalkOptions {
  /** Niveles por debajo de la raíz (la raíz es el nivel 0). Por defecto 32. */
  maxDepth?: number;
  /** Cupo del trabajo. Por defecto uno nuevo de 100 000. */
  budget?: WalkBudget;
  signal?: AbortSignal;
  /** Se consulta antes de entrar en cada subcarpeta (p. ej. path-guard); false → se omite. */
  enterDir?: (path: string) => Promise<boolean>;
}

export interface WalkResult {
  /** En orden: por carpeta y, dentro de cada una, por nombre (orden estable). */
  files: WalkFile[];
  /** Enlaces, no regulares, carpetas fuera de profundidad o ilegibles, y entradas que fallaron. */
  skipped: number;
  /** true si se agotó el cupo de archivos: el resto no se recorre. */
  truncated: boolean;
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Recorre `root` (una carpeta que el llamador ya comprobó con lstat). Nunca lanza por E/S: una
 * carpeta o entrada que no se puede leer cuenta en `skipped`. Con la señal abortada, para.
 */
export async function walk(root: string, opts: WalkOptions = {}): Promise<WalkResult> {
  const maxDepth = opts.maxDepth ?? WALK_MAX_DEPTH;
  const budget = opts.budget ?? newWalkBudget();
  const result: WalkResult = { files: [], skipped: 0, truncated: false };

  const visit = async (dir: string, depth: number): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(dir)).sort(compareNames);
    } catch {
      result.skipped += 1;
      return;
    }
    const subdirs: string[] = [];
    for (const name of names) {
      if (opts.signal?.aborted || result.truncated) return;
      const path = join(dir, name);
      let st: BigIntStats;
      try {
        st = await lstat(path, { bigint: true });
      } catch {
        result.skipped += 1;
        continue;
      }
      if (st.isSymbolicLink()) {
        result.skipped += 1;
      } else if (st.isDirectory()) {
        subdirs.push(path);
      } else if (st.isFile()) {
        if (budget.remaining <= 0) {
          result.truncated = true;
          return;
        }
        budget.remaining -= 1;
        result.files.push({ path, snapshot: snapshotOf(st) });
      } else {
        result.skipped += 1;
      }
    }
    for (const sub of subdirs) {
      if (opts.signal?.aborted || result.truncated) return;
      if (depth + 1 > maxDepth) {
        result.skipped += 1;
        continue;
      }
      if (opts.enterDir && !(await opts.enterDir(sub).catch(() => false))) {
        result.skipped += 1;
        continue;
      }
      await visit(sub, depth + 1);
    }
  };

  await visit(root, 0);
  return result;
}
