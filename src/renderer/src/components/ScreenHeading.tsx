// <h1 tabIndex={-1}> de cada pantalla: recibe el foco en cada cambio de pantalla (§14.1).
import { useCallback, useRef, type ReactNode } from 'react';
import { cx } from '../lib/cx';
import { useScreenFocus } from '../lib/focus';

export interface ScreenHeadingProps {
  children: ReactNode;
  className?: string;
  /** false si la pantalla mueve el foco a otro sitio (por ejemplo, al avatar recién creado). */
  takeFocus?: boolean;
}

export function ScreenHeading({ children, className, takeFocus = true }: ScreenHeadingProps) {
  const ref = useRef<HTMLHeadingElement>(null);
  const resolve = useCallback(() => (takeFocus ? ref.current : null), [takeFocus]);
  useScreenFocus(resolve);
  return (
    <h1
      ref={ref}
      tabIndex={-1}
      className={cx('font-display font-semibold tracking-(--g-tracking-display)', className)}
    >
      {children}
    </h1>
  );
}
