// Fondo `wallpaper` del tema Cristal (docs/DESIGN.md §15.2 y §15.7): degradado SVG propio, uno por
// esquema, que solo pinta entre los colores de `MACOS_WALLPAPER`. Es una imagen estática (coste 0:
// `paused` no cambia nada). El desenfoque de cristal (`backdrop-filter`) lo llevan solo la barra
// lateral y la de herramientas del shell, no este fondo.
import darkUrl from '../../assets/wallpapers/cristal-oscuro.svg';
import lightUrl from '../../assets/wallpapers/cristal-claro.svg';
import { useTheme } from '../use-theme';

export function WallpaperBackground() {
  const { scheme } = useTheme();
  return (
    <div
      className="absolute inset-0 bg-bg bg-cover bg-center"
      style={{ backgroundImage: `url(${scheme === 'dark' ? darkUrl : lightUrl})` }}
      data-wallpaper={scheme}
    />
  );
}
