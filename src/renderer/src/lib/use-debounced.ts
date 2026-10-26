// Valor con retraso: se actualiza `delayMs` después del último cambio (búsqueda de la galería, §14.6).
import { useEffect, useState } from 'react';

export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
