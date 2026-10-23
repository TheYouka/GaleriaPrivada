// Bloqueo por inactividad (docs/DESIGN.md §12.11 y §13.2). El temporizador corre solo si la sesión
// está desbloqueada, el tiempo no es 0 (desactivado) y el conjunto de motivos de pausa está vacío:
//   - 'playback': session:setPlayback { active: true } (presentación o vídeo, D12);
//   - 'maintenance': traslado de la bóveda (F2);
//   - 'job': una fusión o una importación fuera de awaiting-confirmation (D18).
// Cada vez que pasa a correr (al arrancar, al quitarse el último motivo o con actividad) empieza
// desde cero. La suspensión, el bloqueo del SO y el bloqueo manual no pasan por aquí: bloquean
// siempre (§13.2).

export type PauseReason = 'playback' | 'maintenance' | 'job';

export class AutoLock {
  private readonly reasons = new Set<PauseReason>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private ms = 0;

  constructor(private readonly onExpire: () => void) {}

  /** Motivos de pausa activos (copia). */
  get pauseReasons(): PauseReason[] {
    return [...this.reasons];
  }

  /** true si el temporizador está corriendo. */
  get running(): boolean {
    return this.timer !== null;
  }

  get timeoutMs(): number {
    return this.ms;
  }

  /** Arranca con la sesión desbloqueada. `ms = 0` = desactivado. */
  start(ms: number): void {
    this.started = true;
    this.ms = Math.max(0, ms);
    this.restart();
  }

  /** Cambia el tiempo (Ajustes → Seguridad) y reinicia desde cero. */
  setTimeoutMs(ms: number): void {
    this.ms = Math.max(0, ms);
    if (this.started) this.restart();
  }

  /** Detiene todo y olvida los motivos de pausa (fin de la sesión). */
  stop(): void {
    this.started = false;
    this.reasons.clear();
    this.clear();
  }

  /** session:activity: reinicia desde cero si está corriendo. */
  activity(): void {
    if (this.timer) this.restart();
  }

  pause(reason: PauseReason): void {
    this.reasons.add(reason);
    this.clear();
  }

  resume(reason: PauseReason): void {
    if (!this.reasons.delete(reason)) return;
    if (this.reasons.size === 0 && this.started) this.restart();
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private restart(): void {
    this.clear();
    if (!this.started || this.ms <= 0 || this.reasons.size > 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.started = false;
      this.onExpire();
    }, this.ms);
  }
}
