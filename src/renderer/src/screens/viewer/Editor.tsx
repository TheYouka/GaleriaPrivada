// Editor de fotos (docs/DESIGN.md §16.4), sobre el visor con la tecla `E`: recortar (rectángulo con
// 8 asas, proporciones y rejilla de tercios, manejable con el teclado), girar, voltear, deshacer y
// rehacer, "Restablecer original", "Cancelar" y "Guardar".
//
// La sesión parte de las operaciones guardadas L y añade las del usuario para formar L'. La pila de
// deshacer vive aquí. "Guardar" envía `edits:save { ops: L' }` (si L' pasa de 64 operaciones, antes se
// colapsa a su forma canónica); "Restablecer original" deja L' = [] y "Cancelar" lo descarta todo.
// El rectángulo del recorte se aplica con "Aplicar recorte" (o Intro); si queda uno pendiente, girar,
// voltear y guardar lo aplican antes. El original nunca se modifica: main guarda solo las operaciones.
import { useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from 'react';
import {
  Check,
  ChevronDown,
  Crop,
  FlipHorizontal2,
  FlipVertical2,
  Redo2,
  RotateCcw,
  RotateCw,
  Undo2,
} from 'lucide-react';
import { Select } from 'radix-ui';
import { foldEdits, FULL_CROP, isFullCrop, opsForSave, type CropRect } from '@shared/edits';
import type { EditOp, MediaListItem } from '@shared/types';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import { announce } from '../../lib/announce';
import { cx } from '../../lib/cx';
import { errorMessage } from '../../lib/errors-es';
import { invoke } from '../../lib/ipc';
import { isCtrlKey } from '../../lib/keyboard';
import {
  arrowDelta,
  CROP_HANDLES,
  CROP_RATIOS,
  cropLimits,
  fitRatio,
  HANDLE_LABELS,
  HANDLE_POSITION,
  moveRect,
  ratioK,
  resizeRect,
  type CropHandle,
  type CropLimits,
} from './crop-math';
import { EditedImage } from './EditedImage';
import { useElementSize } from './use-element-size';
import { editedAspect, fitContain, type Size } from './zoom-math';

export interface EditorProps {
  item: MediaListItem;
  /** Operaciones guardadas (media:get). */
  saved: readonly EditOp[];
  /** Dimensiones de la foto tras EXIF (W × H). */
  dims: Size;
  /** vault://media/<id>. */
  src: string;
  onCancel(): void;
  onSaved(result: { edits: EditOp[]; thumbRev: number }): void;
}

// ── Historial ──────────────────────────────────────────────────────────────────────────────────

interface EditorState {
  past: EditOp[][];
  present: EditOp[];
  future: EditOp[][];
  /** Rectángulo del recorte sin aplicar, en la vista actual. */
  rect: CropRect;
  ratioId: string;
}

type EditorAction =
  | { type: 'push'; ops: EditOp[] }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'rect'; rect: CropRect }
  | { type: 'ratio'; ratioId: string; rect: CropRect };

function initialState(saved: readonly EditOp[]): EditorState {
  return { past: [], present: [...saved], future: [], rect: { ...FULL_CROP }, ratioId: 'free' };
}

function reducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'push':
      return {
        past: [...state.past, state.present],
        present: action.ops,
        future: [],
        rect: { ...FULL_CROP },
        ratioId: 'free',
      };
    case 'undo': {
      const previous = state.past.at(-1);
      if (!previous) return state;
      return {
        past: state.past.slice(0, -1),
        present: previous,
        future: [state.present, ...state.future],
        rect: { ...FULL_CROP },
        ratioId: 'free',
      };
    }
    case 'redo': {
      const next = state.future[0];
      if (!next) return state;
      return {
        past: [...state.past, state.present],
        present: next,
        future: state.future.slice(1),
        rect: { ...FULL_CROP },
        ratioId: 'free',
      };
    }
    case 'rect':
      return { ...state, rect: action.rect };
    case 'ratio':
      return { ...state, ratioId: action.ratioId, rect: action.rect };
  }
}

const sameOps = (a: readonly EditOp[], b: readonly EditOp[]): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

// ── Rectángulo de recorte ──────────────────────────────────────────────────────────────────────

