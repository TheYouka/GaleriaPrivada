// Animaciones del escenario de la presentación (docs/DESIGN.md §17.3): lleva a Motion `animate()` la
// descripción pura de `transitions.ts`. Solo se animan `opacity` y `transform`, que se componen en
// la GPU. Cada capa tiene dos elementos: la capa (fundido y deslizamiento) y su contenido (Ken Burns,
// que dura D + slideMs + D y no debe pelearse con el fundido).
//
// Cada animate() lleva `reduceMotion: false`: ni <MotionConfig> ni prefers-reduced-motion afectan a
// la presentación, que sigue lo que el usuario eligió (PLAN.md nota 191). Con el corte, Ken Burns
// anima solo el contenido.
import { animate } from 'motion';
import type { TransitionPlan } from './transitions';

type Controls = ReturnType<typeof animate>;

interface LayerEls {
  layer: HTMLElement;
  content: HTMLElement;
}

export interface TransitionRequest {
  from: number | null;
  to: number;
  plan: TransitionPlan;
}

export class StageAnimator {
  private readonly layers = new Map<number, LayerEls>();
  private readonly running = new Map<number, Set<Controls>>();
  private paused = false;
  /** Última transición animada (para los ganchos de prueba). */
  last: { type: string; durationMs: number } | null = null;

  register(index: number, els: LayerEls | null): void {
    if (els) this.layers.set(index, els);
    else {
      this.stop(index);
      this.layers.delete(index);
    }
  }

  /** Empieza la entrada de `to` y la salida de `from`; el plan lo decide `transitions.ts`. */
  transition({ from, to, plan }: TransitionRequest): void {
    this.last = { type: plan.type, durationMs: plan.durationMs };
    const incoming = this.layers.get(to);
    const outgoing = from === null ? undefined : this.layers.get(from);
    if (incoming) incoming.layer.style.zIndex = '2';
    if (outgoing) outgoing.layer.style.zIndex = '1';
    if (!plan.incoming || !plan.outgoing || plan.durationMs <= 0 || !plan.easing) {
      // Corte instantáneo.
      if (incoming) this.setFrame(incoming.layer, { opacity: 1, transform: 'none' });
      if (outgoing) this.setFrame(outgoing.layer, { opacity: 0, transform: 'none' });
    } else {
      const options = {
        duration: plan.durationMs / 1000,
        ease: plan.easing,
        reduceMotion: false,
      };
      if (incoming) {
        this.track(
          to,
          animate(
            incoming.layer,
            {
              opacity: [plan.incoming.from.opacity, plan.incoming.to.opacity],
              transform: [plan.incoming.from.transform, plan.incoming.to.transform],
            },
            options,
          ),
        );
      }
      if (outgoing && from !== null) {
        this.track(
          from,
          animate(
            outgoing.layer,
            {
              opacity: [plan.outgoing.from.opacity, plan.outgoing.to.opacity],
              transform: [plan.outgoing.from.transform, plan.outgoing.to.transform],
            },
            options,
          ),
        );
      }
    }
    if (incoming && plan.kenBurns) {
      const kb = plan.kenBurns;
      incoming.content.style.transform = kb.fromTransform;
      this.track(
        to,
        animate(
          incoming.content,
          { transform: [kb.fromTransform, kb.toTransform] },
          { duration: kb.durationMs / 1000, ease: 'linear', reduceMotion: false },
        ),
      );
    }
  }

  /** La capa va a desaparecer (o la cortó una navegación manual): sus animaciones paran. */
  stop(index: number): void {
    const set = this.running.get(index);
    if (!set) return;
    for (const controls of set) controls.stop();
    this.running.delete(index);
  }

  /** La pausa congela también las animaciones en curso, igual que el planificador (§17.4). */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    for (const set of this.running.values()) {
      for (const controls of set) {
        if (paused) controls.pause();
        else controls.play();
      }
    }
  }

  dispose(): void {
    for (const index of [...this.running.keys()]) this.stop(index);
    this.layers.clear();
  }

  private setFrame(el: HTMLElement, frame: { opacity: number; transform: string }): void {
    el.style.opacity = String(frame.opacity);
    el.style.transform = frame.transform;
  }

  private track(index: number, controls: Controls): void {
    let set = this.running.get(index);
    if (!set) {
      set = new Set();
      this.running.set(index, set);
    }
    set.add(controls);
    if (this.paused) controls.pause();
    void controls.then(
      () => set.delete(controls),
      () => set.delete(controls),
    );
  }
}
