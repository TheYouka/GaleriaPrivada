// Mosaico pulsable (por ejemplo, "Añadir perfil"): un <button> con el radio de mosaico del tema.
import type { ComponentPropsWithRef } from 'react';
import { cx } from '../lib/cx';

export function Tile({ className, type = 'button', ...rest }: ComponentPropsWithRef<'button'>) {
  return (
    <button
      type={type}
      className={cx(
        'flex flex-col items-center justify-center gap-2 rounded-tile border border-border-strong bg-surface-alpha text-text transition-colors hover:bg-surface-hover',
        className,
      )}
      {...rest}
    />
  );
}
