// Fondo `solid` del tema Mosaico (docs/DESIGN.md §15.2): `bg` con una viñeta que solo pinta entre los
// dos extremos de `XBOX_VIGNETTE` (centro más claro, borde más oscuro). CSS estático, coste 0.
import { XBOX_VIGNETTE } from '../tokens/xbox';

export function SolidBackground() {
  return (
    <div
      className="absolute inset-0 bg-bg"
      style={{
        backgroundImage: `radial-gradient(ellipse 85% 85% at 50% 45%, ${XBOX_VIGNETTE.center} 0%, ${XBOX_VIGNETTE.edge} 100%)`,
      }}
    />
  );
}
