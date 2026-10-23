// Botón solo con icono: el nombre accesible es `label` (aria-label) y el icono es decorativo.
import type { ComponentPropsWithRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from '../lib/cx';

export interface IconButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  label: string;
  icon: LucideIcon;
  iconSize?: number;
}

export function IconButton({
  label,
  icon: Icon,
  iconSize = 18,
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex size-9 items-center justify-center rounded-md text-text transition-colors hover:bg-surface-hover active:bg-surface-pressed disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...rest}
    >
      <Icon aria-hidden="true" size={iconSize} strokeWidth={1.75} />
    </button>
  );
}
