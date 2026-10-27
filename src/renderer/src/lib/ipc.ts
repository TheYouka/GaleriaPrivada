// Envoltorio tipado de window.galeria (docs/DESIGN.md §10.2). Una promesa rechazada (canal fuera de
// la allowlist, ventana destruida) se convierte en un Result con INTERNAL: la UI nunca ve excepciones.
import type { Result } from '@shared/errors';
import type {
  EventChannel,
  GaleriaApi,
  InvokeArgs,
  InvokeChannel,
  PayloadOf,
  ResOf,
} from '@shared/ipc-contract';

function api(): GaleriaApi {
  return window.galeria;
}

export async function invoke<C extends InvokeChannel>(
  channel: C,
  ...args: InvokeArgs<C>
): Promise<Result<ResOf<C>>> {
  try {
    return await api().invoke(channel, ...args);
  } catch {
    return { ok: false, error: { code: 'INTERNAL' } };
  }
}

/** Devuelve la función para darse de baja. */
export function on<E extends EventChannel>(
  event: E,
  cb: (payload: PayloadOf<E>) => void,
): () => void {
  return api().on(event, cb);
}

export function initialTheme(): GaleriaApi['initialTheme'] {
  return api().initialTheme;
}

/** Ganchos de prueba del renderer (solo sin empaquetar y con GALERIA_E2E=1, §23.2). */
export function testHooksEnabled(): boolean {
  return window.galeria.testHooks === true;
}
