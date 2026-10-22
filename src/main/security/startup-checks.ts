// Switches de depuración prohibidos en el binario empaquetado (docs/DESIGN.md §5.2, paso 2).
// Los fuses cierran --inspect de Node, pero no los switches de depuración de Chromium.
// El script de main se ejecuta antes de que Chromium arranque el servidor de DevTools,
// así que salir aquí impide que llegue a abrirse el puerto o la tubería CDP.
export const FORBIDDEN_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-pipe',
  'remote-debugging-address',
  'inspect',
  'inspect-brk',
  'inspect-port',
  'js-flags',
] as const;

export type ForbiddenSwitch = (typeof FORBIDDEN_SWITCHES)[number];

/** Sin empaquetar no se comprueba: las DevTools y el inspector se usan en desarrollo y en los E2E. */
export function forbiddenDebugSwitch(
  isPackaged: boolean,
  has: (s: string) => boolean,
): ForbiddenSwitch | null {
  return isPackaged ? (FORBIDDEN_SWITCHES.find((s) => has(s)) ?? null) : null;
}
