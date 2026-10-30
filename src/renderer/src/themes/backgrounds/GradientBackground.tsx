// Fondo `gradient` del tema Cine (anexo §8, docs/DESIGN.md §15.7): degradado CSS estático, un
// resplandor índigo (`CINE_PALETTE.glow`) arriba sobre el casi negro (`CINE_PALETTE.bgTop`). Sin
// animación ni canvas: coste 0 y nada que pausar.
import { CINE_PALETTE } from '../tokens/cine';

export function GradientBackground() {
  return (
    <div
      className="absolute inset-0"
      style={{
        backgroundColor: CINE_PALETTE.bgTop,
        backgroundImage: `radial-gradient(ellipse 95% 62% at 50% 0%, ${CINE_PALETTE.glow} 0%, ${CINE_PALETTE.bgTop} 100%)`,
      }}
    />
  );
}
