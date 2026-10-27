// Visor de fotos y vídeos (docs/DESIGN.md §16.1): se abre con un clic o Intro sobre un mosaico y
// anima la foto desde él (FLIP: translate + scale + clip-path, 280 ms con ease-emphasized), cambia
// la miniatura por el original cuando `img.decode()` termina y se cierra con la animación inversa
// (o un fundido de 150 ms si el mosaico ya no está a la vista). Es un `role="dialog"` modal que
// recibe el foco al abrirse y lo devuelve al mosaico al cerrarse.
//
// La foto no depende del tema; solo la barra, los botones, el panel de información y el editor usan
// los tokens. La lista de navegación es el resultado actual de la galería (library-store).
//
// Teclado: ←/→ anterior y siguiente (con zoom, desplazan), Home/End, I información, E editor, Supr
// eliminar, F pantalla completa, +/−/0 zoom, Esc (sale del zoom, después cierra). En un vídeo, el
// reproductor (screens/player) se queda antes con Espacio/K, J/L, Mayús+←/→, ↑/↓, M, R y Mayús+, / Mayús+.
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { animate } from 'motion';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ChevronLeft,
  ChevronRight,
  Info,
  Maximize,
  Minimize,
  Pencil,
  Trash2,
  X,
} from 'lucide-react';
import { Dialog } from 'radix-ui';
import { foldEdits, identityState } from '@shared/edits';
import type { EditOp, Id, MediaDetail, MediaListItem } from '@shared/types';
import { IconButton } from '../../components/IconButton';
import { announce } from '../../lib/announce';
import { cx } from '../../lib/cx';
import { errorMessage } from '../../lib/errors-es';
import { invoke } from '../../lib/ipc';
import { toast } from '../../lib/toast';
import { mediaUrl, thumbUrl } from '../../lib/vault-url';
import { requestDelete, setItemThumbRev, useLibraryStore } from '../../stores/library-store';
import { useThemeStore } from '../../stores/theme-store';
import {
  finishViewerClose,
  setViewerCurrent,
  useViewerStore,
  type ViewerOrigin,
} from '../../stores/viewer-store';
import { useTheme } from '../../themes/use-theme';
import { VideoPlayer, type PlayerHandle } from '../player/VideoPlayer';
import { Editor } from './Editor';
import { EditedImage } from './EditedImage';
import { InfoPanel } from './InfoPanel';
import { clearViewerCache, loadDetail, preloadImages, primeDetail } from './media-cache';
import { useElementSize } from './use-element-size';
import { escapeAction } from './viewer-keys';
import { ZoomPan, type ZoomPanHandle } from './ZoomPan';
import {
  editedAspect,
  fitContain,
  FLIP_END_CLIP,
  flipStart,
  KEY_ZOOM_FACTOR,
  PAN_STEP,
  parseCubicBezier,
  rectsOverlap,
  type Size,
} from './zoom-math';

/** Duración de la animación de apertura y cierre (§16.1). */
const FLIP_SECONDS = 0.28;
const CROSSFADE_SECONDS = 0.15;
const REDUCED_SECONDS = 0.12;

type Ease = [number, number, number, number];
type Phase = 'opening' | 'open' | 'closing';
type Mode = 'view' | 'edit';

/** Cada botón del cromo del visor: el anillo de foco va por dentro para verse sobre el velo oscuro. */
const CHROME_BUTTON =
  'bg-bg-elevated/90 border border-border focus-visible:-outline-offset-2 aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

// ── Detalle (media:get) ────────────────────────────────────────────────────────────────────────

/** El detalle del medio: undefined mientras llega, null si falló. Conserva el anterior al refrescar. */
function useDetail(id: Id | null, version: number): MediaDetail | null | undefined {
  const [entry, setEntry] = useState<{ id: Id; detail: MediaDetail | null } | null>(null);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    void loadDetail(id).then((detail) => {
      if (alive) setEntry({ id, detail });
    });
    return () => {
      alive = false;
    };
  }, [id, version]);
  return entry && entry.id === id ? entry.detail : undefined;
}

// ── Capa de un medio ───────────────────────────────────────────────────────────────────────────

