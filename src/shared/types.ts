// Tipos compartidos (docs/DESIGN.md §10.1). El scaffold solo declara lo que usa app:getInfo y la
// API del preload; la Fase 1 completa el resto.

export type Id = string; // /^[0-9a-f]{32}$/

export type ThemeId = 'fotos' | 'xbox' | 'ps3' | 'macos' | 'album';

export interface AppInfo {
  version: string;
  platform: 'win32' | 'linux';
  ffmpegAvailable: boolean;
}
