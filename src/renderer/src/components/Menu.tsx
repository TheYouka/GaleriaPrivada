// Menú desplegable de opciones excluyentes sobre Radix DropdownMenu (flechas, Esc y devolución del
// foco al botón que lo abrió).
import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';

export interface MenuOption {
  value: string;
  label: string;
}

export interface MenuProps {
  /** El botón que abre el menú (se usa con asChild). */
  trigger: ReactNode;
  label: string;
  options: readonly MenuOption[];
  value: string;
  onValueChange(value: string): void;
  /** Se abre o se cierra (el reproductor mantiene visibles sus controles mientras está abierto). */
  onOpenChange?(open: boolean): void;
}

export function Menu({ trigger, label, options, value, onValueChange, onOpenChange }: MenuProps) {
  return (
    <DropdownMenu.Root onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-48 rounded-md border border-border bg-bg-elevated p-1 text-text shadow-md"
        >
          <DropdownMenu.Label className="px-3 py-1.5 text-xs text-text-muted">
            {label}
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={value} onValueChange={onValueChange}>
            {options.map((o) => (
              <DropdownMenu.RadioItem
                key={o.value}
                value={o.value}
                className="relative flex h-9 cursor-default items-center rounded-sm pr-3 pl-8 text-sm outline-none data-highlighted:bg-surface-hover data-highlighted:outline-2 data-highlighted:outline-focus-ring"
              >
                <DropdownMenu.ItemIndicator className="absolute left-2 inline-flex">
                  <Check aria-hidden="true" size={16} />
                </DropdownMenu.ItemIndicator>
                {o.label}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
