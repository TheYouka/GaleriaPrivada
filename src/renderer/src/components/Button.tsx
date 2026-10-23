// Botón base (docs/DESIGN.md §14.1). El foco visible lo dibuja la regla global :focus-visible de
// styles/base.css (anillo de --g-focus-ring de 2 px con 2 px de separación).
import type { ComponentPropsWithRef } from 'react';
import { cx } from '../lib/cx';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'danger-ghost';

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-pressed',
  secondary:
    'border border-border-strong bg-surface text-text hover:bg-surface-hover active:bg-surface-pressed',
  danger: 'bg-danger text-on-accent hover:brightness-110 active:brightness-95',
  ghost: 'text-text hover:bg-surface-hover active:bg-surface-pressed',
  'danger-ghost': 'text-danger-text hover:bg-surface-hover active:bg-surface-pressed',
};

const SIZES = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-9 px-4 text-sm',
  lg: 'h-11 px-6 text-base',
} as const;

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors duration-(--g-dur-fast) disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    />
  );
}
