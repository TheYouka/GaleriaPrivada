// Fondo `waves` del tema Ondas (docs/DESIGN.md §15.7): canvas 2D a media resolución, 30 fps como
// mucho, sin ningún rAF con `paused` y un único fotograma estático con movimiento reducido. El color
// sigue al mes y el brillo a la hora (se recalculan como mucho una vez por minuto, sin temporizador:
// dentro del propio fotograma), y el coste de dibujo se mantiene en ≤ 3 ms reduciendo el detalle de las
// cintas si hace falta. `data-animating` refleja si hay bucle (no revela nada de la bóveda).
import { useEffect, useRef } from 'react';
import {
  backingSize,
  drawWaves,
  FrameBudget,
  FrameLoop,
  wavesColorsAt,
  type FrameScheduler,
} from './waves';

const browserScheduler: FrameScheduler = {
  request: (cb) => window.requestAnimationFrame(cb),
  cancel: (handle) => window.cancelAnimationFrame(handle),
};

/** Cada cuánto se vuelve a leer la hora para el color y el brillo (ms). */
const COLOR_REFRESH_MS = 60_000;

export interface WavesBackgroundProps {
  paused: boolean;
  reducedMotion: boolean;
}

export function WavesBackground({ paused, reducedMotion }: WavesBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Último instante dibujado: al pausar se conserva el fotograma. */
  const lastTime = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d', { alpha: false });
    if (!canvas || !ctx) return;
    const animate = !paused && !reducedMotion;
    if (reducedMotion) lastTime.current = 0;
    const budget = new FrameBudget();
    let colors = wavesColorsAt(new Date());
    let colorsAt = Date.now();
    const draw = (t: number): void => {
      const started = performance.now();
      const now = Date.now();
      if (now - colorsAt > COLOR_REFRESH_MS) {
        colors = wavesColorsAt(new Date(now));
        colorsAt = now;
      }
      lastTime.current = t;
      drawWaves(ctx, canvas.width, canvas.height, t, colors, budget.stepScale);
      budget.record(performance.now() - started);
    };
    const loop = new FrameLoop(browserScheduler, draw);
    const resize = (): void => {
      const { width, height } = backingSize(canvas.clientWidth, canvas.clientHeight);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      // Cambiar el tamaño borra el canvas: se repinta el último fotograma (estático o en pausa).
      drawWaves(ctx, canvas.width, canvas.height, lastTime.current, colors, budget.stepScale);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    if (animate) loop.start();
    canvas.dataset.animating = animate ? 'true' : 'false';
    return () => {
      loop.stop();
      observer.disconnect();
    };
  }, [paused, reducedMotion]);

  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" data-waves="" />;
}
