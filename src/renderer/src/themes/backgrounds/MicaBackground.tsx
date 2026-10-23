// Fondo `mica` del tema Clásico (docs/DESIGN.md §15.2 y §15.7): degradado radial estático del acento
// al 15 % sobre `bg` y ruido propio de 128 px al 3 %. CSS estático, coste 0: `paused` no cambia nada.
import noiseUrl from '../../assets/textures/noise.svg';

export function MicaBackground() {
  return (
    <div className="absolute inset-0 bg-bg">
      <div className="g-mica-glow absolute inset-0" />
      <div
        className="absolute inset-0 opacity-[0.03] mix-blend-overlay"
        style={{ backgroundImage: `url(${noiseUrl})`, backgroundSize: '128px 128px' }}
      />
    </div>
  );
}
