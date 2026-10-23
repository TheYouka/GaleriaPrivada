// Barra de título propia de la ventana sin marco (docs/DESIGN.md §15.6). Variantes de F1: `fluent`
// (título a la izquierda; Minimizar, Maximizar/Restaurar y Cerrar a la derecha, 46×32 px) y `xmb`
// (barra translúcida con los botones a la derecha); el resto llega en F6. Zona de arrastre con
// -webkit-app-region: drag (el doble clic maximiza, lo hace el SO). Va al final del DOM, así que sus
// botones quedan al final del orden de Tab. El candado aparece con la bóveda abierta.
import { Copy, Lock, Minus, Square, X, type LucideIcon } from 'lucide-react';
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
}: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  close?: boolean;
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
      )}
    >
      <Icon aria-hidden="true" size={close ? 16 : 14} strokeWidth={1.5} />
    </button>
  );
}

export function Titlebar({ variant, onLock, className }: TitlebarProps) {
  const maximized = useThemeStore((s) => s.windowState.maximized);
  return (
    <header
      className={cx(
        'relative z-20 flex h-8 items-stretch [-webkit-app-region:drag]',
        variant === 'xmb' ? 'bg-black/30' : 'bg-transparent',
        className,
      )}
      data-titlebar={variant}
    >
      <div className="flex items-center px-4 text-xs text-text">Galería</div>
      <div className="flex-1" />
      <div className="flex [-webkit-app-region:no-drag]">
        {onLock ? <WindowButton label="Bloquear (Ctrl+L)" icon={Lock} onClick={onLock} /> : null}
        <WindowButton
          label="Minimizar"
          icon={Minus}
          onClick={() => void invoke('window:minimize')}
        />
        <WindowButton
          label={maximized ? 'Restaurar' : 'Maximizar'}
          icon={maximized ? Copy : Square}
          onClick={() => void invoke('window:toggleMaximize')}
        />
        <WindowButton label="Cerrar" icon={X} close onClick={() => void invoke('window:close')} />
      </div>
    </header>
  );
}
