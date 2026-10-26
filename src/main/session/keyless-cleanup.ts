// Limpiezas sin claves que siguen después del bloqueo (docs/DESIGN.md §13.3, paso 6): cerrar los
// descriptores de readers y writers abortados, borrar los .part de los trabajos abortados y, en F2,
// continuar o deshacer un traslado de la bóveda. Ninguna tarea puede leer ni escribir la DB ni usar
// claves: solo reciben rutas y descriptores.
//
// Serializa por ruta: si ya hay una tarea sobre una ruta, otra petición para la misma se une a la
// existente (recibe la misma promesa) en lugar de empezar otra. Las tareas nunca rechazan: un fallo
// se registra con un `warn` y lo resuelven la reconciliación o `pendingCleanup` (12.6, 8.2).
import { resolve } from 'node:path';
import { log } from '../log';

export type KeylessTask = () => Promise<void>;

/**
 * Clave de la unidad de los pasos 5–6 de un traslado (rename + profiles.json, §8.7). El desbloqueo
 * de ese perfil la espera antes de leer profiles.json (§13.1, paso 1).
 */
export function relocateCommitKey(profileId: string): string {
  return `relocate-commit:${profileId}`;
}

function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : undefined;
}

export class KeylessCleanup {
  private readonly tasks = new Map<string, Promise<void>>();

  /** Clave de una ruta: absoluta y, en Windows, sin distinguir mayúsculas. */
  static keyOf(path: string): string {
    const abs = resolve(path);
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  }

  /**
   * Ejecuta `task` sobre `path`, o se une a la tarea que ya esté en curso sobre esa ruta. Para un
   * descriptor sin ruta, usa una clave propia (p. ej. `fd:<n>`) con `runKey`.
   */
  run(path: string, task: KeylessTask): Promise<void> {
    return this.runKey(KeylessCleanup.keyOf(path), task);
  }

  runKey(key: string, task: KeylessTask): Promise<void> {
    const existing = this.tasks.get(key);
    if (existing) return existing;
    const promise: Promise<void> = Promise.resolve()
      .then(task)
      .catch((err: unknown) => {
        log.warn('session.cleanup-failed', { errno: errnoOf(err) });
      })
      .finally(() => {
        if (this.tasks.get(key) === promise) this.tasks.delete(key);
      });
    this.tasks.set(key, promise);
    return promise;
  }

  /** Tarea en curso sobre `path`, si la hay (el desbloqueo espera las de traslado, §13.1). */
  pending(path: string): Promise<void> | undefined {
    return this.tasks.get(KeylessCleanup.keyOf(path));
  }

  /** Tarea en curso con la clave `key` de runKey, si la hay. */
  pendingKey(key: string): Promise<void> | undefined {
    return this.tasks.get(key);
  }

  get size(): number {
    return this.tasks.size;
  }

  /** Se resuelve cuando terminan todas las tareas en curso ahora. */
  async idle(): Promise<void> {
    await Promise.all([...this.tasks.values()]);
  }
}
