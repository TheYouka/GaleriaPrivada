// Zoom y desplazamiento del visor (docs/DESIGN.md §16.2). La superficie ocupa toda la vista del
// visor (la rueda y el arrastre funcionan también fuera de la foto) y dentro lleva la caja de la foto,
// centrada, con `transform: translate(x, y) scale(s)`. La matemática es pura (zoom-math.ts).
//   rueda / pellizco (ctrl+rueda): s ← clamp(s · 1.1^(−deltaY/100)), centrado en el cursor
//   doble clic: 1 ↔ 2, centrado en el punto          arrastre (s > 1): desplaza, con cursor grab
// El teclado (+, −, 0 y las flechas con zoom) lo atiende el visor a través del `ref`.
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from 'react';
import {
  clampPan,
  FIT,
  panBy,
  toggleZoom,
  wheelScale,
  zoomAt,
  type Point,
  type Size,
  type ZoomState,
} from './zoom-math';

/** Lo que el visor puede pedirle al zoom con el teclado. */
export interface ZoomPanHandle {
  isZoomed(): boolean;
  reset(): void;
  /** Multiplica la escala, centrado en el medio de la vista. */
  zoomBy(factor: number): void;
  /** Desplaza una fracción de la vista (0,1 = 10 %), en el sentido de la flecha. */
  panByFraction(dx: number, dy: number): void;
}

export interface ZoomPanProps {
  /** Espacio disponible del visor (px). */
  viewport: Size;
  /** Caja "contain" de la foto (px), centrada en la vista. */
  box: Size;
  /** Sin zoom en vídeos ni mientras dura la animación de apertura. */
  enabled: boolean;
  ref?: Ref<ZoomPanHandle>;
  onScaleChange?: (scale: number) => void;
  children: ReactNode;
}

export function ZoomPan({ viewport, box, enabled, ref, onScaleChange, children }: ZoomPanProps) {
  const [raw, setState] = useState<ZoomState>({ ...FIT });
  // El desplazamiento se limita al pintar: si cambia la vista o la caja, nunca queda un hueco.
  const state = useMemo(() => clampPan(raw, box, viewport), [raw, box, viewport]);
  const [dragging, setDragging] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  const latest = useRef({ state, box, viewport, enabled });
  const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  useEffect(() => {
    latest.current = { state, box, viewport, enabled };
  });

  useEffect(() => {
    onScaleChange?.(state.scale);
  }, [state.scale, onScaleChange]);

  const centerOf = useCallback((clientX: number, clientY: number): Point => {
    const rect = surface.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  }, []);

  // La rueda tiene que poder cancelar el zoom de página de ctrl+rueda: listener no pasivo.
  useEffect(() => {
    const el = surface.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      const cur = latest.current;
      if (!cur.enabled) return;
      e.preventDefault();
      const deltaY = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      const next = wheelScale(cur.state.scale, deltaY);
      if (next === cur.state.scale) return;
      setState(zoomAt(cur.state, next, centerOf(e.clientX, e.clientY), cur.box, cur.viewport));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [centerOf]);

  useImperativeHandle(
    ref,
    () => ({
      isZoomed: () => latest.current.state.scale > 1,
      reset: () => setState({ ...FIT }),
      zoomBy: (factor) => {
        const cur = latest.current;
        if (!cur.enabled) return;
        setState(
          zoomAt(cur.state, cur.state.scale * factor, { x: 0, y: 0 }, cur.box, cur.viewport),
        );
      },
      panByFraction: (dx, dy) => {
        const cur = latest.current;
        setState(
          panBy(cur.state, -dx * cur.viewport.w, -dy * cur.viewport.h, cur.box, cur.viewport),
        );
      },
    }),
    [],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || state.scale <= 1 || !enabled) return;
    // Sin esto el navegador empezaría a arrastrar la imagen en vez de desplazarla.
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    drag.current = { pointerId: d.pointerId, x: e.clientX, y: e.clientY };
    setState((s) => panBy(s, dx, dy, box, viewport));
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const zoomed = state.scale > 1;
  return (
    // La superficie es un contenedor de gestos del ratón: el equivalente por teclado (+, −, 0 y las
    // flechas) lo atiende el visor, que es el diálogo.
    <div
      ref={surface}
      data-zoom-surface=""
      data-scale={state.scale.toFixed(3)}
      data-pan-x={state.x.toFixed(1)}
      data-pan-y={state.y.toFixed(1)}
      className="absolute inset-0 touch-none overflow-hidden"
      style={{ cursor: zoomed ? (dragging ? 'grabbing' : 'grab') : 'default' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={(e) => {
        if (!enabled) return;
        setState((s) => toggleZoom(s, centerOf(e.clientX, e.clientY), box, viewport));
      }}
    >
      <div
        className="absolute"
        style={{
          left: (viewport.w - box.w) / 2,
          top: (viewport.h - box.h) / 2,
          width: box.w,
          height: box.h,
        }}
      >
        <div
          className="size-full"
          style={{
            transform: `translate(${state.x}px, ${state.y}px) scale(${state.scale})`,
            transformOrigin: '50% 50%',
            willChange: 'transform',
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
