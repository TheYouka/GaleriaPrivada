// Teclado (docs/DESIGN.md §14.1): roving tabindex y atajos globales.

export type Orientation = 'horizontal' | 'vertical' | 'both';

/**
 * Índice nuevo para una tecla de navegación en una lista con roving tabindex, o null si la tecla no
 * navega. ←/→ (horizontal), ↑/↓ (vertical), Home/End a los extremos. Sin `wrap`, se para en los
 * bordes.
 */
export function rovingIndex(
  key: string,
  index: number,
  count: number,
  { orientation = 'both', wrap = false }: { orientation?: Orientation; wrap?: boolean } = {},
): number | null {
  if (count <= 0) return null;
  const prevKeys =
    orientation === 'vertical'
      ? ['ArrowUp']
      : orientation === 'horizontal'
        ? ['ArrowLeft']
        : ['ArrowLeft', 'ArrowUp'];
  const nextKeys =
    orientation === 'vertical'
      ? ['ArrowDown']
      : orientation === 'horizontal'
        ? ['ArrowRight']
        : ['ArrowRight', 'ArrowDown'];
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (prevKeys.includes(key)) {
    if (index > 0) return index - 1;
    return wrap ? count - 1 : 0;
  }
  if (nextKeys.includes(key)) {
    if (index < count - 1) return index + 1;
    return wrap ? 0 : count - 1;
  }
  return null;
}

/** El foco está en un campo de texto: los atajos globales no actúan (§14.1). */
export function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(
      target.type,
    );
  }
  return false;
}

/** Ctrl + tecla sin Alt ni Mayús (en Linux y Windows). */
export function isCtrlKey(event: KeyboardEvent, key: string): boolean {
  return (
    event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    !event.metaKey &&
    event.key.toLowerCase() === key
  );
}
