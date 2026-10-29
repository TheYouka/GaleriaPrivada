// Pantalla de vídeo dual (docs/DESIGN.md §18.1): dos vídeos lado a lado (`object-fit: contain`, fondo
// negro y 2 px de separación) con «Controles sincronizados» (por defecto: una barra para los dos, con
// corrección de deriva, sync.ts) o independientes (una barra por lado). Suena el lado izquierdo y el
// derecho está silenciado. Se llega desde la barra de selección de la galería (exactamente 2 vídeos) o
// desde la navegación, donde cada lado empieza con «Elegir vídeo…».
//
// Teclado (los atajos de §16.6; en sincronizado actúan sobre los dos y en independiente sobre el lado
// con el foco): Espacio/K reproduce o pausa, J/L y Mayús+←/→ saltan 10 s, ↑/↓ el volumen del lado,
// M silencio, R bucle y Mayús+, / Mayús+. la velocidad. Ctrl+←/→ mueve el foco al lado izquierdo o
// derecho. Mientras suena algún vídeo se usa el MISMO contador que el reproductor y la presentación
// (`setPlayerPlaying` → session:setPlayback): pausa el bloqueo por inactividad, mantiene la pantalla
// encendida y detiene los fondos animados. Se suelta al pausar, al terminar, ante un error y al
// desmontar (bloquear o recargar lo suelta main).
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { Columns2, Replace, X } from 'lucide-react';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import { ScreenHeading } from '../../components/ScreenHeading';
import { Tooltip } from '../../components/Tooltip';
import { announce } from '../../lib/announce';
import { cx } from '../../lib/cx';
import {
  clearSide,
  openMergeDialog,
  refreshSides,
  requestPick,
  SIDE_LABEL,
  setLoop,
  setMuted,
  setSpeed,
  setSynced,
  setVolume,
  useDualStore,
} from '../../stores/dual-store';
import { setPlayerPlaying } from '../../stores/player-store';
import { useSessionStore } from '../../stores/session-store';
import { clamp, formatSpeed, SEEK_STEP_S, stepSpeed, stepVolume } from '../player/player-math';
import { SwitchField } from '../presentation/PresentationSettingsForm';
import { DualControls, type AudioControl } from './DualControls';
import { DualPane } from './DualPane';
import { applySpeed, INITIAL_PANE, videoAsSyncMedia, type PaneState } from './pane-state';
import { masterSide, SyncController, timelineDuration, type Side } from './sync';
import { VideoPicker } from './VideoPicker';

const SIDES = ['left', 'right'] as const;
const SIDE_TITLE: Readonly<Record<Side, string>> = { left: 'Izquierdo', right: 'Derecho' };

/** Teclas que un deslizador (volumen, progreso) o un menú resuelven por su cuenta. */
const OWN_ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