interface LayerProps {
  item: MediaListItem;
  stage: Size;
  detail: MediaDetail | null | undefined;
  /** Solo la primera capa: el mosaico del que sale (animación FLIP). */
  origin: ViewerOrigin | null;
  reduced: boolean;
  ease: Ease;
  zoomEnabled: boolean;
  fullscreen: boolean;
  registerZoom(handle: ZoomPanHandle | null): void;
  registerPlayer(handle: PlayerHandle | null): void;
  registerBox(el: HTMLDivElement | null): void;
  onOpened(): void;
  onScale(scale: number): void;
  onToggleFullscreen(): void;
}

function Layer({
  item,
  stage,
  detail,
  origin,
  reduced,
  ease,
  zoomEnabled,
  fullscreen,
  registerZoom,
  registerPlayer,
  registerBox,
  onOpened,
  onScale,
  onToggleFullscreen,
}: LayerProps) {
  const wrapper = useRef<HTMLDivElement>(null);
  const flipEl = useRef<HTMLDivElement | null>(null);
  // Proporción de partida: la de la miniatura del mosaico (primera capa) o la de la lista (la foto sin
  // editar); la miniatura de la propia capa la corrige al cargar.
  const [thumbAspect, setThumbAspect] = useState<number | null>(
    origin?.aspect ?? (item.width && item.height ? item.width / item.height : null),
  );
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const photo = item.kind === 'photo';
  // El póster (la miniatura) se ve hasta que el vídeo tiene su primer fotograma y vuelve a verse al
  // cerrar, que es cuando el reproductor se desmonta y la animación inversa necesita la caja.
  const posterVisible = photo ? !loaded : !(zoomEnabled && videoReady);

  const state = detail ? foldEdits(detail.edits) : identityState();
  // Proporción: la exacta con las ediciones y las dimensiones de la lista; antes, la de la miniatura.
  let aspect = thumbAspect;
  if (detail && item.width && item.height) aspect = editedAspect(state, item.width, item.height);
  const box = aspect ? fitContain(aspect, stage) : { w: 0, h: 0 };

  // Apertura FLIP de la primera capa (una vez, antes de pintar).
  const opened = useEffectEvent(onOpened);
  useLayoutEffect(() => {
    const el = flipEl.current;
    if (!origin) return;
    if (!el || origin.rect.width <= 0 || origin.rect.height <= 0) {
      opened();
      return;
    }
    let cancelled = false;
    let controls: { cancel(): void } | null = null;
    const done = (): void => {
      if (cancelled) return;
      // La animación deja el estado final inline (inset(0px)): se quita para que el zoom no se recorte.
      controls?.cancel();
      el.style.transform = 'none';
      el.style.clipPath = 'none';
      opened();
    };
    if (reduced) {
      const fade = animate(
        wrapper.current ?? el,
        { opacity: [0, 1] },
        { duration: REDUCED_SECONDS },
      );
      void fade.then(done);
      return () => {
        cancelled = true;
        fade.stop();
      };
    }
    const r = el.getBoundingClientRect();
    const f = flipStart(
      { left: r.left, top: r.top, width: r.width, height: r.height },
      origin.rect,
      origin.radius,
    );
    el.style.transform = `translate(${f.x}px, ${f.y}px) scale(${f.scale})`;
    el.style.clipPath = f.clipPath;
    const flip = animate(
      el,
      { x: [f.x, 0], y: [f.y, 0], scale: [f.scale, 1], clipPath: [f.clipPath, FLIP_END_CLIP] },
      { duration: FLIP_SECONDS, ease },
    );
    controls = flip;
    void flip.then(done);
    return () => {
      cancelled = true;
      flip.stop();
    };
    // Solo al montar: `origin` y `reduced` no cambian durante la apertura.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <motion.div
      ref={wrapper}
      data-viewer-layer={item.id}
      className="absolute inset-0"
      initial={origin ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduced ? REDUCED_SECONDS : CROSSFADE_SECONDS }}
    >
      {aspect === null ? (
        // Sonda: mide la miniatura para conocer la proporción antes de colocar la caja.
        <img
          alt=""
          src={thumbUrl(item.id, item.thumbRev)}
          className="size-px opacity-0"
          onLoad={(e) => {
            const img = e.currentTarget;
            if (img.naturalWidth > 0) setThumbAspect(img.naturalWidth / img.naturalHeight);
          }}
          onError={() => setThumbAspect(item.width && item.height ? item.width / item.height : 1)}
        />
      ) : (
        <ZoomPan
          viewport={stage}
          box={box}
          enabled={photo && zoomEnabled}
          ref={registerZoom}
          onScaleChange={onScale}
        >
          <div
            ref={(el) => {
              flipEl.current = el;
              registerBox(el);
            }}
            className="relative size-full"
            data-viewer-flip=""
            data-viewer-photo={photo ? 'true' : undefined}
          >
            {posterVisible ? (
              <img
                alt=""
                src={thumbUrl(item.id, item.thumbRev)}
                className="absolute inset-0 size-full object-contain"
                data-viewer-thumb=""
                onLoad={(e) => {
                  const img = e.currentTarget;
                  if (img.naturalWidth > 0) setThumbAspect(img.naturalWidth / img.naturalHeight);
                }}
              />
            ) : null}
            {photo && detail !== undefined ? (
              <EditedImage
                src={mediaUrl(item.id)}
                state={state}
                width={box.w}
                height={box.h}
                hidden={!loaded}
                testId="viewer"
                onLoad={(e) => {
                  // El original sustituye a la miniatura cuando termina de decodificarse (sin salto).
                  const img = e.currentTarget;
                  void img
                    .decode()
                    .catch(() => undefined)
                    .then(() => setLoaded(true));
                }}
                onError={() => setFailed(true)}
              />
            ) : null}
            {failed ? (
              <p
                role="alert"
                className="absolute inset-x-0 bottom-4 mx-auto w-fit rounded-md bg-bg-elevated px-3 py-2 text-sm text-danger-text"
              >
                {errorMessage({ code: 'INTEGRITY' })}
              </p>
            ) : null}
          </div>
        </ZoomPan>
      )}
      {!photo && zoomEnabled ? (
        <VideoPlayer
          ref={registerPlayer}
          id={item.id}
          durationMs={item.durationMs}
          fullscreen={fullscreen}
          onToggleFullscreen={onToggleFullscreen}
          onReady={() => setVideoReady(true)}
        />
      ) : null}
    </motion.div>
  );
}

