// session:activity (docs/DESIGN.md §13.2): el renderer avisa a main de que hay actividad con
// pointerdown, keydown, wheel y pointermove, como mucho una vez cada 10 s. Solo con la bóveda abierta.
import { invoke } from './ipc';

export const ACTIVITY_THROTTLE_MS = 10_000;
export const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'pointermove'] as const;

/** Devuelve una función que llama a `send` como mucho una vez cada `throttleMs`. */
export function createActivityReporter(
  send: () => void,
  now: () => number = () => performance.now(),
  throttleMs: number = ACTIVITY_THROTTLE_MS,
): () => void {
  let last = Number.NEGATIVE_INFINITY;
  return () => {
    const t = now();
    if (t - last < throttleMs) return;
    last = t;
    send();
  };
}

/** Escucha la actividad en la ventana; devuelve la función para dejar de escuchar. */
export function installActivityReporter(target: Window = window): () => void {
  const report = createActivityReporter(() => {
    void invoke('session:activity');
  });
  const options: AddEventListenerOptions = { capture: true, passive: true };
  for (const type of ACTIVITY_EVENTS) target.addEventListener(type, report, options);
  return () => {
    for (const type of ACTIVITY_EVENTS) target.removeEventListener(type, report, options);
  };
}