export function DualVideoScreen() {
  const dualId = useId();
  const left = useDualStore((s) => s.left);
  const right = useDualStore((s) => s.right);
  const synced = useDualStore((s) => s.synced);
  const volume = useDualStore((s) => s.volume);
  const muted = useDualStore((s) => s.muted);
  const speed = useDualStore((s) => s.speed);
  const loop = useDualStore((s) => s.loop);
  const epoch = useDualStore((s) => s.epoch);
  const merge = useDualStore((s) => s.merge);
  const ffmpegAvailable = useSessionStore((s) => s.appInfo?.ffmpegAvailable ?? false);

  const leftRef = useRef<HTMLVideoElement>(null);
  const rightRef = useRef<HTMLVideoElement>(null);
  const details = { left, right };
  const controllerRef = useRef<SyncController | null>(null);

  const [states, setStates] = useState<Record<Side, PaneState>>({
    left: INITIAL_PANE,
    right: INITIAL_PANE,
  });
  const [syncPlaying, setSyncPlaying] = useState(false);

  const leftId = left?.id ?? null;
  const rightId = right?.id ?? null;
  const leftMs = left?.durationMs ?? null;
  const rightMs = right?.durationMs ?? null;
  const both = leftId !== null && rightId !== null;
  const sync = synced && both;

  // El estado de un lado solo vale para el vídeo (y la época) al que pertenece.
  const keyOf = (side: Side): string => `${epoch[side]}:${details[side]?.id ?? ''}`;
  const paneOf = (side: Side): PaneState => {
    const s = states[side];
    return details[side] !== null && s.key === keyOf(side) ? s : INITIAL_PANE;
  };
  const patch = useCallback((side: Side, key: string, change: Partial<PaneState>) => {
    setStates((s) => ({
      ...s,
      [side]: s[side].key === key ? { ...s[side], ...change } : { ...INITIAL_PANE, key, ...change },
    }));
  }, []);

  const L = paneOf('left');
  const R = paneOf('right');
  const master: Side = masterSide(L.duration, R.duration);
  const total = timelineDuration(L.duration, R.duration);
  const syncTime = master === 'left' ? L.time : R.time;

  // Al volver a la pantalla, quita los lados cuyo vídeo se borró.
  useEffect(() => {
    void refreshSides();
  }, []);

  // El controlador de sincronización existe solo en modo sincronizado con los dos vídeos. Empiezan
  // alineados y en pausa (al volver del modo independiente, también).
  useEffect(() => {
    if (!sync) return;
    const ctl = new SyncController(
      videoAsSyncMedia(leftRef, leftMs),
      videoAsSyncMedia(rightRef, rightMs),
      { onPlayingChange: setSyncPlaying },
    );
    const st = useDualStore.getState();
    ctl.setRate(st.speed.left);
    ctl.setLoop(st.loop.left);
    ctl.pause();
    ctl.seek(ctl.time);
    controllerRef.current = ctl;
    return () => {
      ctl.dispose();
      if (controllerRef.current === ctl) controllerRef.current = null;
      setSyncPlaying(false);
    };
    // La época cambia al elegir o quitar un vídeo, aunque sea el mismo: el <video> es otro elemento.
  }, [sync, leftId, rightId, leftMs, rightMs, epoch.left, epoch.right]);

  // Velocidad: con el controlador, la de la barra común; sin él, la de cada lado (con el tono conservado).
  useEffect(() => {
    if (sync) {
      controllerRef.current?.setRate(speed.left);
      applySpeed(leftRef.current, speed.left, false);
      applySpeed(rightRef.current, speed.left, false);
      return;
    }
    applySpeed(leftRef.current, speed.left, true);
    applySpeed(rightRef.current, speed.right, true);
  }, [sync, speed, leftId, rightId, epoch.left, epoch.right]);
  useEffect(() => {
    controllerRef.current?.setLoop(loop.left);
  }, [sync, loop.left]);

  // Reproducción activa → main (auto-bloqueo, powerSaveBlocker) y fondos animados. Un error del medio
  // no cambia `paused`, así que con un error ya no cuenta como reproducción.
  const playingLeft = L.playing && L.error === null;
  const playingRight = R.playing && R.error === null;
  const anyPlaying = sync
    ? syncPlaying && L.error === null && R.error === null
    : playingLeft || playingRight;
  useEffect(() => {
    setPlayerPlaying(dualId, anyPlaying);
  }, [dualId, anyPlaying]);
  useEffect(() => () => setPlayerPlaying(dualId, false), [dualId]);

  // Con el diálogo de fusión abierto, los vídeos se pausan.
  const mergeOpen = merge.name !== 'idle';
  useEffect(() => {
    if (!mergeOpen) return;
    controllerRef.current?.pause();
    leftRef.current?.pause();
    rightRef.current?.pause();
  }, [mergeOpen]);

  // ── Acciones ─────────────────────────────────────────────────────────────────────────────────

  const video = (side: Side): HTMLVideoElement | null =>
    side === 'left' ? leftRef.current : rightRef.current;

  const togglePlayOf = (side: Side): void => {
    const v = video(side);
    if (!v) return;
    if (v.paused || v.ended) void v.play().catch(() => undefined);
    else v.pause();
  };
  const seekToOf = (side: Side, t: number): void => {
    const v = video(side);
    if (!v) return;
    const limit = paneOf(side).duration;
    v.currentTime = limit > 0 ? clamp(t, 0, limit) : Math.max(0, t);
  };
  const seekByOf = (side: Side, delta: number): void => {
    const v = video(side);
    if (v) seekToOf(side, v.currentTime + delta);
  };

  const togglePlayAll = (): void => {
    if (sync) controllerRef.current?.toggle();
  };
  const toggleLoop = (side: Side | 'both'): void => {
    const next = !(side === 'both' ? loop.left : loop[side]);
    setLoop(side, next);
    announce(next ? 'Bucle activado' : 'Bucle desactivado');
  };
  const changeSpeed = (side: Side | 'both', next: number): void => {
    setSpeed(side, next);
    announce(`Velocidad ${formatSpeed(next)}`);
  };
  const changeVolume = (side: Side, next: number): void => {
    setVolume(side, next);
    if (next > 0 && muted[side]) setMuted(side, false);
    announce(`Volumen ${SIDE_LABEL[side]} ${Math.round(clamp(next, 0, 1) * 100)} %`);
  };
  const toggleMute = (side: Side): void => {
    setMuted(side, !muted[side]);
    announce(
      muted[side] ? `Sonido ${SIDE_LABEL[side]} activado` : `${SIDE_TITLE[side]} silenciado`,
    );
  };
  const audioOf = (side: Side): AudioControl => ({
    side,
    volume: volume[side],
    muted: muted[side],
    onVolume: (v) => changeVolume(side, v),
    onToggleMute: () => toggleMute(side),
  });

  const focusSide = (side: Side): void => {
    // Con el teclado el anillo de foco tiene que verse siempre (`focusVisible` no está en el tipo).
    document
      .querySelector<HTMLElement>(`[data-dual-side="${side}"]`)
      ?.focus({ focusVisible: true } as FocusOptions);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.altKey || e.metaKey || e.defaultPrevented) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('[role="dialog"]')) return; // el selector de vídeo es un portal de este árbol
    if (e.ctrlKey) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        focusSide(e.key === 'ArrowLeft' ? 'left' : 'right');
      }
      return;
    }
    // Los menús (velocidad) y los campos resuelven sus propias teclas.
    if (target?.closest('[role="menu"], input, textarea, select')) return;
    const onButton = target?.closest('button') != null;
    const onSlider = target?.closest('[role="slider"]') != null;
    if (onSlider && OWN_ARROWS.has(e.key)) return;
    const focused = target?.closest('[data-dual-side], [data-dual-controls]') ?? null;
    const focusedSide: Side | null =
      focused?.getAttribute('data-dual-side') === 'left' ||
      focused?.getAttribute('data-dual-controls') === 'left'
        ? 'left'
        : focused?.getAttribute('data-dual-side') === 'right' ||
            focused?.getAttribute('data-dual-controls') === 'right'
          ? 'right'
          : null;
    // En independiente, los atajos actúan sobre el lado con el foco; en sincronizado, sobre los dos.
    const side = sync ? (focusedSide ?? 'left') : focusedSide;
    if (side === null) return;
    const act = (fn: () => void): void => {
      e.preventDefault();
      fn();
    };
    const seek = (delta: number): void =>
      sync ? controllerRef.current?.seekBy(delta) : seekByOf(side, delta);
    switch (e.key) {
      case ' ':
        if (onButton) return; // el botón enfocado se activa solo
        act(() => (sync ? togglePlayAll() : togglePlayOf(side)));
        return;
      case 'k':
      case 'K':
        act(() => (sync ? togglePlayAll() : togglePlayOf(side)));
        return;
      case 'j':
      case 'J':
        act(() => seek(-SEEK_STEP_S));
        return;
      case 'l':
      case 'L':
        act(() => seek(SEEK_STEP_S));
        return;
      case 'ArrowLeft':
      case 'ArrowRight':
        if (!e.shiftKey) return;
        act(() => seek(e.key === 'ArrowRight' ? SEEK_STEP_S : -SEEK_STEP_S));
        return;
      case 'ArrowUp':
      case 'ArrowDown':
        act(() =>
          changeVolume(
            side,
            stepVolume(muted[side] ? 0 : volume[side], e.key === 'ArrowUp' ? 1 : -1),
          ),
        );
        return;
      case 'm':
      case 'M':
        act(() => toggleMute(side));
        return;
      case 'r':
      case 'R':
        act(() => toggleLoop(sync ? 'both' : side));
        return;
      default:
        break;
    }
    if (e.shiftKey && (e.code === 'Comma' || e.code === 'Period')) {
      act(() =>
        changeSpeed(
          sync ? 'both' : side,
          stepSpeed(sync ? speed.left : speed[side], e.code === 'Period' ? 1 : -1),
        ),
      );
    }
  };

  // ── Fusión ───────────────────────────────────────────────────────────────────────────────────

  const mergeBlocked: string | null = !ffmpegAvailable
    ? 'Falta el componente de vídeo de Galería.'
    : !both
      ? 'Elige un vídeo en cada lado.'
      : merge.name === 'running'
        ? 'Ya hay una fusión en curso.'
        : null;

  const sideHeader = (side: Side): ReactElement => {
    const detail = details[side];
    return (
      <div key={side} className="flex min-w-0 items-center gap-1.5 px-1" data-dual-header={side}>
        <span className="shrink-0 text-xs font-semibold tracking-wide text-text-muted uppercase">
          {SIDE_TITLE[side]}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-text" title={detail?.name}>
          {detail ? detail.name : 'Sin vídeo'}
        </span>
        {detail ? (
          <>
            <IconButton
              label={`Cambiar el vídeo ${SIDE_LABEL[side]}`}
              icon={Replace}
              iconSize={16}
              className="size-8"
              onClick={() => requestPick(side)}
            />
            <IconButton
              label={`Quitar el vídeo ${SIDE_LABEL[side]}`}
              icon={X}
              iconSize={16}
              className="size-8"
              onClick={() => clearSide(side)}
            />
          </>
        ) : null}
      </div>
    );
  };

  return (
    // Los atajos del vídeo dual se escuchan en toda la pantalla; los controles son los hijos.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      data-dual-screen=""
      data-dual-mode={sync ? 'sync' : 'independent'}
      data-dual-playing={anyPlaying ? 'true' : 'false'}
      className="flex h-full min-h-0 flex-col"
      onKeyDown={handleKeyDown}
    >
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 px-6 pt-3 pb-2">
        <ScreenHeading className="flex items-center gap-2 text-2xl text-text">
          <Columns2 aria-hidden="true" size={22} strokeWidth={1.75} />
          Vídeo dual
        </ScreenHeading>
        <div className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-2">
          <SwitchField
            label="Controles sincronizados"
            checked={synced}
            onCheckedChange={setSynced}
            testId="dual-sync-switch"
          />
          <Tooltip content={mergeBlocked ?? ''} enabled={mergeBlocked !== null}>
            <Button
              variant="primary"
              size="sm"
              aria-disabled={mergeBlocked !== null ? 'true' : undefined}
              className={cx(mergeBlocked !== null && 'cursor-not-allowed opacity-50')}
              onClick={() => {
                if (mergeBlocked === null) openMergeDialog();
              }}
            >
              Crear vídeo fusionado
            </Button>
          </Tooltip>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 px-6 pb-4">
        <div className="grid grid-cols-2 gap-0.5">{SIDES.map((side) => sideHeader(side))}</div>
        <div
          data-dual-stage=""
          className="grid min-h-0 flex-1 grid-cols-2 gap-0.5 overflow-hidden rounded-lg border border-border bg-black"
        >
          {SIDES.map((side) => (
            <DualPane
              key={side}
              side={side}
              detail={details[side]}
              stateKey={keyOf(side)}
              videoRef={side === 'left' ? leftRef : rightRef}
              nativeLoop={!sync && loop[side]}
              volume={volume[side]}
              muted={muted[side]}
              state={paneOf(side)}
              onPatch={(key, change) => patch(side, key, change)}
              onWaiting={() => controllerRef.current?.handleWaiting(side)}
              onCanPlay={() => controllerRef.current?.handleCanPlay()}
              onEnded={() => controllerRef.current?.handleEnded(side)}
              onClickVideo={() => (sync ? togglePlayAll() : togglePlayOf(side))}
            />
          ))}
        </div>
        {sync ? (
          <DualControls
            scope={null}
            playing={syncPlaying}
            time={syncTime}
            duration={total}
            speed={speed.left}
            loop={loop.left}
            audio={[audioOf('left'), audioOf('right')]}
            onTogglePlay={togglePlayAll}
            onSeekBy={(d) => controllerRef.current?.seekBy(d)}
            onSeekTo={(t) => controllerRef.current?.seek(t)}
            onSpeed={(v) => changeSpeed('both', v)}
            onToggleLoop={() => toggleLoop('both')}
          />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {SIDES.map((side) =>
              details[side] ? (
                <DualControls
                  key={side}
                  scope={side}
                  playing={paneOf(side).playing}
                  time={paneOf(side).time}
                  duration={paneOf(side).duration}
                  speed={speed[side]}
                  loop={loop[side]}
                  audio={[audioOf(side)]}
                  onTogglePlay={() => togglePlayOf(side)}
                  onSeekBy={(d) => seekByOf(side, d)}
                  onSeekTo={(t) => seekToOf(side, t)}
                  onSpeed={(v) => changeSpeed(side, v)}
                  onToggleLoop={() => toggleLoop(side)}
                />
              ) : (
                <div key={side} aria-hidden="true" />
              ),
            )}
          </div>
        )}
      </div>
      <VideoPicker />
    </div>
  );
}
