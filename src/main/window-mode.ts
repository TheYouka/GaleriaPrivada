// Modo de ventana discreto SOLO para tests (docs/PLAN.md, nota 135): sin empaquetar y con
// GALERIA_E2E=1 las ventanas nacen fuera de la pantalla, sin botón en la barra de tareas y se
// muestran sin activarse, para que una ejecución de los E2E no robe el foco mientras el usuario
// trabaja. No se puede desactivar con otra variable. Es puro (sin `electron`) para probarlo en Vitest.

/** Posición de las ventanas en modo discreto (la que usa Windows para las minimizadas). */
export const STEALTH_WINDOW_POSITION = -32000;

export function isStealthWindowMode(
  isPackaged: boolean,
  env: Record<string, string | undefined>,
): boolean {
  return !isPackaged && env.GALERIA_E2E === '1';
}