// ── Diálogo ────────────────────────────────────────────────────────────────────────────────────

/** El mosaico del medio en la rejilla y si sigue a la vista (§16.1: cierre inverso o fundido). */
function findVisibleTile(id: Id): { rect: ViewerOrigin['rect']; radius: number } | null {
  const grid = document.querySelector<HTMLElement>('[data-gallery-grid]');
  const tile = grid?.querySelector<HTMLElement>(`[data-media-id="${id}"]`);
  if (!grid || !tile) return null;
  const t = tile.getBoundingClientRect();
  const g = grid.getBoundingClientRect();
  const rect = { left: t.left, top: t.top, width: t.width, height: t.height };
  if (rect.width <= 0 || rect.height <= 0) return null;
  if (!rectsOverlap(rect, { left: g.left, top: g.top, width: g.width, height: g.height })) {
    return null;
  }
  return { rect, radius: Number.parseFloat(getComputedStyle(tile).borderTopLeftRadius) || 0 };
}

function ViewerDialog() {
  const theme = useTheme();
  const reduced = useReducedMotion() ?? false;
  const items = useLibraryStore((s) => s.items);
  const currentId = useViewerStore((s) => s.currentId);
  const origin = useViewerStore((s) => s.origin);
  const fullscreen = useThemeStore((s) => s.windowState.fullscreen);

  const [phase, setPhase] = useState<Phase>('opening');
  const [mode, setMode] = useState<Mode>('view');
  const [infoOpen, setInfoOpen] = useState(false);
  const [scale, setScale] = useState(1);
  const [detailVersion, setDetailVersion] = useState(0);

  const contentRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const [stageRef, stage] = useElementSize();
  const zoomHandles = useRef(new Map<Id, ZoomPanHandle>());
  const playerHandles = useRef(new Map<Id, PlayerHandle>());
  const boxes = useRef(new Map<Id, HTMLDivElement>());
  const lastIndex = useRef(0);
  /** El editor está guardando: Esc no lo cierra (viewer-keys.ts). */
  const editorSaving = useRef(false);

  const ease = parseCubicBezier(theme.def.motion.ease.emphasized);
  const index = currentId ? items.findIndex((i) => i.id === currentId) : -1;
  const item: MediaListItem | null = index >= 0 ? (items[index] ?? null) : null;
  const detail = useDetail(item?.id ?? null, detailVersion);

  // Si el medio actual desaparece (Supr), el visor pasa al siguiente (o al anterior si era el último).
  useEffect(() => {
    if (index >= 0) {
      lastIndex.current = index;
      return;
    }
    if (!currentId) return;
    const next = items[Math.min(lastIndex.current, items.length - 1)];
    if (next) setViewerCurrent(next.id);
    else {
      clearViewerCache();
      finishViewerClose();
    }
  }, [index, currentId, items]);

  // Precarga de los vecinos ±1 (§16.1): `decode()` en fotos y solo el póster en vídeos.
  useEffect(() => {
    if (index < 0) return;
    const urls: string[] = [];
    for (const n of [items[index - 1], items[index + 1]]) {
      if (n) urls.push(n.kind === 'photo' ? mediaUrl(n.id) : thumbUrl(n.id, n.thumbRev));
    }
    preloadImages(urls);
  }, [index, items]);

  const currentZoom = (): ZoomPanHandle | undefined =>
    currentId ? zoomHandles.current.get(currentId) : undefined;

  // Velo de fondo (`--g-scrim`, que no depende del tema): de 0 a 1 al abrir.
  useLayoutEffect(() => {
    const scrim = scrimRef.current;
    if (!scrim) return;
    scrim.style.opacity = '0';
    const fade = animate(
      scrim,
      { opacity: [0, 1] },
      { duration: reduced ? REDUCED_SECONDS : FLIP_SECONDS, ease },
    );
    return () => fade.stop();
    // Solo al abrir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cierre: animación inversa hacia el mosaico si sigue a la vista; si no, un fundido.
  useEffect(() => {
    if (phase !== 'closing') return;
    let cancelled = false;
    const stops: Array<() => void> = [];
    const finish = (): void => {
      if (cancelled) return;
      clearViewerCache();
      finishViewerClose();
    };
    const box = currentId ? boxes.current.get(currentId) : undefined;
    const tile = currentId ? findVisibleTile(currentId) : null;
    const scrim = scrimRef.current;
    if (!reduced && box && tile && !currentZoom()?.isZoomed()) {
      const r = box.getBoundingClientRect();
      const f = flipStart(
        { left: r.left, top: r.top, width: r.width, height: r.height },
        tile.rect,
        tile.radius,
      );
      const flip = animate(
        box,
        { x: [0, f.x], y: [0, f.y], scale: [1, f.scale], clipPath: [FLIP_END_CLIP, f.clipPath] },
        { duration: FLIP_SECONDS, ease },
      );
      stops.push(() => flip.stop());
      if (scrim) {
        const fade = animate(scrim, { opacity: [1, 0] }, { duration: FLIP_SECONDS, ease });
        stops.push(() => fade.stop());
      }
      void flip.then(finish);
    } else {
      const fade = animate(
        contentRef.current ?? document.body,
        { opacity: [1, 0] },
        { duration: reduced ? REDUCED_SECONDS : CROSSFADE_SECONDS },
      );
      stops.push(() => fade.stop());
      void fade.then(finish);
    }
    return () => {
      cancelled = true;
      for (const stop of stops) stop();
    };
    // `phase` es lo único que dispara el cierre.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const requestClose = (): void => {
    if (phase !== 'open') return;
    setPhase('closing');
  };

  const go = (target: number): void => {
    const next = items[target];
    if (!next || target === index || mode !== 'view' || phase !== 'open') return;
    setViewerCurrent(next.id);
    announce(`${next.name}, ${target + 1} de ${items.length}`);
  };

  const toggleFullscreen = (): void => {
    void invoke('window:setFullScreen', { on: !fullscreen });
  };

  const startEdit = (): void => {
    if (!item || item.kind !== 'photo' || phase !== 'open') return;
    if (!detail || !item.width || !item.height) {
      toast('No se pueden leer las ediciones de esta foto.', 'error');
      return;
    }
    currentZoom()?.reset();
    setMode('edit');
  };

  const leaveEditor = (): void => {
    editorSaving.current = false;
    setMode('view');
    // El editor desaparece con el foco dentro: vuelve al visor.
    queueMicrotask(() => contentRef.current?.focus());
  };

  const onSaved = (res: { edits: EditOp[]; thumbRev: number }): void => {
    if (!item) return;
    if (detail) primeDetail({ ...detail, edits: res.edits });
    setItemThumbRev(item.id, res.thumbRev);
    setDetailVersion((v) => v + 1);
    announce('Cambios guardados');
    leaveEditor();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.defaultPrevented || mode !== 'view' || phase !== 'open') return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    // Los menús del reproductor (velocidad) van en un portal, pero sus teclas llegan hasta aquí.
    if (e.target instanceof Element && e.target.closest('[role="menu"]')) return;
    // Un vídeo: el reproductor se queda antes con sus atajos (§16.6).
    if (item?.kind === 'video' && playerHandles.current.get(item.id)?.handleKey(e)) {
      e.preventDefault();
      return;
    }
    const zoom = currentZoom();
    const zoomed = zoom?.isZoomed() ?? false;
    const arrow = (dx: number, dy: number, nav: () => void): void => {
      e.preventDefault();
      if (zoomed) zoom?.panByFraction(dx, dy);
      else nav();
    };
    switch (e.key) {
      case 'ArrowLeft':
        arrow(-PAN_STEP, 0, () => go(index - 1));
        break;
      case 'ArrowRight':
        arrow(PAN_STEP, 0, () => go(index + 1));
        break;
      case 'ArrowUp':
        if (zoomed) {
          e.preventDefault();
          zoom?.panByFraction(0, -PAN_STEP);
        }
        break;
      case 'ArrowDown':
        if (zoomed) {
          e.preventDefault();
          zoom?.panByFraction(0, PAN_STEP);
        }
        break;
      case 'Home':
        e.preventDefault();
        go(0);
        break;
      case 'End':
        e.preventDefault();
        go(items.length - 1);
        break;
      case 'i':
      case 'I':
        e.preventDefault();
        setInfoOpen((open) => !open);
        break;
      case 'e':
      case 'E':
        e.preventDefault();
        startEdit();
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        toggleFullscreen();
        break;
      case 'Delete':
        e.preventDefault();
        if (item) requestDelete([item.id]);
        break;
      case '+':
      case '=':
        e.preventDefault();
        zoom?.zoomBy(KEY_ZOOM_FACTOR);
        break;
      case '-':
      case '_':
        e.preventDefault();
        zoom?.zoomBy(1 / KEY_ZOOM_FACTOR);
        break;
      case '0':
        e.preventDefault();
        zoom?.reset();
        break;
    }
  };

  /**
   * Esc: cancela el editor (salvo mientras guarda, viewer-keys.ts); si hay zoom, vuelve a ajustar;
   * si no, cierra (§16.1).
   */
  const onEscape = (e: globalThis.KeyboardEvent): void => {
    e.preventDefault();
    const zoom = currentZoom();
    switch (
      escapeAction({
        phase,
        mode,
        editorSaving: editorSaving.current,
        zoomed: zoom?.isZoomed() ?? false,
      })
    ) {
      case 'leave-editor':
        leaveEditor();
        break;
      case 'reset-zoom':
        zoom?.reset();
        break;
      case 'close':
        requestClose();
        break;
      case 'none':
        break;
    }
  };

  const interactive = phase === 'open';
  const atStart = index <= 0;
  const atEnd = index >= items.length - 1;

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Content
          ref={contentRef}
          data-viewer=""
          data-viewer-state={phase}
          data-viewer-mode={mode}
          data-viewer-fullscreen={fullscreen ? 'true' : 'false'}
          aria-modal="true"
          aria-describedby={undefined}
          className={cx(
            'fixed inset-x-0 top-8 bottom-0 z-30 flex flex-col text-text outline-none',
            phase === 'closing' && 'pointer-events-none',
          )}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            contentRef.current?.focus();
          }}
          // El foco lo devuelve la rejilla al mosaico actual (closedTick), con scrollToIndex si hace falta.
          onCloseAutoFocus={(e) => e.preventDefault()}
          onEscapeKeyDown={onEscape}
          onKeyDown={onKeyDown}
        >
          <div ref={scrimRef} aria-hidden="true" className="absolute inset-0 bg-scrim" />
          <div
            // Con el editor encima, el visor queda oculto (visibility) e inerte: así la trampa de foco
            // de Radix salta sus controles al dar la vuelta con Tab y no se queda atascada en ellos.
            className={cx(
              'relative z-10 flex min-h-0 flex-1 flex-col',
              mode === 'edit' && 'invisible',
            )}
            inert={mode === 'edit' || phase === 'closing'}
          >
            <header className="flex items-center gap-2 border-b border-border bg-bg-elevated px-3 py-2">
              <IconButton
                label="Cerrar"
                icon={X}
                aria-disabled={!interactive || undefined}
                onClick={requestClose}
              />
              <Dialog.Title className="min-w-0 flex-1 truncate text-sm font-medium">
                {item?.name ?? 'Visor'}
              </Dialog.Title>
              {item ? (
                <span aria-hidden="true" className="text-sm text-text-muted">
                  {index + 1} / {items.length}
                </span>
              ) : null}
              <IconButton
                label="Información (I)"
                icon={Info}
                aria-pressed={infoOpen}
                onClick={() => setInfoOpen((open) => !open)}
                className={infoOpen ? 'bg-surface-hover' : undefined}
              />
              {item?.kind === 'photo' ? (
                <IconButton
                  label="Editar (E)"
                  icon={Pencil}
                  aria-disabled={!interactive || !detail || undefined}
                  onClick={startEdit}
                />
              ) : null}
              <IconButton
                label="Eliminar (Supr)"
                icon={Trash2}
                aria-disabled={!item || undefined}
                onClick={() => item && requestDelete([item.id])}
              />
              <IconButton
                label={fullscreen ? 'Salir de pantalla completa (F)' : 'Pantalla completa (F)'}
                icon={fullscreen ? Minimize : Maximize}
                onClick={toggleFullscreen}
              />
            </header>
            <div className="flex min-h-0 flex-1">
              <div
                ref={stageRef}
                data-viewer-stage=""
                className="relative min-w-0 flex-1 overflow-hidden"
              >
                <AnimatePresence initial={false}>
                  {item && stage ? (
                    <Layer
                      key={item.id}
                      item={item}
                      stage={stage}
                      detail={detail}
                      origin={origin}
                      reduced={reduced}
                      ease={ease}
                      zoomEnabled={interactive}
                      fullscreen={fullscreen}
                      onToggleFullscreen={toggleFullscreen}
                      registerZoom={(h) => {
                        if (h) zoomHandles.current.set(item.id, h);
                        else zoomHandles.current.delete(item.id);
                      }}
                      registerPlayer={(h) => {
                        if (h) playerHandles.current.set(item.id, h);
                        else playerHandles.current.delete(item.id);
                      }}
                      registerBox={(el) => {
                        if (el) boxes.current.set(item.id, el);
                        else boxes.current.delete(item.id);
                      }}
                      onOpened={() => setPhase('open')}
                      onScale={(s) => {
                        if (item.id === currentId) setScale(s);
                      }}
                    />
                  ) : null}
                </AnimatePresence>
                <IconButton
                  label="Anterior"
                  icon={ChevronLeft}
                  iconSize={22}
                  aria-disabled={atStart || !interactive || undefined}
                  onClick={() => go(index - 1)}
                  className={cx(
                    'absolute top-1/2 left-3 z-10 size-11 -translate-y-1/2 rounded-full',
                    CHROME_BUTTON,
                  )}
                />
                <IconButton
                  label="Siguiente"
                  icon={ChevronRight}
                  iconSize={22}
                  aria-disabled={atEnd || !interactive || undefined}
                  onClick={() => go(index + 1)}
                  className={cx(
                    'absolute top-1/2 right-3 z-10 size-11 -translate-y-1/2 rounded-full',
                    CHROME_BUTTON,
                  )}
                />
                {scale > 1 ? (
                  <span
                    aria-hidden="true"
                    data-viewer-zoom=""
                    className="absolute top-3 right-3 z-10 rounded-md border border-border bg-bg-elevated/90 px-2 py-1 text-sm text-text"
                  >
                    {Math.round(scale * 100)} %
                  </span>
                ) : null}
              </div>
              {infoOpen && item ? <InfoPanel item={item} detail={detail ?? null} /> : null}
            </div>
          </div>
          {mode === 'edit' && item && detail && item.width && item.height ? (
            <div className="absolute inset-0 z-20 flex flex-col bg-scrim">
              <Editor
                item={item}
                saved={detail.edits}
                dims={{ w: item.width, h: item.height }}
                src={mediaUrl(item.id)}
                onCancel={leaveEditor}
                onSaved={onSaved}
                onSavingChange={(saving) => {
                  editorSaving.current = saving;
                }}
              />
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Viewer() {
  const open = useViewerStore((s) => s.open);
  return open ? <ViewerDialog /> : null;
}
