// Tamaño (px) de un elemento, medido antes de pintar y seguido con ResizeObserver. Lo usan el visor
// y el editor para colocar la caja "contain" de la foto. Se pasa como `ref` (de callback) porque el
// elemento puede montarse después del componente (los diálogos de Radix se pintan en un portal).
import { useLayoutEffect, useState } from 'react';
import type { Size } from './zoom-math';

export function useElementSize(): [(el: HTMLElement | null) => void, Size | null] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState<Size | null>(null);
  useLayoutEffect(() => {
    if (!element) return;
    const measure = (): void => {
      const rect = element.getBoundingClientRect();
      setSize((prev) =>
        prev && prev.w === rect.width && prev.h === rect.height
          ? prev
          : { w: rect.width, h: rect.height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, size];
}
