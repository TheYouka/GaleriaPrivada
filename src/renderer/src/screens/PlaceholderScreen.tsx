// Pantallas que llegan en fases posteriores (galería en F2, playlists en F4, vídeo dual en F5,
// Ayuda completa en F2): título y un texto, con el mismo foco al <h1> que el resto.
import type { ReactNode } from 'react';
import { ScreenHeading } from '../components/ScreenHeading';

export function PlaceholderScreen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 p-8">
      <ScreenHeading className="text-3xl text-text">{title}</ScreenHeading>
      <div className="max-w-prose text-text-muted">{children}</div>
    </div>
  );
}
