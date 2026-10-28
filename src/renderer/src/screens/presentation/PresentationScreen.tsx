// Pantalla de la presentación (docs/DESIGN.md §17; PLAN.md 4.6): una capa por encima del shell
// (`role="dialog"`, foco atrapado y devuelto al control que la inició). Pantalla completa con
// `window:setFullScreen` si `startFullscreen` (F alterna; al salir se restaura el estado anterior) o
// modo ventana bajo la barra de título del tema, sobre fondo negro. El contenido de la diapositiva
// no depende del tema; la barra de controles y el panel sí.
//
// Mientras se reproduce: `session:setPlayback { active: true }` por el mismo contador que el
// reproductor (`player-store`: pausa el temporizador de inactividad y mantiene la pantalla
// encendida, D12) y los fondos animados se pausan (`App.tsx`). Todo se suelta al pausar, al acabar,
// al salir, por un error y, desde main, al bloquear o recargar (`playback-release`).
//
// Movimiento: la raíz usa <MotionConfig reducedMotion="user"> (App.tsx) para el resto de la interfaz;
// aquí un <MotionConfig reducedMotion="never"> acotado a la presentación, porque la transición y las
// animaciones son una elección explícita del usuario (PLAN.md nota 191).
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { MotionConfig } from 'motion/react';
import { Dialog } from 'radix-ui';
import { Button } from '../../components/Button';
import { cx } from '../../lib/cx';
import { invoke, testHooksEnabled } from '../../lib/ipc';
import { toast } from '../../lib/toast';
import { setPlayerPlaying } from '../../stores/player-store';
import {
  changeActive,
  endPresentation,
  usePresentationStore,
  type ActivePresentation,
} from '../../stores/presentation-store';
import { useThemeStore } from '../../stores/theme-store';
import { PresentationControls } from './PresentationControls';
import { PresentationSettingsPanel } from './PresentationSettingsPanel';
import { presentationCommand, type FocusKind, type PresentationCommand } from './presentation-keys';
import { SlideStage } from './SlideStage';

/** Los controles se ocultan a los 3 s sin movimiento (§17.9). */
export const CONTROLS_HIDE_MS = 3000;
const PLAYBACK_ID = 'presentation';

/** Qué tiene el foco: un control que ya usa algunas teclas no debe disparar además la orden global. */
function focusKindOf(target: EventTarget | null): FocusKind {
  if (!(target instanceof Element)) return 'none';
  if (target.closest('[role="slider"]')) return 'slider';
  if (target instanceof HTMLInputElement) {
    return ['checkbox', 'radio', 'button'].includes(target.type) ? 'button' : 'text';
  }
  if (target instanceof HTMLTextAreaElement || target.closest('[contenteditable="true"]')) {
    return 'text';
  }
  if (target.closest('button, [role="switch"], [role="combobox"], [role="menuitem"]')) {
    return 'button';
  }
  return 'none';
}

/** «Fin de la presentación» (sin bucle, §17.6): Intro vuelve a empezar y Esc sale. */
function EndLayer({ onRestart }: { onRestart(): void }) {
  const restart = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    restart.current?.focus();
  }, []);
  return (
    <div
      data-presentation-end=""
      className="absolute inset-0 z-10 flex items-center justify-center"
    >
      <div className="flex flex-col items-center gap-4 rounded-lg border border-border bg-bg-elevated px-8 py-6 text-text shadow-lg">
        <h2 className="text-xl font-semibold">Fin de la presentación</h2>
        <div className="flex gap-3">
          <Button ref={restart} variant="primary" onClick={onRestart}>
            Volver a empezar
          </Button>
          <Button onClick={endPresentation}>Salir</Button>
        </div>
        <p className="text-xs text-text-muted">Intro vuelve a empezar. Esc sale.</p>
      </div>
    </div>
  );
}

