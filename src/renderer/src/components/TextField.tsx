// Campo de texto con etiqueta, ayuda y error (docs/DESIGN.md §14.1: aria-invalid + aria-describedby
// con el mensaje).
import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';
import { cx } from '../lib/cx';

export interface TextFieldProps extends Omit<ComponentPropsWithRef<'input'>, 'id'> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  /** Elemento al final del campo (por ejemplo, "Mostrar"). */
  trailing?: ReactNode;
  inputClassName?: string;
}

export const FIELD_INPUT_CLASS =
  'h-10 w-full min-w-0 rounded-md border border-border-strong bg-surface px-3 text-base text-text placeholder:text-text-muted aria-invalid:border-danger-text read-only:opacity-80';

export function TextField({
  label,
  hint,
  error,
  trailing,
  className,
  inputClassName,
  ...input
}: TextFieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cx(FIELD_INPUT_CLASS, inputClassName)}
          {...input}
        />
        {trailing}
      </div>
      {error ? (
        <p id={errorId} className="text-sm text-danger-text">
          {error}
        </p>
      ) : null}
      {hint ? (
        <p id={hintId} className="text-xs text-text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
