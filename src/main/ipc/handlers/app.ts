import { app } from 'electron';
import { handle } from '../register';

export interface AppHandlerDeps {
  /** media/ffmpeg.ts: los dos binarios existen y son ejecutables (§19.4). */
  ffmpegAvailable(): boolean;
}

export function registerAppHandlers(deps: AppHandlerDeps): void {
  handle('app:getInfo', { requiresUnlock: false }, () => ({
    version: app.getVersion(),
    platform: process.platform === 'linux' ? 'linux' : 'win32',
    ffmpegAvailable: deps.ffmpegAvailable(),
  }));
}
