// Ayudantes de los recorridos solo con teclado (docs/PLAN.md 6.5): ninguno usa el ratón.
import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Pulsa Tab hasta que `target` tiene el foco (como lo haría una persona). El orden de Tab cambia de
 * un shell a otro (barra lateral, pivote, XMB, barra superior), así que la prueba no fija cuántas
 * pulsaciones hacen falta: solo que se llega con el teclado en un número razonable.
 */
export async function tabTo(page: Page, target: Locator, max = 60): Promise<number> {
  for (let presses = 0; presses <= max; presses += 1) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) {
      return presses;
    }
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab no llegó al elemento en ${max} pulsaciones`);
}

/** Escribe `text` en el campo con el foco y comprueba el valor (la escritura de una persona). */
export async function typeInto(page: Page, field: Locator, text: string): Promise<void> {
  await tabTo(page, field);
  await page.keyboard.press('Control+a');
  await page.keyboard.type(text);
  await expect(field).toHaveValue(text);
}
