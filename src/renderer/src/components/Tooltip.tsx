// Tooltip sobre Radix Tooltip (docs/DESIGN.md §14.1). Se muestra con el foco del teclado y con el
// puntero, así que sirve para los botones deshabilitados con `aria-disabled` (que siguen siendo
// enfocables). Con `enabled = false` no se muestra nunca, pero el árbol es el mismo: el botón no se
// vuelve a montar (y no pierde el foco) cuando el tooltip aparece o desaparece.
import type { ReactElement, ReactNode } from 'react';
import { Tooltip as RTooltip } from 'radix-ui';

export interface TooltipProps {
  content: ReactNode;
  /** El elemento que lo dispara (un solo hijo que acepte ref y eventos). */
  children: ReactElement;
  enabled?: boolean;
}

export function Tooltip({ content, children, enabled = true }: TooltipProps) {
  return (
    <RTooltip.Provider delayDuration={250} skipDelayDuration={0}>
      <RTooltip.Root {...(enabled ? {} : { open: false })}>
        <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
        <RTooltip.Portal>
          <RTooltip.Content
            side="bottom"
            sideOffset={6}
            className="z-[70] max-w-72 rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-xs text-text shadow-md"
          >
            {content}
          </RTooltip.Content>
        </RTooltip.Portal>
      </RTooltip.Root>
    </RTooltip.Provider>
  );
}