function PresentationDialog({ active }: { active: ActivePresentation }) {
  const { runtime, settings, playlist } = active;
  const snap = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const fullscreen = useThemeStore((s) => s.windowState.fullscreen);

  const [recentActivity, setRecentActivity] = useState(true);
  const [focusWithin, setFocusWithin] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [audioMenuOpen, setAudioMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [navNote, setNavNote] = useState('');
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Arranque y parada. El destructor difiere la liberación un instante para que el doble montaje de
  // StrictMode (solo en desarrollo) no destruya el motor.
  useEffect(() => {
    runtime.start();
    return () => runtime.scheduleDispose();
  }, [runtime]);

  // Ajustes en vivo: el audio al momento; la transición y la duración desde la diapositiva siguiente.
  useEffect(() => {
    runtime.applySettings(settings);
  }, [runtime, settings]);

  // Pantalla completa al empezar (si se pidió) y restaurar el estado anterior al salir (§17.7).
  useEffect(() => {
    const before = useThemeStore.getState().windowState.fullscreen;
    if (active.settings.startFullscreen && !before) {
      void invoke('window:setFullScreen', { on: true });
    }
    return () => {
      if (useThemeStore.getState().windowState.fullscreen !== before) {
        void invoke('window:setFullScreen', { on: before });
      }
    };
    // Solo al montar: `startFullscreen` es del arranque.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Modo ventana: la barra de título sigue usable aunque el diálogo sea modal (themes.css).
  useEffect(() => {
    const html = document.documentElement;
    html.dataset.presentationMode = fullscreen ? 'fullscreen' : 'windowed';
    return () => {
      delete html.dataset.presentationMode;
    };
  }, [fullscreen]);

  // Reproducción activa → main (temporizador de inactividad, pantalla encendida) y fondos animados.
  useEffect(() => {
    setPlayerPlaying(PLAYBACK_ID, snap.playing);
  }, [snap.playing]);
  useEffect(() => () => setPlayerPlaying(PLAYBACK_ID, false), []);

  // Ganchos de prueba (§23.2): atributos y un getter de solo lectura, sin datos de la bóveda.
  useEffect(() => {
    if (!testHooksEnabled()) return;
    const update = (): void => {
      // El contenido de Radix se monta en un portal, un instante después de este efecto.
      const el = contentRef.current;
      const state = runtime.testState();
      if (!el || !state) return;
      el.setAttribute('data-slide-index', String(state.slideIndex ?? ''));
      el.setAttribute('data-phase', String(state.phase));
      el.setAttribute('data-music-gain', Number(state.musicGain ?? 0).toFixed(3));
    };
    update();
    const timer = setInterval(update, 100);
    Object.defineProperty(window, '__galeriaPresentation', {
      configurable: true,
      get: () => ({
        ...runtime.testState(),
        fullscreen: useThemeStore.getState().windowState.fullscreen,
      }),
    });
    return () => {
      clearInterval(timer);
      delete (window as unknown as Record<string, unknown>).__galeriaPresentation;
    };
  }, [runtime]);

  // Controles: visibles 3 s desde el último movimiento o tecla.
  const bump = (): void => {
    setRecentActivity(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setRecentActivity(false), CONTROLS_HIDE_MS);
  };
  useEffect(() => {
    hideTimer.current = setTimeout(() => setRecentActivity(false), CONTROLS_HIDE_MS);
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  const controlsVisible =
    recentActivity ||
    focusWithin ||
    hovering ||
    audioMenuOpen ||
    settingsOpen ||
    snap.paused ||
    snap.finished;

  const toggleFullscreen = (): void => {
    void invoke('window:setFullScreen', { on: !fullscreen });
  };

  const toggleMusic = (): void => {
    if (settings.trackIds.length === 0) {
      toast('No hay música elegida. Elige pistas antes de empezar.');
      return;
    }
    changeActive({ musicEnabled: !settings.musicEnabled });
  };

  const navigate = (dir: 'next' | 'prev'): void => {
    const target = dir === 'next' ? runtime.next() : runtime.prev();
    if (target !== null) setNavNote(`Diapositiva ${target + 1} de ${snap.total}`);
  };

  const closeSettings = (): void => {
    setSettingsOpen(false);
    queueMicrotask(() => contentRef.current?.focus());
  };

  const run = (cmd: PresentationCommand | null): boolean => {
    switch (cmd) {
      case 'toggle-pause':
        runtime.togglePause();
        return true;
      case 'next':
        navigate('next');
        return true;
      case 'prev':
        navigate('prev');
        return true;
      case 'toggle-fullscreen':
        toggleFullscreen();
        return true;
      case 'toggle-music':
        toggleMusic();
        return true;
      case 'close-settings':
        closeSettings();
        return true;
      case 'exit':
        endPresentation();
        return true;
      case 'restart':
        runtime.restart();
        return true;
      case null:
        return false;
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    bump();
    const cmd = presentationCommand(
      {
        key: e.key,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        repeat: e.repeat,
      },
      { settingsOpen, finished: snap.finished, focus: focusKindOf(e.target) },
    );
    if (cmd === null || cmd === 'exit' || cmd === 'close-settings') return;
    // Un menú de Radix (portal) resuelve sus propias teclas.
    if (e.target instanceof Element && e.target.closest('[role="menu"], [role="listbox"]')) return;
    if (run(cmd)) e.preventDefault();
  };

  return (
    <MotionConfig reducedMotion="never">
      <Dialog.Root open>
        <Dialog.Portal>
          <Dialog.Content
            ref={contentRef}
            data-presentation=""
            data-presentation-fullscreen={fullscreen ? 'true' : 'false'}
            data-paused={snap.paused ? 'true' : 'false'}
            data-controls-visible={controlsVisible ? 'true' : 'false'}
            aria-modal="true"
            aria-describedby={undefined}
            className={cx(
              'fixed z-30 flex flex-col overflow-hidden bg-black text-text outline-none',
              fullscreen ? 'inset-0' : 'inset-x-0 top-8 bottom-0',
              !controlsVisible && 'cursor-none',
            )}
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              contentRef.current?.focus();
            }}
            // El foco vuelve al control que la inició (si sigue en pantalla).
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              const back = active.returnFocus;
              if (back?.isConnected) back.focus({ preventScroll: true });
            }}
            // Esc cierra el panel de ajustes si está abierto y, si no, sale (§17.9).
            onEscapeKeyDown={(e) => {
              e.preventDefault();
              run(
                presentationCommand(
                  { key: 'Escape' },
                  { settingsOpen, finished: snap.finished, focus: 'none' },
                ),
              );
            }}
            onPointerDownOutside={(e) => e.preventDefault()}
            onInteractOutside={(e) => e.preventDefault()}
            onKeyDown={onKeyDown}
            onPointerMove={bump}
            onPointerDown={bump}
          >
            <Dialog.Title className="sr-only">Presentación</Dialog.Title>
            <p role="status" className="sr-only">
              {navNote}
            </p>
            <SlideStage runtime={runtime} />

            {snap.finished ? <EndLayer onRestart={() => runtime.restart()} /> : null}

            {settingsOpen ? (
              <PresentationSettingsPanel
                settings={settings}
                playlist={playlist}
                onChange={changeActive}
                onClose={closeSettings}
              />
            ) : null}

            <PresentationControls
              visible={controlsVisible}
              paused={snap.paused}
              position={(snap.index ?? 0) + 1}
              total={snap.total}
              fullscreen={fullscreen}
              settings={settings}
              settingsOpen={settingsOpen}
              onPrev={() => navigate('prev')}
              onTogglePause={() => runtime.togglePause()}
              onNext={() => navigate('next')}
              onToggleMusic={toggleMusic}
              onChangeSettings={changeActive}
              onToggleSettings={() => setSettingsOpen((open) => !open)}
              onToggleFullscreen={toggleFullscreen}
              onExit={endPresentation}
              onAudioMenuOpenChange={setAudioMenuOpen}
              onFocusWithinChange={setFocusWithin}
              onHoverChange={setHovering}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </MotionConfig>
  );
}

export function PresentationScreen() {
  const active = usePresentationStore((s) => s.active);
  return active ? <PresentationDialog key={active.seq} active={active} /> : null;
}
