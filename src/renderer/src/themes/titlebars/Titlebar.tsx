// Barra de título propia de la ventana sin marco (docs/DESIGN.md §15.6). Variantes: `fluent` (título a
// la izquierda; Minimizar, Maximizar/Restaurar y Cerrar a la derecha, 46×32 px), `xmb` (barra
// translúcida con los botones a la derecha), `xbox` (barra mínima, botones planos a la derecha),
// `traffic-lights` (tres círculos de 12 px a la izquierda con iconos al pasar el ratón o enfocar) y
// `cine` (franja transparente sobre el degradado, botones redondeados). Zona de arrastre con
// -webkit-app-region: drag (el doble clic maximiza, lo hace el SO). Va al final del DOM, así que sus
// botones quedan al final del orden de Tab. El candado aparece con la bóveda abierta, en todas.
import { Copy, Lock, Maximize2, Minimize2, Minus, Square, X, type LucideIcon } from 'lucide-react';
import { cx } from '../../lib/cx';
import { invoke } from '../../lib/ipc';
import { useThemeStore } from '../../stores/theme-store';
import type { TitlebarKind } from '../theme-types';

export interface TitlebarProps {
  variant: TitlebarKind;
  /** Muestra el candado (bóveda abierta). */
  onLock?: () => void;
  className?: string;
}

function WindowButton({
  label,
  icon: Icon,
  onClick,
  close = false,
  className,
}: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  close?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cx(
        'inline-flex h-8 w-[46px] items-center justify-center text-text focus-visible:-outline-offset-2',
        close ? 'g-titlebar-close' : 'hover:bg-surface-hover active:bg-surface-pressed',
        className,
      )}
    >
      <Icon aria-hidden="true" size={close ? 16 : 14} strokeWidth={1.5} />
    </button>
  );
}

/** Semáforo del tema Cristal: círculo de 12 px dentro de un botón de 20 px (el anillo lo rodea). */
function TrafficLight({
  label,
  icon: Icon,
  color,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  color: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="g-traffic-light inline-flex size-5 items-center justify-center rounded-full"
    >
      <span
        aria-hidden="true"
        className="flex size-3 items-center justify-center rounded-full text-black/60"
        style={{ backgroundColor: color }}
      >
        <Icon className="g-traffic-icon" size={8} strokeWidth={3} />
      </span>
    </button>
  );
}

const LIGHTS = { close: '#EE6A5F', minimize: '#F5BE4F', maximize: '#62C554' } as const;

export function Titlebar({ variant, onLock, className }: TitlebarProps) {
  const maximized = useThemeStore((s) => s.windowState.maximized);
  const minimize = (): void => void invoke('window:minimize');
  const toggleMaximize = (): void => void invoke('window:toggleMaximize');
  const close = (): void => void invoke('window:close');
  const lock = onLock ? (
    <WindowButton
      label="Bloquear (Ctrl+L)"
      icon={Lock}
      onClick={onLock}
      className={variant === 'cine' ? 'g-cine-button' : undefined}
    />
  ) : null;
  const trafficLights = variant === 'traffic-lights';
  return (
    <header
      className={cx(
        'relative z-20 flex h-8 items-stretch [-webkit-app-region:drag]',
        variant === 'xmb' ? 'bg-black/30' : 'bg-transparent',
        className,
      )}
      data-titlebar={variant}
    >
      {trafficLights ? (
        <div className="g-traffic-lights flex items-center gap-2 pl-3 [-webkit-app-region:no-drag]">
          <TrafficLight label="Cerrar" icon={X} color={LIGHTS.close} onClick={close} />
          <TrafficLight label="Minimizar" icon={Minus} color={LIGHTS.minimize} onClick={minimize} />
          <TrafficLight
            label={maximized ? 'Restaurar' : 'Maximizar'}
            icon={maximized ? Minimize2 : Maximize2}
            color={LIGHTS.maximize}
            onClick={toggleMaximize}
          />
        </div>
      ) : null}
      <div
        className={cx(
          'flex items-center text-xs text-text',
          trafficLights ? 'flex-1 justify-center px-4' : 'px-4',
          variant === 'xbox' && 'font-semibold tracking-widest uppercase',
          variant === 'cine' && 'font-bold tracking-wide',
        )}
      >
        Galería
      </div>
      {trafficLights ? null : <div className="flex-1" />}
      <div className="flex [-webkit-app-region:no-drag]">
        {lock}
        {trafficLights ? null : (
          <>
            <WindowButton
              label="Minimizar"
              icon={Minus}
              onClick={minimize}
              className={variant === 'cine' ? 'g-cine-button' : undefined}
            />
            <WindowButton
              label={maximized ? 'Restaurar' : 'Maximizar'}
              icon={maximized ? Copy : Square}
              onClick={toggleMaximize}
              className={variant === 'cine' ? 'g-cine-button' : undefined}
            />
            <WindowButton
              label="Cerrar"
              icon={X}
              close
              onClick={close}
              className={variant === 'cine' ? 'g-cine-button' : undefined}
            />
          </>
        )}
      </div>
    </header>
  );
}