const PERCENT = (n: number): string => `${n * 100}%`;
const GUIDE = 'pointer-events-none absolute bg-white/70 shadow-[0_0_0_1px_rgba(0,0,0,0.35)]';
// Los controles sobre la foto no dependen del tema (la foto tampoco): blanco con anillo negro, que se
// ve sobre cualquier imagen. El foco añade un segundo anillo.
const HANDLE_CLASS =
  'absolute size-4 -translate-x-1/2 -translate-y-1/2 border-2 border-black bg-white focus-visible:shadow-[0_0_0_3px_#fff,0_0_0_5px_#000] focus-visible:outline-none';

interface DragState {
  kind: 'move' | CropHandle;
  pointerId: number;
  x: number;
  y: number;
  rect: CropRect;
}

interface CropOverlayProps {
  rect: CropRect;
  box: Size;
  limits: CropLimits;
  k: number | null;
  onRect(rect: CropRect): void;
  onApply(): void;
}

function CropOverlay({ rect, box, limits, k, onRect, onApply }: CropOverlayProps) {
  const drag = useRef<DragState | null>(null);

  const start = (kind: DragState['kind'], e: React.PointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { kind, pointerId: e.pointerId, x: e.clientX, y: e.clientY, rect };
  };
  const move = (e: React.PointerEvent<HTMLButtonElement>): void => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId || box.w <= 0 || box.h <= 0) return;
    const dx = (e.clientX - d.x) / box.w;
    const dy = (e.clientY - d.y) / box.h;
    onRect(
      d.kind === 'move' ? moveRect(d.rect, dx, dy) : resizeRect(d.rect, d.kind, dx, dy, limits, k),
    );
  };
  const end = (e: React.PointerEvent<HTMLButtonElement>): void => {
    if (drag.current?.pointerId !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  /** Flechas: 1 % (10 % con Mayús). Intro aplica el recorte. */
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, kind: 'move' | CropHandle): void => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      onApply();
      return;
    }
    const delta = arrowDelta(e.key, e.shiftKey ? 0.1 : 0.01);
    if (!delta) return;
    e.preventDefault();
    e.stopPropagation();
    onRect(
      kind === 'move'
        ? moveRect(rect, delta.dx, delta.dy)
        : resizeRect(rect, kind, delta.dx, delta.dy, limits, k),
    );
  };

  return (
    <div data-crop-overlay="" className="absolute inset-0">
      {/* Oscurece lo que queda fuera del recorte; recortado a la foto para no tapar el resto. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className="absolute shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
          style={{
            left: PERCENT(rect.x),
            top: PERCENT(rect.y),
            width: PERCENT(rect.w),
            height: PERCENT(rect.h),
          }}
        />
      </div>
      <button
        type="button"
        data-crop-rect=""
        aria-label="Rectángulo de recorte"
        aria-describedby="crop-hint"
        className="absolute cursor-move border-2 border-white focus-visible:shadow-[0_0_0_3px_#000,0_0_0_5px_#fff] focus-visible:outline-none"
        style={{
          left: PERCENT(rect.x),
          top: PERCENT(rect.y),
          width: PERCENT(rect.w),
          height: PERCENT(rect.h),
        }}
        onPointerDown={(e) => start('move', e)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={(e) => onKey(e, 'move')}
      >
        <span aria-hidden="true" className={cx(GUIDE, 'inset-y-0 left-1/3 w-px')} />
        <span aria-hidden="true" className={cx(GUIDE, 'inset-y-0 left-2/3 w-px')} />
        <span aria-hidden="true" className={cx(GUIDE, 'inset-x-0 top-1/3 h-px')} />
        <span aria-hidden="true" className={cx(GUIDE, 'inset-x-0 top-2/3 h-px')} />
      </button>
      {CROP_HANDLES.map((handle) => {
        const [px, py] = HANDLE_POSITION[handle];
        return (
          <button
            key={handle}
            type="button"
            data-crop-handle={handle}
            aria-label={HANDLE_LABELS[handle]}
            aria-describedby="crop-hint"
            className={cx(
              HANDLE_CLASS,
              handle === 'n' || handle === 's'
                ? 'cursor-ns-resize'
                : handle === 'e' || handle === 'w'
                  ? 'cursor-ew-resize'
                  : handle === 'nw' || handle === 'se'
                    ? 'cursor-nwse-resize'
                    : 'cursor-nesw-resize',
            )}
            style={{
              left: PERCENT(rect.x + rect.w * px),
              top: PERCENT(rect.y + rect.h * py),
            }}
            onPointerDown={(e) => start(handle, e)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onKeyDown={(e) => onKey(e, handle)}
          />
        );
      })}
    </div>
  );
}

// ── Editor ─────────────────────────────────────────────────────────────────────────────────────

const DISABLED = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-50';
const SEPARATOR = <span aria-hidden="true" className="mx-1 h-6 w-px bg-border" />;

export function Editor({ item, saved, dims, src, onCancel, onSaved }: EditorProps) {
  const [state, dispatch] = useReducer(reducer, saved, initialState);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstControl = useRef<HTMLButtonElement>(null);
  const [stageRef, stage] = useElementSize();

  // Al entrar, el foco pasa a la primera herramienta (la proporción del recorte).
  useEffect(() => {
    firstControl.current?.focus();
  }, []);

  const view = useMemo(() => foldEdits(state.present), [state.present]);
  const frame: Size = useMemo(() => {
    const oriented = view.q % 2 === 1 ? { w: dims.h, h: dims.w } : dims;
    return { w: view.crop.w * oriented.w, h: view.crop.h * oriented.h };
  }, [view, dims]);
  const limits = useMemo(() => cropLimits(view.crop), [view.crop]);
  const ratio = CROP_RATIOS.find((r) => r.id === state.ratioId) ?? CROP_RATIOS[0];
  const k = ratioK(ratio?.ratio ?? null, frame);

  const pending = !isFullCrop(state.rect);
  const withPending = (): EditOp[] =>
    pending ? [...state.present, { t: 'crop', ...state.rect }] : state.present;
  const dirty = !sameOps(withPending(), saved);
  const busy = saving;

  const push = (ops: EditOp[], message: string): void => {
    setError(null);
    dispatch({ type: 'push', ops });
    announce(message);
  };
  const guarded = (fn: () => void) => (): void => {
    if (!busy) fn();
  };

  const apply = guarded(() => {
    if (pending) push(withPending(), 'Recorte aplicado');
  });
  const rotate = (q: 1 | 3, message: string): (() => void) =>
    guarded(() => push([...withPending(), { t: 'rotate', q }], message));
  const flip = (t: 'flipH' | 'flipV', message: string): (() => void) =>
    guarded(() => push([...withPending(), { t }], message));
  const revert = guarded(() => push([], 'Se restableció el original'));
  const undo = guarded(() => {
    if (state.past.length > 0) dispatch({ type: 'undo' });
  });
  const redo = guarded(() => {
    if (state.future.length > 0) dispatch({ type: 'redo' });
  });

  const save = guarded(() => {
    if (!dirty) return;
    setSaving(true);
    setError(null);
    const ops = opsForSave(withPending());
    void invoke('edits:save', { mediaId: item.id, ops }).then((res) => {
      setSaving(false);
      if (!res.ok) {
        const message = errorMessage(res.error);
        setError(message);
        announce(message, 'assertive');
        return;
      }
      onSaved(res.data);
    });
  });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (isCtrlKey(e.nativeEvent, 'z')) {
      e.preventDefault();
      undo();
    } else if (
      isCtrlKey(e.nativeEvent, 'y') ||
      (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'z')
    ) {
      e.preventDefault();
      redo();
    }
  };

  const changeRatio = (id: string): void => {
    const next = CROP_RATIOS.find((r) => r.id === id);
    if (!next) return;
    const nextK = ratioK(next.ratio, frame);
    dispatch({
      type: 'ratio',
      ratioId: id,
      rect: nextK === null ? state.rect : fitRatio(state.rect, nextK, limits),
    });
  };

  // Caja de la foto editada, ajustada al espacio disponible (con un margen para las asas).
  const aspect = editedAspect(view, dims.w, dims.h);
  const avail: Size = stage
    ? { w: Math.max(0, stage.w - 48), h: Math.max(0, stage.h - 48) }
    : { w: 0, h: 0 };
  const box = fitContain(aspect, avail);
  const cropPx = {
    w: Math.round(state.rect.w * frame.w),
    h: Math.round(state.rect.h * frame.h),
  };

  return (
    // Los atajos Ctrl+Z / Ctrl+Y se escuchan en todo el editor; los controles son los hijos.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div data-editor="" className="flex h-full min-h-0 flex-col text-text" onKeyDown={onKeyDown}>
      <div
        role="toolbar"
        aria-label="Herramientas de edición"
        className="flex flex-wrap items-center gap-2 border-b border-border bg-bg-elevated px-3 py-2"
      >
        <Select.Root value={state.ratioId} onValueChange={changeRatio} disabled={busy}>
          <Select.Trigger
            ref={firstControl}
            aria-label="Proporción del recorte"
            className="inline-flex h-9 items-center gap-2 rounded-md border border-border-strong bg-surface px-3 text-sm text-text hover:bg-surface-hover"
          >
            <Crop aria-hidden="true" size={16} strokeWidth={1.75} />
            <Select.Value />
            <Select.Icon>
              <ChevronDown aria-hidden="true" size={14} />
            </Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content
              position="popper"
              sideOffset={4}
              className="z-50 min-w-40 rounded-md border border-border bg-bg-elevated p-1 text-text shadow-md"
            >
              <Select.Viewport>
                {CROP_RATIOS.map((r) => (
                  <Select.Item
                    key={r.id}
                    value={r.id}
                    className="flex h-9 cursor-default items-center gap-2 rounded-sm px-3 text-sm outline-none data-highlighted:bg-surface-hover data-highlighted:outline-2 data-highlighted:outline-focus-ring data-[state=checked]:font-semibold"
                  >
                    <Select.ItemText>{r.label}</Select.ItemText>
                    <Select.ItemIndicator>
                      <Check aria-hidden="true" size={14} />
                    </Select.ItemIndicator>
                  </Select.Item>
                ))}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>
        <Button
          size="sm"
          aria-disabled={!pending || busy || undefined}
          className={DISABLED}
          onClick={apply}
        >
          Aplicar recorte
        </Button>
        {SEPARATOR}
        <IconButton
          label="Girar a la izquierda"
          icon={RotateCcw}
          aria-disabled={busy || undefined}
          className={DISABLED}
          onClick={rotate(3, 'Girada a la izquierda')}
        />
        <IconButton
          label="Girar a la derecha"
          icon={RotateCw}
          aria-disabled={busy || undefined}
          className={DISABLED}
          onClick={rotate(1, 'Girada a la derecha')}
        />
        <IconButton
          label="Voltear horizontalmente"
          icon={FlipHorizontal2}
          aria-disabled={busy || undefined}
          className={DISABLED}
          onClick={flip('flipH', 'Volteada horizontalmente')}
        />
        <IconButton
          label="Voltear verticalmente"
          icon={FlipVertical2}
          aria-disabled={busy || undefined}
          className={DISABLED}
          onClick={flip('flipV', 'Volteada verticalmente')}
        />
        {SEPARATOR}
        <IconButton
          label="Deshacer (Ctrl+Z)"
          icon={Undo2}
          aria-disabled={busy || state.past.length === 0 || undefined}
          className={DISABLED}
          onClick={undo}
        />
        <IconButton
          label="Rehacer (Ctrl+Y)"
          icon={Redo2}
          aria-disabled={busy || state.future.length === 0 || undefined}
          className={DISABLED}
          onClick={redo}
        />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            aria-disabled={busy || (state.present.length === 0 && !pending) || undefined}
            className={DISABLED}
            onClick={revert}
          >
            Restablecer original
          </Button>
          <Button
            size="sm"
            aria-disabled={busy || undefined}
            className={DISABLED}
            onClick={() => !busy && onCancel()}
          >
            Cancelar
          </Button>
          <Button
            size="sm"
            variant="primary"
            aria-disabled={busy || !dirty || undefined}
            aria-busy={busy || undefined}
            className={DISABLED}
            onClick={save}
          >
            {busy ? 'Guardando…' : 'Guardar'}
          </Button>
        </div>
      </div>
      {error ? (
        <p
          role="alert"
          className="border-b border-border bg-bg-elevated px-4 py-2 text-sm text-danger-text"
        >
          {error}
        </p>
      ) : null}
      <div ref={stageRef} className="relative min-h-0 flex-1">
        {stage && box.w > 0 ? (
          <div
            data-editor-box=""
            className="absolute"
            style={{
              left: (stage.w - box.w) / 2,
              top: (stage.h - box.h) / 2,
              width: box.w,
              height: box.h,
            }}
          >
            <EditedImage src={src} state={view} width={box.w} height={box.h} testId="editor" />
            <CropOverlay
              rect={state.rect}
              box={box}
              limits={limits}
              k={k}
              onRect={(rect) => dispatch({ type: 'rect', rect })}
              onApply={apply}
            />
          </div>
        ) : null}
        <p
          id="crop-hint"
          className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-md bg-bg-elevated px-3 py-1 text-xs text-text-muted"
        >
          {pending ? `Recorte: ${cropPx.w} × ${cropPx.h} px. ` : ''}
          Flechas: mover o redimensionar un 1 % (Mayús, un 10 %). Intro aplica el recorte.
        </p>
      </div>
    </div>
  );
}
